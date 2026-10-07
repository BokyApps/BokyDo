import type { AiProvider } from '@bokydo/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OutboundError, type OutboundFetch, type OutboundRequest } from '../net/outbound.js';
import type { AiCallContext } from './adapters.js';
import { chat, checkChatRequest, type ChatRequest } from './chat.js';
import { embed, transcribe } from './media.js';
import { replySchema } from './service.js';
import { AiProviderError, postWithRetry, retryAfterMs, sseEvents } from './transport.js';

// Looks like a real key so a leak would be obvious; not a credential for anything.
const KEY = 'sk-test-PROVIDERCANARY0123456789'; // gitleaks:allow

interface Scripted {
  status?: number;
  headers?: Record<string, string>;
  /** JSON body, or raw chunks (for streams). */
  json?: unknown;
  chunks?: string[];
  throws?: OutboundError;
}

interface Seen {
  url: string;
  headers: Record<string, string>;
  body: string;
  bodyBuffer: Buffer;
}

function fake(...script: Scripted[]) {
  const seen: Seen[] = [];
  const fetch: OutboundFetch = async (url: string, init: OutboundRequest = {}) => {
    const buf = Buffer.from(init.body ?? '');
    seen.push({ url, headers: init.headers ?? {}, body: buf.toString('utf8'), bodyBuffer: buf });
    const step = script.shift();
    if (!step) throw new Error('unexpected request');
    if (step.throws) throw step.throws;
    const raw = step.chunks ?? [JSON.stringify(step.json ?? {})];
    return {
      status: step.status ?? 200,
      headers: step.headers ?? {},
      body: (async function* () {
        for (const c of raw) yield Buffer.from(c);
      })(),
      text: async () => raw.join(''),
      json: async () => JSON.parse(raw.join('')) as unknown,
      cancel: () => undefined,
    };
  };
  return { fetch, seen, left: () => script.length };
}

const BASE: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
  'openai-compatible': 'https://llm.example/v1',
  groq: 'https://api.groq.com/openai/v1',
};

function ctx(provider: AiProvider, fetch: OutboundFetch, model = 'm-1'): AiCallContext {
  return {
    credential: {
      id: 'c',
      ownerUserId: null,
      provider,
      baseUrl: BASE[provider]!,
      apiKey: KEY,
      headers: {},
    },
    model,
    fetch,
  };
}

const noSleep = { sleep: async () => undefined };
const ask: ChatRequest = {
  system: 'Be brief.',
  messages: [{ role: 'user', content: 'Hello' }],
  maxOutputTokens: 100,
};
const sse = (events: unknown[], done = false) => [
  ...events.map((e) => `data: ${JSON.stringify(e)}\n\n`),
  ...(done ? ['data: [DONE]\n\n'] : []),
];

