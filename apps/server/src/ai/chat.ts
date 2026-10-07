import { AI_PROVIDERS } from '@bokydo/shared';
import type { OutboundResponse } from '../net/outbound.js';
import { authHeaders, type AiCallContext } from './adapters.js';
import {
  AiProviderError,
  eventJson,
  postWithRetry,
  readJson,
  roughTokens,
  sseEvents,
  type TransportOptions,
} from './transport.js';
import type { ReportedUsage } from './usage.js';

/** A tool the model may call. `parameters` is a JSON Schema whose root is an object. */
export interface AiTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** `input` is the parsed arguments, or undefined when the model produced invalid JSON. */
export interface AiToolCall {
  id: string;
  name: string;
  input: unknown;
}

export type AiMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AiToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface ChatRequest {
  system?: string;
  messages: AiMessage[];
  maxOutputTokens: number;
  /** Leave unset unless needed: several reasoning models refuse anything but the default. */
  temperature?: number;
  tools?: AiTool[];
  /** 'auto' by default; 'required' makes the model call some tool. */
  toolChoice?: 'auto' | 'required' | { name: string };
  /** Ask for a JSON reply matching this schema (root must be an object). Not with `tools`. */
  json?: { name: string; schema: Record<string, unknown> };
}

export type ChatStop = 'end' | 'length' | 'tool_use' | 'refused' | 'other';

export interface ChatResult {
  /** The reply; with `json`, the JSON text (still to be validated by the caller). */
  text: string;
  toolCalls: AiToolCall[];
  stop: ChatStop;
  usage: ReportedUsage;
}

export interface ChatOptions extends TransportOptions {
  /** Stream the reply: called with each piece of text as it arrives. */
  onText?: (delta: string) => void;
  /** Whole call, including reading a streamed reply (default 120 s). */
  timeoutMs?: number;
}

export const MAX_PROMPT_CHARS = 800_000;
export const MAX_OUTPUT_TOKENS = 65_536;
const MAX_TOOLS = 64;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_REPLY_BYTES = 8 * 1024 * 1024;

/** Characters a request sends, for estimating its cost before the call. */
export function promptChars(req: ChatRequest): number {
  let n = req.system?.length ?? 0;
  for (const m of req.messages) {
    n += m.content.length;
    if (m.role === 'assistant')
      for (const c of m.toolCalls ?? []) n += JSON.stringify(c.input ?? {}).length;
  }
  for (const t of req.tools ?? []) n += JSON.stringify(t).length;
  if (req.json) n += JSON.stringify(req.json.schema).length;
  return n;
}

/** Programming errors in a request: caught before anything is sent or reserved. */
export function checkChatRequest(req: ChatRequest): void {
  const fail = (msg: string) => {
    throw new TypeError(`Invalid chat request: ${msg}`);
  };
  if (req.messages.length === 0) fail('no messages');
  if (req.messages[0]?.role !== 'user') fail('the first message must be from the user');
  if (!Number.isInteger(req.maxOutputTokens) || req.maxOutputTokens < 1) fail('maxOutputTokens');
  if (req.maxOutputTokens > MAX_OUTPUT_TOKENS) fail('maxOutputTokens too large');
  if (promptChars(req) > MAX_PROMPT_CHARS) fail('prompt too long');
  if (req.json && req.tools?.length) fail('json and tools are exclusive');
  if ((req.tools?.length ?? 0) > MAX_TOOLS) fail('too many tools');
  for (const t of req.tools ?? []) {
    if (!TOOL_NAME.test(t.name)) fail(`tool name ${t.name}`);
    if (t.parameters.type !== 'object') fail('tool parameters must be an object schema');
  }
  if (req.json) {
    if (!TOOL_NAME.test(req.json.name)) fail('json name');
    if (req.json.schema.type !== 'object') fail('json schema must be an object schema');
  }
  const choice = req.toolChoice;
  if (choice && choice !== 'auto' && !req.tools?.length) fail('toolChoice without tools');
  if (typeof choice === 'object' && !req.tools?.some((t) => t.name === choice.name))
    fail('toolChoice names an unknown tool');
}

