import type { RambleDraftTask, RambleOpSummary, RambleResolvedTask } from '@bokydo/shared';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import {
  applyOps,
  contextBlock,
  extractionSchema,
  resolveDraft,
  SYSTEM_PROMPT,
  type RambleContext,
} from '../ramble/ramble.js';
import { authHeaders } from './adapters.js';
import type { UsableCredential } from './credentials.js';
import { replySchema } from './service.js';

/** A draft update the model produced: the same edit operations `/ramble/extract` applies. */
export interface LiveDraftUpdate {
  draft: RambleResolvedTask[];
  ops: RambleOpSummary[];
}

export interface LiveHandlers {
  /** The session is set up; `sampleRate` is the PCM16 rate the client must record at. */
  onReady(sampleRate: number): void;
  onTranscript(text: string, final: boolean): void;
  onDraft(update: LiveDraftUpdate): void;
  /** A provider-side problem, as a code (never the provider's own words). */
  onError(code: string): void;
}

/** What the relay drives once the provider socket is open. */
export interface LiveSession {
  sendAudio(base64: string): void;
  sendText(text: string): void;
  /** The user finished speaking: flush the turn and ask for a final reply. */
  stop(): void;
}

/** The provider side of the relay: where to connect, how to authenticate, how to translate. */
export interface LiveProvider {
  /** The provider's WebSocket URL for this credential and model (never shared with the browser). */
  url(credential: UsableCredential, model: string): string;
  /** Handshake headers, key included. The key lives only here and in the socket, never the client. */
  headers(credential: UsableCredential): Record<string, string>;
  /** PCM16 input sample rate the browser must use (OpenAI 24 kHz, Gemini 16 kHz). */
  sampleRate: number;
  open(ws: WebSocket, model: string, ctx: RambleContext, handlers: LiveHandlers): LiveSession;
}

const TOOL_NAME = 'edit_draft';
const TOOL_DESCRIPTION =
  'Add, update or remove tasks on the draft list as the speaker talks. Send flat operations; never a full list.';

/**
 * What the model is told in a live session: the extractor's rules plus the account's names. The
 * model keeps the draft itself (through the tool), so there is no `<draft>` block and no
 * transcript: it hears the speech.
 */
function liveInstructions(ctx: RambleContext): string {
  return [
    SYSTEM_PROMPT,
    '',
    'This is a live session: you hear the user speak and edit the draft yourself with the',
    `${TOOL_NAME} tool. The draft is the list of tasks you have added so far; keep it, and send`,
    'operations for every change the speaker makes.',
    '',
    contextBlock(ctx),
  ].join('\n');
}

/**
 * Gemini's function schema is an OpenAPI subset: it wants a single `type` (with `nullable`) and
 * rejects `additionalProperties`/`$schema`, so it is written out rather than derived from Zod.
 * The reply is still parsed and validated by `extractionSchema` before it is trusted.
 */
const GEMINI_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    ops: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['add', 'update', 'remove'] },
          ref: { type: 'string' },
          content: { type: 'string' },
          description: { type: 'string' },
          due: { type: 'string', nullable: true },
          priority: { type: 'integer', nullable: true },
          project: { type: 'string', nullable: true },
          section: { type: 'string', nullable: true },
          labels: { type: 'array', items: { type: 'string' } },
          assignee: { type: 'string', nullable: true },
        },
        required: ['op'],
      },
    },
  },
  required: ['ops'],
} as const;

const withWss = (baseUrl: string): URL => {
  const url = new URL(baseUrl);
  url.protocol = 'wss:';
  url.username = '';
  url.password = '';
  url.hash = '';
  return url;
};

/** Applies a model's edit operations to the live draft and resolves them, exactly as extract does. */
function makeApplier(ctx: RambleContext, handlers: LiveHandlers) {
  let draft: RambleDraftTask[] = [];
  return (args: unknown) => {
    const parsed = extractionSchema.safeParse(args);
    if (!parsed.success) return;
    const next = applyOps(draft, parsed.data.ops);
    draft = next.draft;
    handlers.onDraft({ draft: resolveDraft(draft, ctx), ops: next.applied });
  };
}

/** JSON text frame from a provider socket (`ws` may also deliver Buffers). */
const textOf = (data: unknown): string | null =>
  typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : null;

// OpenAI Realtime (ADR 0014). Text-only replies: we want the draft edits, not speech.
const oaHead = z.object({ type: z.string() }).loose();
const oaTranscript = z
  .object({
    type: z.literal('conversation.item.input_audio_transcription.completed'),
    transcript: z.string(),
  })
  .loose();
const oaTranscriptDelta = z
  .object({
    type: z.literal('conversation.item.input_audio_transcription.delta'),
    delta: z.string(),
  })
  .loose();
const oaFunctionCall = z
  .object({
    type: z.literal('response.output_item.done'),
    item: z
      .object({
        type: z.literal('function_call'),
        name: z.string(),
        arguments: z.string(),
        call_id: z.string(),
      })
      .loose(),
  })
  .loose();
const oaError = z
  .object({
    type: z.literal('error'),
    error: z.object({ code: z.string().optional() }).loose().optional(),
  })
  .loose();