describe('chat: OpenAI dialect', () => {
  it('sends the request and reads the reply and usage', async () => {
    const f = fake({
      json: {
        choices: [{ message: { content: 'Hi!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 3 },
      },
    });
    const r = await chat(ctx('openai', f.fetch), ask, noSleep);
    expect(r).toEqual({
      text: 'Hi!',
      toolCalls: [],
      stop: 'end',
      usage: { inputTokens: 12, outputTokens: 3, audioSeconds: 0 },
    });
    expect(f.seen[0]!.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(f.seen[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(f.seen[0]!.url).not.toContain(KEY);
    const body = JSON.parse(f.seen[0]!.body);
    expect(body).toEqual({
      model: 'm-1',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello' },
      ],
      max_completion_tokens: 100,
    });
  });

  it('uses max_tokens for compatible servers and estimates missing usage', async () => {
    const f = fake({
      json: { choices: [{ message: { content: 'abcdefgh' }, finish_reason: 'length' }] },
    });
    const r = await chat(ctx('openai-compatible', f.fetch), ask, noSleep);
    expect(JSON.parse(f.seen[0]!.body).max_tokens).toBe(100);
    expect(r.stop).toBe('length');
    expect(r.usage).toEqual({ inputTokens: 4, outputTokens: 2, audioSeconds: 0 });
  });

  it('round-trips tool calls and tool results', async () => {
    const f = fake({
      json: {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call_a',
                  type: 'function',
                  function: { name: 'find', arguments: '{"q":"x"}' },
                },
                { id: 'call_b', type: 'function', function: { name: 'find', arguments: '{oops' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
    });
    const tools = [
      { name: 'find', description: 'Find', parameters: { type: 'object', properties: {} } },
    ];
    const r = await chat(
      ctx('xai', f.fetch),
      {
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 't1', name: 'find', input: { q: 1 } }],
          },
          { role: 'tool', toolCallId: 't1', name: 'find', content: '[]' },
        ],
        maxOutputTokens: 50,
        tools,
        toolChoice: 'required',
      },
      noSleep,
    );
    expect(r.stop).toBe('tool_use');
    expect(r.toolCalls).toEqual([
      { id: 'call_a', name: 'find', input: { q: 'x' } },
      { id: 'call_b', name: 'find', input: undefined },
    ]);
    const body = JSON.parse(f.seen[0]!.body);
    expect(body.tool_choice).toBe('required');
    expect(body.tools[0]).toEqual({ type: 'function', function: tools[0] });
    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: null,
      tool_calls: [
        { id: 't1', type: 'function', function: { name: 'find', arguments: '{"q":1}' } },
      ],
    });
    expect(body.messages[2]).toEqual({ role: 'tool', tool_call_id: 't1', content: '[]' });
  });

  it('streams text, tool-call fragments and the usage chunk', async () => {
    const f = fake({
      chunks: [
        ...sse([
          { choices: [{ delta: { content: 'He' } }] },
          { choices: [{ delta: { content: 'llo' } }] },
          {
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a"' } }],
                },
              },
            ],
          },
        ]),
        // An event split across network chunks.
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}',
        ',"finish_reason":"tool_calls"}]}\n\n',
        ...sse([{ choices: [], usage: { prompt_tokens: 7, completion_tokens: 5 } }], true),
      ],
    });
    const pieces: string[] = [];
    const r = await chat(ctx('openrouter', f.fetch), ask, {
      ...noSleep,
      onText: (d) => pieces.push(d),
    });
    expect(pieces).toEqual(['He', 'llo']);
    expect(r).toEqual({
      text: 'Hello',
      toolCalls: [{ id: 'c1', name: 'f', input: { a: 1 } }],
      stop: 'tool_use',
      usage: { inputTokens: 7, outputTokens: 5, audioSeconds: 0 },
    });
    const body = JSON.parse(f.seen[0]!.body);
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
  });

  it('asks for a JSON schema, and falls back to JSON mode where that is refused', async () => {
    const schema = { type: 'object', properties: { a: { type: 'number' } } };
    const f = fake(
      { status: 400, json: { error: 'response_format json_schema unsupported' } },
      { json: { choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] } },
    );
    const r = await chat(
      ctx('groq', f.fetch),
      { ...ask, json: { name: 'answer', schema } },
      noSleep,
    );
    expect(r.text).toBe('{"a":1}');
    const [first, second] = f.seen.map((s) => JSON.parse(s.body));
    expect(first.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'answer', schema, strict: false },
    });
    expect(second.response_format).toEqual({ type: 'json_object' });
    expect(second.messages[0].content).toContain(JSON.stringify(schema));
  });

  it('reports refusals and mid-stream errors', async () => {
    const refused = fake({
      json: { choices: [{ message: { content: null, refusal: 'no' }, finish_reason: 'stop' }] },
    });
    expect((await chat(ctx('openai', refused.fetch), ask, noSleep)).stop).toBe('refused');
    const broken = fake({
      chunks: sse([{ choices: [{ delta: { content: 'a' } }] }, { error: { message: KEY } }]),
    });
    await expect(
      chat(ctx('openai', broken.fetch), ask, { ...noSleep, onText: () => undefined }),
    ).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('chat: Anthropic dialect', () => {
  it('maps messages, merges tool results into a user turn and reads usage', async () => {
    const f = fake({
      json: {
        content: [
          { type: 'thinking', thinking: 'hmm' },
          { type: 'text', text: 'Done.' },
          { type: 'tool_use', id: 'tu1', name: 'find', input: { q: 'y' } },
        ],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 4 },
      },
    });
    const r = await chat(
      ctx('anthropic', f.fetch),
      {
        system: 'S',
        messages: [
          { role: 'user', content: 'go' },
          {
            role: 'assistant',
            content: 'Looking',
            toolCalls: [
              { id: 'a', name: 'find', input: {} },
              { id: 'b', name: 'find', input: {} },
            ],
          },
          { role: 'tool', toolCallId: 'a', name: 'find', content: '1' },
          { role: 'tool', toolCallId: 'b', name: 'find', content: '2' },
        ],
        maxOutputTokens: 64,
        tools: [{ name: 'find', description: 'd', parameters: { type: 'object' } }],
        toolChoice: { name: 'find' },
      },
      noSleep,
    );
    expect(r).toEqual({
      text: 'Done.',
      toolCalls: [{ id: 'tu1', name: 'find', input: { q: 'y' } }],
      stop: 'tool_use',
      usage: { inputTokens: 15, outputTokens: 4, audioSeconds: 0 },
    });
    const s = f.seen[0]!;
    expect(s.url).toBe('https://api.anthropic.com/v1/messages');
    expect(s.headers['x-api-key']).toBe(KEY);
    expect(s.headers['anthropic-version']).toBe('2023-06-01');
    const body = JSON.parse(s.body);
    expect(body.system).toBe('S');
    expect(body.max_tokens).toBe(64);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'find' });
    expect(body.tools).toEqual([
      { name: 'find', description: 'd', input_schema: { type: 'object' } },
    ]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Looking' },
          { type: 'tool_use', id: 'a', name: 'find', input: {} },
          { type: 'tool_use', id: 'b', name: 'find', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: '1' },
          { type: 'tool_result', tool_use_id: 'b', content: '2' },
        ],
      },
    ]);
  });

  it('gets structured replies through a forced tool call', async () => {
    const f = fake({
      json: {
        content: [{ type: 'tool_use', id: 'x', name: 'answer', input: { a: 2 } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const schema = { type: 'object', properties: { a: { type: 'number' } } };
    const r = await chat(
      ctx('anthropic', f.fetch),
      { ...ask, json: { name: 'answer', schema } },
      noSleep,
    );
    expect(r).toMatchObject({ text: '{"a":2}', toolCalls: [], stop: 'end' });
    const body = JSON.parse(f.seen[0]!.body);
    expect(body.tools).toEqual([
      { name: 'answer', description: expect.any(String), input_schema: schema },
    ]);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'answer' });
  });

  it('streams text and tool input deltas', async () => {
    const ev = (event: string, data: unknown) =>
      `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const f = fake({
      chunks: [
        ev('message_start', {
          type: 'message_start',
          message: { usage: { input_tokens: 9, output_tokens: 1 } },
        }),
        ev('ping', { type: 'ping' }),
        ev('content_block_start', {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        ev('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'Hi ' },
        }),
        ev('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'there' },
        }),
        ev('content_block_start', {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'tu', name: 'f', input: {} },
        }),
        ev('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"k":' },
        }),
        ev('content_block_delta', {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '"v"}' },
        }),
        ev('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use' },
          usage: { output_tokens: 22 },
        }),
        ev('message_stop', { type: 'message_stop' }),
      ],
    });
    const pieces: string[] = [];
    const r = await chat(ctx('anthropic', f.fetch), ask, {
      ...noSleep,
      onText: (d) => pieces.push(d),
    });
    expect(pieces).toEqual(['Hi ', 'there']);
    expect(r).toEqual({
      text: 'Hi there',
      toolCalls: [{ id: 'tu', name: 'f', input: { k: 'v' } }],
      stop: 'tool_use',
      usage: { inputTokens: 9, outputTokens: 22, audioSeconds: 0 },
    });
  });

  it('fails on an error event, keeping the usage so far', async () => {
    const f = fake({
      chunks: [
        `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 9 } } })}\n\n`,
        `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error' } })}\n\n`,
      ],
    });
    const err = await chat(ctx('anthropic', f.fetch), ask, {
      ...noSleep,
      onText: () => undefined,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiProviderError);
    expect((err as AiProviderError).usage.inputTokens).toBe(9);
  });
});