// Small readers for untrusted provider JSON.
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function parseArgs(raw: string): unknown {
  if (raw.trim() === '') return {};
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * One chat completion with the call's credential and model, in the provider's dialect. Throws
 * AiProviderError (with what the call consumed, when known) on failure.
 */
export async function chat(
  ctx: AiCallContext,
  req: ChatRequest,
  opts: ChatOptions = {},
): Promise<ChatResult> {
  checkChatRequest(req);
  const dialect = AI_PROVIDERS[ctx.credential.provider].dialect;
  const onText = opts.onText;
  const stream = !!onText;
  const send = async (body: unknown, url: string) =>
    postWithRetry(
      ctx,
      {
        url,
        headers: { ...authHeaders(ctx.credential), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        timeoutMs: opts.timeoutMs ?? 120_000,
        maxResponseBytes: MAX_REPLY_BYTES,
      },
      opts,
    );
  const base = ctx.credential.baseUrl;
  if (dialect === 'anthropic') {
    const res = await send(anthropicBody(ctx.model, req, stream), `${base}/messages`);
    return stream ? anthropicStream(res, req, onText) : anthropicReply(await readJson(res), req);
  }
  if (dialect === 'gemini') {
    // The model name goes into the path: encode it so it can't reach another endpoint.
    const model = encodeURIComponent(ctx.model.replace(/^models\//, ''));
    const url = stream
      ? `${base}/models/${model}:streamGenerateContent?alt=sse`
      : `${base}/models/${model}:generateContent`;
    const res = await send(geminiBody(req), url);
    return stream ? geminiStream(res, req, onText) : geminiReply(await readJson(res), req);
  }
  const url = `${base}/chat/completions`;
  let res: OutboundResponse;
  try {
    res = await send(openAiBody(ctx, req, stream, 'json_schema'), url);
  } catch (err) {
    // Plenty of OpenAI-compatible servers only know JSON mode: ask once more that way.
    if (!(req.json && err instanceof AiProviderError && err.code === 'bad_request')) throw err;
    res = await send(openAiBody(ctx, req, stream, 'json_object'), url);
  }
  return stream ? openAiStream(res, req, onText) : openAiReply(await readJson(res), req);
}

/** Fill in usage a provider didn't report, from the text that went each way. */
function withFallbackUsage(usage: ReportedUsage, req: ChatRequest, out: string): ReportedUsage {
  return {
    inputTokens: usage.inputTokens || roughTokens(promptChars(req)),
    outputTokens: usage.outputTokens || roughTokens(out.length),
    audioSeconds: 0,
  };
}

const outputChars = (text: string, calls: AiToolCall[]) =>
  text + calls.map((c) => JSON.stringify(c.input ?? {})).join('');

// ---------------------------------------------------------------------------------------------
// OpenAI dialect (OpenAI, xAI, Groq, OpenRouter, Ollama, custom)

function openAiBody(
  ctx: AiCallContext,
  req: ChatRequest,
  stream: boolean,
  jsonMode: 'json_schema' | 'json_object',
): Obj {
  const messages: Obj[] = [];
  let system = req.system ?? '';
  if (req.json && jsonMode === 'json_object')
    system += `${system ? '\n\n' : ''}Reply with a single JSON object matching this JSON Schema, and nothing else:\n${JSON.stringify(req.json.schema)}`;
  if (system) messages.push({ role: 'system', content: system });
  for (const m of req.messages) {
    if (m.role === 'user') messages.push({ role: 'user', content: m.content });
    else if (m.role === 'tool')
      messages.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    else
      messages.push({
        role: 'assistant',
        content: m.content || null,
        ...(m.toolCalls?.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
              })),
            }
          : {}),
      });
  }
  // OpenAI's own newer models only take max_completion_tokens; compatible servers know max_tokens.
  const maxKey = ctx.credential.provider === 'openai' ? 'max_completion_tokens' : 'max_tokens';
  const choice = req.toolChoice;
  return {
    model: ctx.model,
    messages,
    [maxKey]: req.maxOutputTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
    ...(choice
      ? {
          tool_choice:
            typeof choice === 'object'
              ? { type: 'function', function: { name: choice.name } }
              : choice,
        }
      : {}),
    ...(req.json
      ? {
          response_format:
            jsonMode === 'json_schema'
              ? {
                  type: 'json_schema',
                  json_schema: { name: req.json.name, schema: req.json.schema, strict: false },
                }
              : { type: 'json_object' },
        }
      : {}),
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}

function openAiStop(reason: string, refused: boolean): ChatStop {
  if (refused || reason === 'content_filter') return 'refused';
  if (reason === 'stop') return 'end';
  if (reason === 'length') return 'length';
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  return 'other';
}

function openAiUsage(u: unknown): ReportedUsage {
  const o = obj(u);
  return {
    inputTokens: num(o.prompt_tokens),
    outputTokens: num(o.completion_tokens),
    audioSeconds: 0,
  };
}

function openAiReply(body: unknown, req: ChatRequest): ChatResult {
  const b = obj(body);
  const choice = obj(arr(b.choices)[0]);
  const message = obj(choice.message);
  if (!Object.keys(message).length) throw new AiProviderError('invalid_response');
  const text = str(message.content);
  const toolCalls = arr(message.tool_calls).map((c, i) => {
    const call = obj(c);
    const fn = obj(call.function);
    return {
      id: str(call.id) || `call_${i}`,
      name: str(fn.name),
      input: parseArgs(str(fn.arguments)),
    };
  });
  return {
    text,
    toolCalls,
    stop: openAiStop(str(choice.finish_reason), !!str(message.refusal)),
    usage: withFallbackUsage(openAiUsage(b.usage), req, outputChars(text, toolCalls)),
  };
}

async function openAiStream(
  res: OutboundResponse,
  req: ChatRequest,
  onText: (delta: string) => void,
): Promise<ChatResult> {
  let text = '';
  let finish = '';
  let refused = false;
  let usage: ReportedUsage = { inputTokens: 0, outputTokens: 0, audioSeconds: 0 };
  const calls: { id: string; name: string; args: string }[] = [];
  for await (const ev of sseEvents(res.body)) {
    if (ev.data === '[DONE]') break;
    const chunk = obj(eventJson(ev.data));
    if (chunk.error) throw new AiProviderError('unavailable', undefined, usage);
    if (chunk.usage) usage = openAiUsage(chunk.usage);
    const choice = obj(arr(chunk.choices)[0]);
    const delta = obj(choice.delta);
    const piece = str(delta.content);
    if (piece) {
      text += piece;
      onText(piece);
    }
    if (str(delta.refusal)) refused = true;
    for (const c of arr(delta.tool_calls)) {
      const call = obj(c);
      const index = num(call.index);
      if (index < 0 || index >= MAX_TOOLS) throw new AiProviderError('invalid_response');
      const slot = (calls[index] ??= { id: '', name: '', args: '' });
      const fn = obj(call.function);
      slot.id ||= str(call.id);
      slot.name ||= str(fn.name);
      slot.args += str(fn.arguments);
    }
    if (str(choice.finish_reason)) finish = str(choice.finish_reason);
  }
  const toolCalls = calls
    .filter(Boolean)
    .map((c, i) => ({ id: c.id || `call_${i}`, name: c.name, input: parseArgs(c.args) }));
  return {
    text,
    toolCalls,
    stop: openAiStop(finish, refused),
    usage: withFallbackUsage(usage, req, outputChars(text, toolCalls)),
  };
}

// ---------------------------------------------------------------------------------------------
// Anthropic dialect

function mergeRoles<T extends { role: string; content: unknown[] }>(list: T[]): T[] {
  const out: T[] = [];
  for (const m of list) {
    const last = out.at(-1);
    if (last && last.role === m.role) last.content.push(...m.content);
    else out.push({ ...m, content: [...m.content] });
  }
  return out;
}

function anthropicBody(model: string, req: ChatRequest, stream: boolean): Obj {
  const messages = mergeRoles(
    req.messages.map((m) => {
      if (m.role === 'user') return { role: 'user', content: [{ type: 'text', text: m.content }] };
      if (m.role === 'tool')
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }],
        };
      return {
        role: 'assistant',
        content: [
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
          ...(m.toolCalls ?? []).map((c) => ({
            type: 'tool_use',
            id: c.id,
            name: c.name,
            input: c.input ?? {},
          })),
        ],
      };
    }),
  );
  // Structured replies come back as the input of a tool the model must call.
  const tools = req.json
    ? [
        {
          name: req.json.name,
          description: 'Give your answer by calling this tool.',
          input_schema: req.json.schema,
        },
      ]
    : req.tools?.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
  const choice = req.json ? { name: req.json.name } : req.toolChoice;
  return {
    model,
    max_tokens: req.maxOutputTokens,
    messages,
    ...(req.system ? { system: req.system } : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(choice
      ? {
          tool_choice:
            typeof choice === 'object'
              ? { type: 'tool', name: choice.name }
              : { type: choice === 'required' ? 'any' : 'auto' },
        }
      : {}),
    ...(stream ? { stream: true } : {}),
  };
}

