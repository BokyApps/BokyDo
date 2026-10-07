import { AI_PROVIDERS } from '@bokydo/shared';
import { randomBytes } from 'node:crypto';
import { authHeaders, type AiCallContext } from './adapters.js';
import {
  AiProviderError,
  postWithRetry,
  readJson,
  roughTokens,
  type TransportOptions,
} from './transport.js';
import type { ReportedUsage } from './usage.js';

/** Audio formats the speech-to-text endpoints accept, with the file name extension to send. */
export const AUDIO_TYPES: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'mp4',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/flac': 'flac',
};
/** The common upload limit of the hosted speech-to-text APIs. */
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export interface TranscribeRequest {
  audio: Buffer;
  /** One of AUDIO_TYPES (parameters such as `;codecs=opus` are ignored). */
  mimeType: string;
  /** How long the audio is, for metering when the provider doesn't say. */
  durationSeconds: number;
  /** ISO-639-1 hint, e.g. "en". */
  language?: string;
  /** Vocabulary hint: names of projects, people… */
  prompt?: string;
}

export interface TranscribeResult {
  text: string;
  usage: ReportedUsage;
}

const LANGUAGE = /^[a-z]{2,3}$/;

/** "audio/webm;codecs=opus" → "audio/webm". */
const mediaType = (mime: string) => (mime.split(';')[0] ?? '').trim().toLowerCase();

export function checkTranscribeRequest(req: TranscribeRequest): string {
  const type = mediaType(req.mimeType);
  const ext = AUDIO_TYPES[type];
  if (!ext) throw new TypeError('Unsupported audio type');
  if (req.audio.length === 0 || req.audio.length > MAX_AUDIO_BYTES)
    throw new TypeError('Audio too large or empty');
  if (!(req.durationSeconds > 0) || req.durationSeconds > 3600)
    throw new TypeError('Invalid audio duration');
  if (req.language !== undefined && !LANGUAGE.test(req.language))
    throw new TypeError('Invalid language');
  if (req.prompt !== undefined && req.prompt.length > 2000) throw new TypeError('Prompt too long');
  return ext;
}

/**
 * Multipart form body. Field values are ours or validated; the boundary is random, so content
 * can't close a part early.
 */