describe('chat: Gemini dialect', () => {
  it('encodes the model into the path and maps the request', async () => {
    const f = fake({
      json: {
        candidates: [
          {
            content: { parts: [{ text: 'thinking…', thought: true }, { text: 'Yes' }] },
            finishReason: 'STOP',
          },
        ],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2, thoughtsTokenCount: 30 },
      },
    });
    const r = await chat(
      ctx('gemini', f.fetch, '../../files?x=1#'),
      {
        ...ask,
        json: { name: 'a', schema: { type: 'object' } },
      },
      noSleep,
    );
    expect(r).toEqual({
      text: 'Yes',
      toolCalls: [],
      stop: 'end',
      usage: { inputTokens: 8, outputTokens: 32, audioSeconds: 0 },
    });
    expect(f.seen[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/..%2F..%2Ffiles%3Fx%3D1%23:generateContent',
    );
    expect(f.seen[0]!.headers['x-goog-api-key']).toBe(KEY);
    const body = JSON.parse(f.seen[0]!.body);
    expect(body).toEqual({
      contents: [{ role: 'user', parts: [{ text: 'Hello' }] }],
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      generationConfig: {
        maxOutputTokens: 100,
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
      },
    });
  });

  it('accepts a models/ prefix, maps tools, and streams', async () => {
    const f = fake({
      chunks: sse([
        { candidates: [{ content: { parts: [{ text: 'A' }] } }] },
        {
          candidates: [
            {
              content: { parts: [{ text: 'B' }, { functionCall: { name: 'f', args: { x: 1 } } }] },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 },
        },
      ]),
    });
    const pieces: string[] = [];
    const r = await chat(
      ctx('gemini', f.fetch, 'models/gemini-x'),
      {
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'i', name: 'f', input: {} }] },
          { role: 'tool', toolCallId: 'i', name: 'f', content: 'ok' },
        ],
        maxOutputTokens: 10,
        tools: [{ name: 'f', description: 'd', parameters: { type: 'object' } }],
        toolChoice: 'auto',
      },
      { ...noSleep, onText: (d) => pieces.push(d) },
    );
    expect(f.seen[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:streamGenerateContent?alt=sse',
    );
    expect(pieces).toEqual(['A', 'B']);
    expect(r).toEqual({
      text: 'AB',
      toolCalls: [{ id: 'call_0', name: 'f', input: { x: 1 } }],
      stop: 'tool_use',
      usage: { inputTokens: 3, outputTokens: 4, audioSeconds: 0 },
    });
    const body = JSON.parse(f.seen[0]!.body);
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'q' }] },
      { role: 'model', parts: [{ functionCall: { name: 'f', args: {} } }] },
      { role: 'user', parts: [{ functionResponse: { name: 'f', response: { content: 'ok' } } }] },
    ]);
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          { name: 'f', description: 'd', parametersJsonSchema: { type: 'object' } },
        ],
      },
    ]);
    expect(body.toolConfig).toEqual({ functionCallingConfig: { mode: 'AUTO' } });
  });

  it('reports a blocked prompt as refused', async () => {
    const f = fake({ json: { promptFeedback: { blockReason: 'SAFETY' } } });
    expect((await chat(ctx('gemini', f.fetch), ask, noSleep)).stop).toBe('refused');
  });
});