function anthropicStop(reason: string): ChatStop {
  if (reason === 'end_turn' || reason === 'stop_sequence') return 'end';
  if (reason === 'max_tokens') return 'length';
  if (reason === 'tool_use') return 'tool_use';
  if (reason === 'refusal') return 'refused';
  return 'other';
}

const anthropicInput = (u: Obj) =>
  num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.cache_read_input_tokens);

/** With `json`, the forced tool call becomes the reply text. */
function anthropicResult(
  req: ChatRequest,
  text: string,
  toolCalls: AiToolCall[],
  reason: string,
  usage: ReportedUsage,
): ChatResult {
  let stop = anthropicStop(reason);
  const json = req.json;
  if (json) {
    const answer = toolCalls.find((c) => c.name === json.name);
    text = answer && answer.input !== undefined ? JSON.stringify(answer.input) : '';
    toolCalls = [];
    if (stop === 'tool_use') stop = 'end';
  }
  return {
    text,
    toolCalls,
    stop,
    usage: withFallbackUsage(usage, req, outputChars(text, toolCalls)),
  };
}

function anthropicReply(body: unknown, req: ChatRequest): ChatResult {
  const b = obj(body);
  if (!Array.isArray(b.content)) throw new AiProviderError('invalid_response');
  let text = '';
  const toolCalls: AiToolCall[] = [];
  for (const block of b.content.map(obj)) {
    if (block.type === 'text') text += str(block.text);
    if (block.type === 'tool_use')
      toolCalls.push({ id: str(block.id), name: str(block.name), input: block.input ?? {} });
  }
  const u = obj(b.usage);
  return anthropicResult(req, text, toolCalls, str(b.stop_reason), {
    inputTokens: anthropicInput(u),
    outputTokens: num(u.output_tokens),
    audioSeconds: 0,
  });
}