const openaiLive: LiveProvider = {
  sampleRate: 24_000,
  url(credential, model) {
    const url = withWss(credential.baseUrl);
    url.pathname = `${url.pathname.replace(/\/$/, '')}/realtime`;
    url.search = `?model=${encodeURIComponent(model)}`;
    return url.toString();
  },
  headers: (credential) => ({ ...authHeaders(credential), 'openai-beta': 'realtime=v1' }),
  open(ws, _model, ctx, handlers) {
    const send = (value: unknown) => ws.send(JSON.stringify(value));
    const apply = makeApplier(ctx, handlers);
    ws.on('message', (data) => {
      const text = textOf(data);
      if (text === null) return;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return;
      }
      const head = oaHead.safeParse(value);
      if (!head.success) return;
      switch (head.data.type) {
        case 'conversation.item.input_audio_transcription.completed': {
          const e = oaTranscript.safeParse(value);
          if (e.success) handlers.onTranscript(e.data.transcript, true);
          break;
        }
        case 'conversation.item.input_audio_transcription.delta': {
          const e = oaTranscriptDelta.safeParse(value);
          if (e.success) handlers.onTranscript(e.data.delta, false);
          break;
        }
        case 'response.output_item.done': {
          const e = oaFunctionCall.safeParse(value);
          if (!e.success || e.data.item.name !== TOOL_NAME) break;
          let args: unknown;
          try {
            args = JSON.parse(e.data.item.arguments);
          } catch {
            args = undefined;
          }
          apply(args);
          send({
            type: 'conversation.item.create',
            item: {
              type: 'function_call_output',
              call_id: e.data.item.call_id,
              output: JSON.stringify({ ok: true }),
            },
          });
          send({ type: 'response.create' });
          break;
        }
        case 'error': {
          const e = oaError.safeParse(value);
          handlers.onError(e.success && e.data.error?.code ? e.data.error.code : 'provider_error');
          break;
        }
      }
    });
    send({
      type: 'session.update',
      session: {
        modalities: ['text'],
        instructions: liveInstructions(ctx),
        input_audio_format: 'pcm16',
        input_audio_transcription: { model: 'whisper-1' },
        turn_detection: { type: 'server_vad' },
        tools: [
          {
            type: 'function',
            name: TOOL_NAME,
            description: TOOL_DESCRIPTION,
            parameters: replySchema(extractionSchema),
          },
        ],
        tool_choice: 'auto',
      },
    });
    handlers.onReady(openaiLive.sampleRate);
    return {
      sendAudio: (base64) => send({ type: 'input_audio_buffer.append', audio: base64 }),
      sendText: (text) => {
        send({
          type: 'conversation.item.create',
          item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
        });
        send({ type: 'response.create' });
      },
      stop: () => {
        send({ type: 'input_audio_buffer.commit' });
        send({ type: 'response.create' });
      },
    };
  },
};

// Gemini Live (ADR 0014). The key travels in the `x-goog-api-key` header from `authHeaders`.
const gHead = z
  .object({ serverContent: z.unknown().optional(), toolCall: z.unknown().optional() })
  .loose();
const gTranscript = z
  .object({
    serverContent: z.object({ inputTranscription: z.object({ text: z.string() }).loose() }).loose(),
  })
  .loose();
const gToolCall = z
  .object({
    toolCall: z
      .object({
        functionCalls: z.array(
          z.object({ id: z.string().optional(), name: z.string(), args: z.unknown() }).loose(),
        ),
      })
      .loose(),
  })
  .loose();

const geminiLive: LiveProvider = {
  sampleRate: 16_000,
  url(credential) {
    const base = withWss(credential.baseUrl);
    const version = base.pathname.replace(/^\/+/, '').split('/')[0] || 'v1beta';
    base.pathname = `/ws/google.ai.generativelanguage.${version}.GenerativeService.BidiGenerateContent`;
    base.search = '';
    return base.toString();
  },
  headers: (credential) => authHeaders(credential),
  open(ws, model, ctx, handlers) {
    const send = (value: unknown) => ws.send(JSON.stringify(value));
    const apply = makeApplier(ctx, handlers);
    send({
      setup: {
        model: `models/${model.replace(/^models\//, '')}`,
        systemInstruction: { parts: [{ text: liveInstructions(ctx) }] },
        generationConfig: { responseModalities: ['TEXT'] },
        inputAudioTranscription: {},
        tools: [
          {
            functionDeclarations: [
              { name: TOOL_NAME, description: TOOL_DESCRIPTION, parameters: GEMINI_DRAFT_SCHEMA },
            ],
          },
        ],
      },
    });
    ws.on('message', (data) => {
      const text = textOf(data);
      if (text === null) return;
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return;
      }
      const head = gHead.safeParse(value);
      if (!head.success) return;
      if (head.data.serverContent !== undefined) {
        const e = gTranscript.safeParse(value);
        if (e.success) handlers.onTranscript(e.data.serverContent.inputTranscription.text, false);
      }
      if (head.data.toolCall !== undefined) {
        const e = gToolCall.safeParse(value);
        if (!e.success) return;
        for (const call of e.data.toolCall.functionCalls) {
          if (call.name !== TOOL_NAME) continue;
          apply(call.args);
          send({
            toolResponse: {
              functionResponses: [{ id: call.id, name: call.name, response: { result: 'ok' } }],
            },
          });
        }
      }
    });
    handlers.onReady(geminiLive.sampleRate);
    return {
      sendAudio: (base64) =>
        send({
          realtimeInput: {
            audio: { data: base64, mimeType: `audio/pcm;rate=${geminiLive.sampleRate}` },
          },
        }),
      sendText: (text) =>
        send({
          clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true },
        }),
      stop: () => send({ clientContent: { turnComplete: true } }),
    };
  },
};

const LIVE_PROVIDERS: Record<string, LiveProvider> = { openai: openaiLive, gemini: geminiLive };

/** The live adapter for a provider's dialect, or null when the relay doesn't support it yet. */
export function liveProvider(provider: string): LiveProvider | null {
  return LIVE_PROVIDERS[provider] ?? null;
}