describe('transport', () => {
  it('retries throttling and server errors, honouring Retry-After', async () => {
    const waits: number[] = [];
    const f = fake(
      { status: 429, headers: { 'retry-after': '2' } },
      { status: 503 },
      { json: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } },
    );
    const r = await chat(ctx('openai', f.fetch), ask, { sleep: async (ms) => void waits.push(ms) });
    expect(r.text).toBe('ok');
    expect(f.seen).toHaveLength(3);
    expect(waits[0]).toBe(2000);
    expect(waits[1]).toBeGreaterThan(0);
  });

  it('gives up after three attempts, and never retries client errors', async () => {
    const f = fake({ status: 500 }, { status: 502 }, { status: 529 });
    await expect(chat(ctx('anthropic', f.fetch), ask, noSleep)).rejects.toMatchObject({
      code: 'unavailable',
      status: 529,
    });
    for (const [status, code] of [
      [401, 'unauthorized'],
      [403, 'unauthorized'],
      [404, 'not_found'],
      [400, 'bad_request'],
    ] as const) {
      const once = fake({ status, json: { error: { message: `bad key ${KEY}` } } });
      const err = await chat(ctx('anthropic', once.fetch), ask, noSleep).catch((e: unknown) => e);
      expect(err).toMatchObject({ code, status });
      expect(String(err)).not.toContain('CANARY');
      expect(JSON.stringify(err)).not.toContain('CANARY');
      expect(once.left()).toBe(0);
    }
  });

  it('does not wait out a long Retry-After', async () => {
    const f = fake({ status: 429, headers: { 'retry-after': '3600' } });
    await expect(chat(ctx('openai', f.fetch), ask, noSleep)).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('retries dropped connections only, never policy refusals', async () => {
    const ok = { json: { choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] } };
    const f = fake({ throws: new OutboundError('network') }, ok);
    expect((await chat(ctx('openai', f.fetch), ask, noSleep)).text).toBe('ok');
    for (const reason of ['blocked_address', 'redirect', 'timeout', 'insecure_url'] as const) {
      const g = fake({ throws: new OutboundError(reason) }, ok);
      await expect(chat(ctx('openai', g.fetch), ask, noSleep)).rejects.toMatchObject({
        code: reason,
      });
      expect(g.left()).toBe(1);
    }
  });

  it('stops waiting when the call is cancelled', async () => {
    const controller = new AbortController();
    const f = fake({ status: 503 }, { status: 200 });
    const pending = postWithRetry(
      { fetch: f.fetch, signal: controller.signal },
      { url: 'https://x.example', headers: {}, body: '', timeoutMs: 1000, maxResponseBytes: 10 },
    );
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('parses Retry-After seconds and dates', () => {
    expect(retryAfterMs('1.5')).toBe(1500);
    expect(retryAfterMs(new Date(10_000).toUTCString(), 4_000)).toBe(6_000);
    expect(retryAfterMs('soon')).toBeNull();
    expect(retryAfterMs(undefined)).toBeNull();
  });

  it('parses server-sent events across chunk and line-ending boundaries', async () => {
    const out = [];
    for await (const e of sseEvents(
      (async function* () {
        for (const c of [
          ': comment\r\nevent: a\r\nda',
          'ta: 1\r\ndata: 2\r\n\r\n',
          'data: x\n\ndata: tail',
        ])
          yield Buffer.from(c);
      })(),
    ))
      out.push(e);
    expect(out).toEqual([
      { event: 'a', data: '1\n2' },
      { event: null, data: 'x' },
      { event: null, data: 'tail' },
    ]);
  });

  it('refuses an endless event', async () => {
    const huge = (async function* () {
      for (let i = 0; i < 20; i++) yield Buffer.from(`data: ${'x'.repeat(100_000)}\n`);
    })();
    const read = async () => {
      for await (const _ of sseEvents(huge)) void _;
    };
    await expect(read()).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('request checks', () => {
  it('rejects malformed requests before anything is sent', () => {
    const bad: ChatRequest[] = [
      { messages: [], maxOutputTokens: 1 },
      { messages: [{ role: 'assistant', content: 'x' }], maxOutputTokens: 1 },
      { ...ask, maxOutputTokens: 0 },
      { ...ask, maxOutputTokens: 1_000_000 },
      { ...ask, messages: [{ role: 'user', content: 'x'.repeat(900_000) }] },
      { ...ask, tools: [{ name: 'bad name', description: '', parameters: { type: 'object' } }] },
      { ...ask, tools: [{ name: 'f', description: '', parameters: { type: 'string' } }] },
      { ...ask, toolChoice: 'required' },
      {
        ...ask,
        tools: [{ name: 'f', description: '', parameters: { type: 'object' } }],
        toolChoice: { name: 'g' },
      },
      {
        ...ask,
        tools: [{ name: 'f', description: '', parameters: { type: 'object' } }],
        json: { name: 'a', schema: { type: 'object' } },
      },
      { ...ask, json: { name: 'a', schema: { type: 'array' } } },
    ];
    for (const req of bad)
      expect(() => checkChatRequest(req), JSON.stringify(req).slice(0, 80)).toThrow(TypeError);
  });

  it('turns a zod schema into a reply schema without the meta key', () => {
    expect(replySchema(z.object({ a: z.number(), b: z.string().optional() }).strict())).toEqual({
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'string' } },
      required: ['a'],
      additionalProperties: false,
    });
  });
});

describe('speech to text and embeddings', () => {
  it('uploads audio as multipart with a random boundary and meters seconds', async () => {
    const f = fake({ json: { text: 'buy milk', duration: 4.2 } });
    const r = await transcribe(
      ctx('groq', f.fetch, 'whisper-large-v3'),
      {
        audio: Buffer.from('RIFFdata'),
        mimeType: 'audio/webm;codecs=opus',
        durationSeconds: 5,
        language: 'en',
        prompt: 'Lisbon\r\n--x\r\n"trip"',
      },
      noSleep,
    );
    expect(r).toEqual({
      text: 'buy milk',
      usage: { inputTokens: 0, outputTokens: 0, audioSeconds: 5 },
    });
    const s = f.seen[0]!;
    expect(s.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    const boundary = /boundary=(bokydo-[0-9a-f]{32})$/.exec(s.headers['content-type']!)![1]!;
    const parts = s.body.split(`--${boundary}`);
    expect(parts).toHaveLength(7); // preamble, 5 parts, closing
    expect(s.body).toContain('name="model"\r\n\r\nwhisper-large-v3\r\n');
    expect(s.body).toContain('name="language"\r\n\r\nen\r\n');
    expect(s.body).toContain('name="prompt"\r\n\r\nLisbon  --x   trip \r\n');
    expect(s.body).toContain(
      'filename="audio.webm"\r\nContent-Type: audio/webm\r\n\r\nRIFFdata\r\n',
    );

    // A fresh boundary each time: audio can't be crafted to end its part early.
    const again = fake({ json: { text: '' } });
    await transcribe(
      ctx('groq', again.fetch),
      { audio: Buffer.from('x'), mimeType: 'audio/wav', durationSeconds: 1 },
      noSleep,
    );
    expect(again.seen[0]!.headers['content-type']).not.toContain(boundary);
  });

  it('meters what the provider reports, and validates the audio', async () => {
    const f = fake({ json: { text: '', usage: { type: 'duration', seconds: 61 } } });
    const r = await transcribe(
      ctx('openai', f.fetch),
      { audio: Buffer.from('x'), mimeType: 'audio/mpeg', durationSeconds: 2 },
      noSleep,
    );
    expect(r.usage.audioSeconds).toBe(61);
    for (const bad of [
      { audio: Buffer.from('x'), mimeType: 'video/mp4', durationSeconds: 1 },
      { audio: Buffer.alloc(0), mimeType: 'audio/wav', durationSeconds: 1 },
      { audio: Buffer.from('x'), mimeType: 'audio/wav', durationSeconds: 0 },
      { audio: Buffer.from('x'), mimeType: 'audio/wav', durationSeconds: 1, language: 'en"' },
    ])
      await expect(transcribe(ctx('openai', fake().fetch), bad)).rejects.toThrow(TypeError);
  });

  it('embeds through both dialects, ordered by index', async () => {
    const f = fake({
      json: {
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
        usage: { prompt_tokens: 6 },
      },
    });
    const r = await embed(ctx('openai', f.fetch, 'text-embedding-3-small'), ['a', 'b'], noSleep);
    expect(r.vectors).toEqual([
      [1, 0],
      [0, 1],
    ]);
    expect(r.usage.inputTokens).toBe(6);
    expect(f.seen[0]!.url).toBe('https://api.openai.com/v1/embeddings');

    const g = fake({ json: { embeddings: [{ values: [0.5, 0.5] }] } });
    const s = await embed(ctx('gemini', g.fetch, 'text-embedding-004'), ['hello'], noSleep);
    expect(s.vectors).toEqual([[0.5, 0.5]]);
    expect(g.seen[0]!.url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents',
    );
    expect(JSON.parse(g.seen[0]!.body).requests[0].model).toBe('models/text-embedding-004');
  });

  it('rejects missing, ragged or non-numeric vectors', async () => {
    for (const data of [
      [{ index: 0, embedding: [1] }],
      [
        { index: 0, embedding: [1] },
        { index: 1, embedding: [1, 2] },
      ],
      [
        { index: 0, embedding: [1] },
        { index: 1, embedding: ['1'] },
      ],
    ]) {
      const f = fake({ json: { data } });
      await expect(embed(ctx('openai', f.fetch), ['a', 'b'], noSleep)).rejects.toMatchObject({
        code: 'invalid_response',
      });
    }
  });
});