async function anthropicStream(
  res: OutboundResponse,
  req: ChatRequest,
  onText: (delta: string) => void,
): Promise<ChatResult> {
  let text = '';
  let reason = '';
  const usage: ReportedUsage = { inputTokens: 0, outputTokens: 0, audioSeconds: 0 };
  const blocks: { id: string; name: string; json: string }[] = [];
  for await (const ev of sseEvents(res.body)) {
    const data = obj(eventJson(ev.data));
    switch (data.type) {
      case 'message_start': {
        const u = obj(obj(data.message).usage);
        usage.inputTokens = anthropicInput(u);
        usage.outputTokens = num(u.output_tokens);
        break;
      }
      case 'content_block_start': {
        const block = obj(data.content_block);
        const index = num(data.index);
        if (index < 0 || index >= 1024)
          throw new AiProviderError('invalid_response', undefined, usage);
        if (block.type === 'tool_use')
          blocks[index] = { id: str(block.id), name: str(block.name), json: '' };
        break;
      }
      case 'content_block_delta': {
        const delta = obj(data.delta);
        if (delta.type === 'text_delta') {
          const piece = str(delta.text);
          text += piece;
          if (piece && !req.json) onText(piece);
        } else if (delta.type === 'input_json_delta') {
          const block = blocks[num(data.index)];
          if (block) block.json += str(delta.partial_json);
        }
        break;
      }
      case 'message_delta': {
        reason = str(obj(data.delta).stop_reason) || reason;
        const u = obj(data.usage);
        if (u.output_tokens !== undefined) usage.outputTokens = num(u.output_tokens);
        if (u.input_tokens !== undefined) usage.inputTokens = anthropicInput(u);
        break;
      }
      case 'error':
        throw new AiProviderError('unavailable', undefined, usage);
    }
  }
  const toolCalls = blocks
    .filter(Boolean)
    .map((b) => ({ id: b.id, name: b.name, input: parseArgs(b.json) }));
  const result = anthropicResult(req, text, toolCalls, reason, usage);
  if (req.json && result.text) onText(result.text);
  return result;
}

// ---------------------------------------------------------------------------------------------
// Gemini dialect

