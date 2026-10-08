import { randomInt } from 'node:crypto';
import { OutboundError, type OutboundErrorReason, type OutboundResponse } from '../net/outbound.js';
import type { AiCallContext } from './adapters.js';
import type { ReportedUsage } from './usage.js';

/**
 * Why a provider call failed, as a code. The provider's response body is never kept: error
 * bodies often echo the request, and some echo (part of) the key.
 */
export type AiErrorCode =
  | 'unauthorized'
  | 'rate_limited'
  | 'not_found'
  | 'bad_request'
  | 'unavailable'
  | 'unexpected_status'
  | 'invalid_response'
  | 'output_invalid'
  | 'refused'
  | 'cancelled'
  /** A subscription sign-in can't be renewed: the user has to sign in again (W7d). */
  | 'sign_in_expired'
  | OutboundErrorReason;

export const NO_USAGE: ReportedUsage = { inputTokens: 0, outputTokens: 0, audioSeconds: 0 };

/** A failed provider call. Carries what the call still consumed, for metering. */
export class AiProviderError extends Error {
  constructor(
    readonly code: AiErrorCode,
    readonly status?: number,
    readonly usage: ReportedUsage = NO_USAGE,
  ) {
    super(`AI provider call failed: ${code}${status ? ` (${status})` : ''}`);
    this.name = 'AiProviderError';
  }
}

/** Statuses worth another attempt. 529 is Anthropic's "overloaded". */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);
export const MAX_ATTEMPTS = 3;
/** A provider asking us to wait longer than this gets a rate_limited error instead. */
const MAX_RETRY_AFTER_MS = 20_000;

export interface TransportOptions {
  /** Tests only: replaces the backoff timer. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new AiProviderError('cancelled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AiProviderError('cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/** Retry-After as seconds or an HTTP date; null when absent or unreadable. */
export function retryAfterMs(
  value: string | string[] | undefined,
  now = Date.now(),
): number | null {
  const v = Array.isArray(value) ? value[0] : value;
  if (!v) return null;
  if (/^\d+(\.\d+)?$/.test(v.trim())) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string | Buffer;
  timeoutMs: number;
  maxResponseBytes: number;
}

/**
 * POST to a provider through the call's outbound client, retrying throttling, server errors and
 * dropped connections with capped exponential backoff (honouring Retry-After). Only the request
 * phase is retried: once a 2xx response is handed back, the caller owns it. Other statuses become
 * an AiProviderError with the body discarded unread.
 */
export async function postWithRetry(
  ctx: Pick<AiCallContext, 'fetch' | 'signal'>,
  req: ProviderRequest,
  opts: TransportOptions = {},
): Promise<OutboundResponse> {
  const sleep = opts.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt++) {
    let res: OutboundResponse;
    try {
      res = await ctx.fetch(req.url, {
        method: 'POST',
        headers: req.headers,
        body: req.body,
        timeoutMs: req.timeoutMs,
        maxResponseBytes: req.maxResponseBytes,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      });
    } catch (err) {
      if (ctx.signal?.aborted) throw new AiProviderError('cancelled');
      if (!(err instanceof OutboundError)) throw err;
      // Only a dropped connection is worth retrying; policy refusals and timeouts are not.
      if (err.reason !== 'network' || attempt >= MAX_ATTEMPTS)
        throw new AiProviderError(err.reason);
      await sleep(backoff(attempt), ctx.signal);
      continue;
    }
    if (res.status >= 200 && res.status < 300) return res;
    res.cancel();
    if (RETRY_STATUS.has(res.status) && attempt < MAX_ATTEMPTS) {
      const wait = retryAfterMs(res.headers['retry-after']);
      if (wait === null || wait <= MAX_RETRY_AFTER_MS) {
        await sleep(wait ?? backoff(attempt), ctx.signal);
        continue;
      }
    }
    throw new AiProviderError(statusCode(res.status), res.status);
  }
}

/** 0.5 s, 1 s, … with jitter, capped at 8 s. */
function backoff(attempt: number): number {
  const base = Math.min(8_000, 500 * 2 ** (attempt - 1));
  return base / 2 + randomInt(base / 2 + 1);
}

function statusCode(status: number): AiErrorCode {
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 429) return 'rate_limited';
  if (status === 404) return 'not_found';
  if (status === 400 || status === 413 || status === 422) return 'bad_request';
  if (status >= 500) return 'unavailable';
  return 'unexpected_status';
}

/** Read a JSON body, turning transport failures into AiProviderErrors. */
export async function readJson(res: OutboundResponse): Promise<unknown> {
  try {
    return await res.json();
  } catch (err) {
    if (err instanceof OutboundError) throw new AiProviderError(err.reason);
    throw err;
  }
}

export interface SseEvent {
  event: string | null;
  data: string;
}

const MAX_EVENT_BYTES = 1024 * 1024;

/**
 * Server-sent events from a streamed response body. Comments and unknown fields are ignored; one
 * event may not exceed 1 MiB (the response as a whole is capped by the outbound client).
 */
export async function* sseEvents(body: AsyncIterable<Buffer>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  let event: string | null = null;
  let data: string[] = [];
  let size = 0;
  const lines = function* (final: boolean) {
    for (;;) {
      const nl = buffer.search(/\r\n|\r|\n/);
      if (nl === -1) break;
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + (buffer.startsWith('\r\n', nl) ? 2 : 1));
      yield line;
    }
    if (final && buffer) {
      const line = buffer;
      buffer = '';
      yield line;
    }
  };
  const take = function* (final: boolean): Generator<SseEvent> {
    for (const line of lines(final)) {
      if (line === '') {
        if (data.length) yield { event, data: data.join('\n') };
        event = null;
        data = [];
        size = 0;
        continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') event = value;
      else if (field === 'data') {
        size += value.length;
        if (size > MAX_EVENT_BYTES) throw new AiProviderError('invalid_response');
        data.push(value);
      }
    }
    if (final && data.length) yield { event, data: data.join('\n') };
  };
  try {
    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      if (buffer.length > MAX_EVENT_BYTES) {
        // A single line this long is not a real event.
        const nl = buffer.search(/\r|\n/);
        if (nl === -1) throw new AiProviderError('invalid_response');
      }
      yield* take(false);
    }
    buffer += decoder.decode();
    yield* take(true);
  } catch (err) {
    if (err instanceof OutboundError) throw new AiProviderError(err.reason);
    throw err;
  }
}

/** Parse an event's JSON payload; a malformed event fails the call. */
export function eventJson(data: string): unknown {
  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new AiProviderError('invalid_response');
  }
}

/** Rough token count for text a provider didn't meter (about 4 characters per token). */
export const roughTokens = (chars: number) => Math.ceil(chars / 4);