function multipart(
  fields: Record<string, string>,
  file: { name: string; type: string; data: Buffer },
) {
  const boundary = `bokydo-${randomBytes(16).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields))
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
      ),
    );
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`,
    ),
    file.data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  );
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Speech to text through an OpenAI-style `/audio/transcriptions` endpoint. */
export async function transcribe(
  ctx: AiCallContext,
  req: TranscribeRequest,
  opts: TransportOptions = {},
): Promise<TranscribeResult> {
  const ext = checkTranscribeRequest(req);
  if (AI_PROVIDERS[ctx.credential.provider].dialect !== 'openai')
    throw new TypeError('This provider has no speech-to-text');
  const type = mediaType(req.mimeType);
  // The prompt is user text: strip anything that could break out of the form field.
  const prompt = req.prompt?.replace(/[\r\n"]/g, ' ');
  const { body, contentType } = multipart(
    {
      model: ctx.model,
      response_format: 'json',
      ...(req.language ? { language: req.language } : {}),
      ...(prompt ? { prompt } : {}),
    },
    { name: `audio.${ext}`, type, data: req.audio },
  );
  const res = await postWithRetry(
    ctx,
    {
      url: `${ctx.credential.baseUrl}/audio/transcriptions`,
      headers: { ...authHeaders(ctx.credential), 'content-type': contentType },
      body,
      timeoutMs: 300_000,
      maxResponseBytes: 2 * 1024 * 1024,
    },
    opts,
  );
  const b = (await readJson(res)) as Record<string, unknown> | null;
  if (!b || typeof b.text !== 'string') throw new AiProviderError('invalid_response');
  // Newer models report tokens or seconds; otherwise meter the audio's length.
  const u = (b.usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const seconds = n(b.duration) || (u.type === 'duration' ? n(u.seconds) : 0);
  return {
    text: b.text,
    usage: {
      inputTokens: u.type === 'tokens' ? n(u.input_tokens) : 0,
      outputTokens: u.type === 'tokens' ? n(u.output_tokens) : 0,
      audioSeconds: Math.ceil(seconds || req.durationSeconds),
    },
  };
}

export const MAX_EMBED_INPUTS = 256;
const MAX_EMBED_CHARS = 32_000;
const MAX_DIMENSIONS = 8192;

export interface EmbedResult {
  vectors: number[][];
  usage: ReportedUsage;
}

export function checkEmbedRequest(texts: string[]): void {
  if (texts.length === 0 || texts.length > MAX_EMBED_INPUTS)
    throw new TypeError('Embed 1–256 texts');
  if (texts.some((t) => t.length === 0 || t.length > MAX_EMBED_CHARS))
    throw new TypeError('Embedding input empty or too long');
}

const isVector = (v: unknown): v is number[] =>
  Array.isArray(v) &&
  v.length > 0 &&
  v.length <= MAX_DIMENSIONS &&
  v.every((x) => typeof x === 'number' && Number.isFinite(x));

/** Embeddings for `texts`, in order. */
export async function embed(
  ctx: AiCallContext,
  texts: string[],
  opts: TransportOptions = {},
): Promise<EmbedResult> {
  checkEmbedRequest(texts);
  const { credential } = ctx;
  const dialect = AI_PROVIDERS[credential.provider].dialect;
  const headers = { ...authHeaders(credential), 'content-type': 'application/json' };
  const chars = texts.reduce((n, t) => n + t.length, 0);
  const request = { headers, timeoutMs: 60_000, maxResponseBytes: 64 * 1024 * 1024 };
  let vectors: unknown[];
  let inputTokens = 0;
  if (dialect === 'gemini') {
    const name = ctx.model.replace(/^models\//, '');
    const model = `models/${name}`;
    const res = await postWithRetry(
      ctx,
      {
        ...request,
        url: `${credential.baseUrl}/models/${encodeURIComponent(name)}:batchEmbedContents`,
        body: JSON.stringify({
          requests: texts.map((text) => ({ model, content: { parts: [{ text }] } })),
        }),
      },
      opts,
    );
    const b = (await readJson(res)) as { embeddings?: { values?: unknown }[] } | null;
    vectors = Array.isArray(b?.embeddings) ? b.embeddings.map((e) => e?.values) : [];
  } else if (dialect === 'openai') {
    const res = await postWithRetry(
      ctx,
      {
        ...request,
        url: `${credential.baseUrl}/embeddings`,
        body: JSON.stringify({ model: ctx.model, input: texts, encoding_format: 'float' }),
      },
      opts,
    );
    const b = (await readJson(res)) as {
      data?: { index?: unknown; embedding?: unknown }[];
      usage?: { prompt_tokens?: unknown };
    } | null;
    const data = Array.isArray(b?.data) ? b.data : [];
    // Results carry their index; don't trust the order.
    // Filled (not sparse), so a missing index fails the check below: `every` skips holes.
    vectors = Array.from({ length: texts.length }, () => undefined as unknown);
    for (const d of data) {
      const i = d?.index;
      if (typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < texts.length)
        vectors[i] = d.embedding;
    }
    const t = b?.usage?.prompt_tokens;
    if (typeof t === 'number' && Number.isFinite(t)) inputTokens = t;
  } else {
    throw new TypeError('This provider has no embeddings');
  }
  if (
    vectors.length !== texts.length ||
    !vectors.every(isVector) ||
    vectors.some((v) => v.length !== (vectors[0] as number[]).length)
  )
    throw new AiProviderError('invalid_response');
  return {
    vectors: vectors as number[][],
    usage: { inputTokens: inputTokens || roughTokens(chars), outputTokens: 0, audioSeconds: 0 },
  };
}