function geminiBody(req: ChatRequest): Obj {
  const contents = mergeRoles(
    req.messages.map((m) => {
      if (m.role === 'user') return { role: 'user', content: [{ text: m.content }] };
      if (m.role === 'tool')
        return {
          role: 'user',
          content: [{ functionResponse: { name: m.name, response: { content: m.content } } }],
        };
      const parts: Obj[] = [
        ...(m.content ? [{ text: m.content }] : []),
        ...(m.toolCalls ?? []).map((c) => ({
          functionCall: { name: c.name, args: c.input ?? {} },
        })),
      ];
      return { role: 'model', content: parts.length ? parts : [{ text: '' }] };
    }),
  ).map((m) => ({ role: m.role, parts: m.content }));
  const choice = req.toolChoice;
  return {
    contents,
    ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
    generationConfig: {
      maxOutputTokens: req.maxOutputTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.json
        ? { responseMimeType: 'application/json', responseJsonSchema: req.json.schema }
        : {}),
    },
    ...(req.tools?.length
      ? {
          tools: [
            {
              functionDeclarations: req.tools.map((t) => ({
                name: t.name,
                description: t.description,
                parametersJsonSchema: t.parameters,
              })),
            },
          ],
        }
      : {}),
    ...(choice
      ? {
          toolConfig: {
            functionCallingConfig:
              typeof choice === 'object'
                ? { mode: 'ANY', allowedFunctionNames: [choice.name] }
                : { mode: choice === 'required' ? 'ANY' : 'AUTO' },
          },
        }
      : {}),
  };
}

const GEMINI_REFUSED = new Set([
  'SAFETY',
  'RECITATION',
  'BLOCKLIST',
  'PROHIBITED_CONTENT',
  'SPII',
  'IMAGE_SAFETY',
]);

function geminiStop(reason: string, blocked: boolean, calls: number): ChatStop {
  if (blocked || GEMINI_REFUSED.has(reason)) return 'refused';
  if (reason === 'MAX_TOKENS') return 'length';
  if (calls) return 'tool_use';
  if (reason === 'STOP') return 'end';
  return 'other';
}

function geminiUsage(u: unknown): ReportedUsage {
  const o = obj(u);
  return {
    inputTokens: num(o.promptTokenCount),
    outputTokens: num(o.candidatesTokenCount) + num(o.thoughtsTokenCount),
    audioSeconds: 0,
  };
}

/** Text and calls of one response (or one streamed piece of it); thoughts are skipped. */
function geminiParts(body: Obj, offset: number) {
  const candidate = obj(arr(body.candidates)[0]);
  let text = '';
  const calls: AiToolCall[] = [];
  for (const part of arr(obj(candidate.content).parts).map(obj)) {
    if (part.thought === true) continue;
    if (typeof part.text === 'string') text += part.text;
    if (part.functionCall) {
      const fc = obj(part.functionCall);
      calls.push({
        id: str(fc.id) || `call_${offset + calls.length}`,
        name: str(fc.name),
        input: fc.args ?? {},
      });
    }
  }
  return {
    text,
    calls,
    reason: str(candidate.finishReason),
    blocked: !!str(obj(body.promptFeedback).blockReason),
  };
}

function geminiReply(body: unknown, req: ChatRequest): ChatResult {
  const b = obj(body);
  if (!Array.isArray(b.candidates) && !b.promptFeedback)
    throw new AiProviderError('invalid_response');
  const { text, calls, reason, blocked } = geminiParts(b, 0);
  return {
    text,
    toolCalls: calls,
    stop: geminiStop(reason, blocked, calls.length),
    usage: withFallbackUsage(geminiUsage(b.usageMetadata), req, outputChars(text, calls)),
  };
}

async function geminiStream(
  res: OutboundResponse,
  req: ChatRequest,
  onText: (delta: string) => void,
): Promise<ChatResult> {
  let text = '';
  let reason = '';
  let blocked = false;
  const toolCalls: AiToolCall[] = [];
  let usage: ReportedUsage = { inputTokens: 0, outputTokens: 0, audioSeconds: 0 };
  for await (const ev of sseEvents(res.body)) {
    const b = obj(eventJson(ev.data));
    if (b.error) throw new AiProviderError('unavailable', undefined, usage);
    const part = geminiParts(b, toolCalls.length);
    if (part.text) {
      text += part.text;
      onText(part.text);
    }
    toolCalls.push(...part.calls);
    reason = part.reason || reason;
    blocked ||= part.blocked;
    // usageMetadata is cumulative: the last one counts.
    if (b.usageMetadata) usage = geminiUsage(b.usageMetadata);
  }
  return {
    text,
    toolCalls,
    stop: geminiStop(reason, blocked, toolCalls.length),
    usage: withFallbackUsage(usage, req, outputChars(text, toolCalls)),
  };
}
