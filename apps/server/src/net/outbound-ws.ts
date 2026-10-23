import { parseIp } from '@bokydo/shared';
import type { LookupFunction } from 'node:net';
import { WebSocket, type ClientOptions } from 'ws';
import {
  defaultResolver,
  OutboundError,
  policyLookup,
  type OutboundPolicy,
  type Resolver,
} from './outbound.js';

/** Live provider events are small; a megabyte is generous and bounds a hostile server. */
export const MAX_LIVE_FRAME_BYTES = 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;

/** `ws` forwards unknown options to `net.connect`/`tls.connect`; the types just don't list `lookup`. */
type LiveClientOptions = ClientOptions & { lookup: LookupFunction };

export interface LiveConnectOptions {
  /** Sent on the handshake: this is where the provider key lives, and only here. */
  headers: Record<string, string>;
  policy: OutboundPolicy;
  signal?: AbortSignal;
}

/** Opens one outbound provider socket. Injectable so tests can point at a fake provider. */
export type LiveConnector = (url: string, options: LiveConnectOptions) => Promise<WebSocket>;

const failed = (err: unknown): OutboundError =>
  err instanceof OutboundError ? err : new OutboundError('network');

/**
 * The WebSocket twin of the SSRF-safe HTTP client (ADR 0014). It reaches only `wss:` unless
 * the policy allows plain `ws:` (an admin allow-listed private host), checks every address the
 * name resolves to via the shared `policyLookup` and pins the socket to it, refuses redirects,
 * disables compression (no decompression bombs) and caps frame size and the handshake time.
 * Errors carry a reason code only, never the URL or headers.
 */
export function createLiveConnector(resolve: Resolver = defaultResolver): LiveConnector {
  return (url, { headers, policy, signal }) =>
    new Promise<WebSocket>((resolvePromise, reject) => {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        reject(new OutboundError('invalid_url'));
        return;
      }
      if (parsed.protocol !== 'wss:' && parsed.protocol !== 'ws:') {
        reject(new OutboundError('invalid_url'));
        return;
      }
      if (parsed.protocol === 'ws:' && policy.httpsOnly) {
        reject(new OutboundError('insecure_url'));
        return;
      }
      if (parsed.username || parsed.password || !parsed.hostname) {
        reject(new OutboundError('invalid_url'));
        return;
      }
      const literal = parseIp(parsed.hostname);
      if (literal && !policy.allows(literal, parsed.hostname)) {
        reject(new OutboundError('blocked_address'));
        return;
      }
      let settled = false;
      const ws = new WebSocket(url, {
        headers,
        followRedirects: false,
        perMessageDeflate: false,
        handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
        maxPayload: MAX_LIVE_FRAME_BYTES,
        lookup: policyLookup(policy, resolve),
      } as LiveClientOptions);
      const abort = () => {
        ws.terminate();
        fail(new OutboundError('timeout'));
      };
      const fail = (err: unknown) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        reject(failed(err));
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener('abort', abort, { once: true });
      ws.once('open', () => {
        settled = true;
        signal?.removeEventListener('abort', abort);
        resolvePromise(ws);
      });
      ws.once('error', fail);
      // A non-101 answer (a proxy, a wrong path) is a failure, not something to hand back.
      ws.once('unexpected-response', (_req, res) => {
        res.destroy();
        ws.terminate();
        fail(new OutboundError('network'));
      });
    });
}
