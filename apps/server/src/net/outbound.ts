import {
  classifyIp,
  embeddedIpv4,
  inCidr,
  parseCidr,
  parseIp,
  type Cidr,
  type ParsedIp,
} from '@bokydo/shared';
import { lookup as dnsLookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import type { LookupFunction } from 'node:net';

/**
 * The one way the server makes HTTP requests to addresses that users or admins chose (AI
 * providers now; webhooks and imports later). It defends against SSRF:
 *  - every address a hostname resolves to is checked, and the socket connects to exactly the
 *    address that was checked (no second lookup, so DNS rebinding can't swap it);
 *  - IP literals are checked the same way (the URL parser has already normalised odd spellings
 *    like 2130706433 or 0x7f.1 to dotted quads);
 *  - loopback, link-local (cloud metadata), unspecified, multicast and reserved ranges are
 *    never reachable; private ranges only through an admin allow-list;
 *  - redirects are never followed, responses are size-capped and time-limited, compression is
 *    not negotiated (no decompression bombs), and proxy environment variables are ignored.
 * Errors carry a reason code only; they never echo URLs or headers, which may hold keys.
 */
export type OutboundErrorReason =
  | 'invalid_url'
  | 'insecure_url'
  | 'blocked_address'
  | 'dns_failed'
  | 'redirect'
  | 'timeout'
  | 'too_large'
  | 'network'
  | 'invalid_response';

export class OutboundError extends Error {
  constructor(readonly reason: OutboundErrorReason) {
    super(`Outbound request failed: ${reason}`);
    this.name = 'OutboundError';
  }
}

export interface OutboundPolicy {
  /** Refuse plain http. */
  httpsOnly: boolean;
  /** Whether a connection to `ip` (reached via `hostname`) is allowed. */
  allows(ip: ParsedIp, hostname: string): boolean;
}

/** Public internet only, https only: for anything a non-admin user configured. */
export const PUBLIC_ONLY: OutboundPolicy = {
  httpsOnly: true,
  allows: (ip) => classifyIp(ip) === 'public',
};

/**
 * Public internet plus the private networks an admin allow-listed (CIDRs, or hostnames whose
 * private addresses are then allowed). Blocked ranges stay blocked whatever the list says.
 */
export function allowlistPolicy(entries: readonly string[]): OutboundPolicy {
  const cidrs: Cidr[] = [];
  const hosts = new Set<string>();
  for (const entry of entries) {
    const cidr = parseCidr(entry);
    if (cidr) cidrs.push(cidr);
    else hosts.add(entry.toLowerCase());
  }
  return {
    httpsOnly: false,
    allows(ip, hostname) {
      const cls = classifyIp(ip);
      if (cls !== 'private') return cls === 'public';
      if (hosts.has(hostname.toLowerCase().replace(/\.$/, ''))) return true;
      const v4 = embeddedIpv4(ip);
      return cidrs.some((c) => inCidr(ip, c) || (v4 !== null && inCidr(v4, c)));
    },
  };
}

export interface OutboundRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string | Buffer;
  /** Whole request, including reading the body (default 30 s). */
  timeoutMs?: number;
  /** Default 10 MiB. */
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export interface OutboundResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  /** The body as it arrives (for streaming); size and time limits still apply. */
  body: AsyncIterable<Buffer>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  /** Stop reading and close the connection. */
  cancel(): void;
}

export type OutboundFetch = (url: string, init?: OutboundRequest) => Promise<OutboundResponse>;

export type Resolver = (hostname: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: Resolver = (hostname) => dnsLookup(hostname, { all: true, verbatim: true });

export function createOutbound(
  policy: OutboundPolicy,
  resolve: Resolver = defaultResolver,
): OutboundFetch {
  return (url, init = {}) => outboundRequest(policy, resolve, url, init);
}

async function outboundRequest(
  policy: OutboundPolicy,
  resolve: Resolver,
  rawUrl: string,
  init: OutboundRequest,
): Promise<OutboundResponse> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OutboundError('invalid_url');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new OutboundError('invalid_url');
  if (url.username || url.password || !url.hostname) throw new OutboundError('invalid_url');
  if (url.protocol === 'http:' && policy.httpsOnly) throw new OutboundError('insecure_url');

  const literal = parseIp(url.hostname);
  if (literal && !policy.allows(literal, url.hostname)) throw new OutboundError('blocked_address');
  // A bracketed host that isn't a valid IPv6 literal would have failed `new URL` already.

  const lookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname).then(
      (found) => {
        const parsed = found.map((a) => ({ ...a, ip: parseIp(a.address) }));
        // Every address must be acceptable: a name that resolves to one public and one
        // internal address is refused rather than racing for the "good" one.
        if (parsed.length === 0 || parsed.some((a) => !a.ip || !policy.allows(a.ip, hostname))) {
          callback(new OutboundError('blocked_address'), '', 0);
          return;
        }
        if (options.all) {
          (callback as unknown as (e: null, a: { address: string; family: number }[]) => void)(
            null,
            parsed.map(({ address, family }) => ({ address, family })),
          );
        } else {
          const [first] = parsed as [(typeof parsed)[number]];
          callback(null, first.address, first.family);
        }
      },
      () => callback(new OutboundError('dns_failed'), '', 0),
    );
  };

  const timeoutMs = init.timeoutMs ?? 30_000;
  const maxBytes = init.maxResponseBytes ?? 10 * 1024 * 1024;
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([deadline, init.signal]) : deadline;
  const body = init.body === undefined ? undefined : Buffer.from(init.body);
  const mod = url.protocol === 'https:' ? https : http;

  return new Promise<OutboundResponse>((resolvePromise, reject) => {
    const fail = (err: unknown) => reject(toOutboundError(err, deadline));
    const req = mod.request(
      {
        protocol: url.protocol,
        hostname: literal ? url.hostname.replace(/^\[|\]$/g, '') : url.hostname,
        port: url.port || undefined,
        path: url.pathname + url.search,
        method: init.method ?? 'GET',
        headers: {
          ...init.headers,
          host: url.host,
          'accept-encoding': 'identity',
          ...(body ? { 'content-length': String(body.length) } : {}),
        },
        agent: false,
        lookup,
        signal,
        // TLS certificate checks stay on; SNI uses the hostname.
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          res.destroy();
          fail(new OutboundError('redirect'));
          return;
        }
        const declared = Number(res.headers['content-length']);
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.destroy();
          fail(new OutboundError('too_large'));
          return;
        }
        const stream = limited(res, maxBytes, deadline);
        const text = async () => {
          const chunks: Buffer[] = [];
          for await (const chunk of stream) chunks.push(chunk);
          return Buffer.concat(chunks).toString('utf8');
        };
        resolvePromise({
          status,
          headers: res.headers,
          body: stream,
          text,
          json: async () => {
            const raw = await text();
            try {
              return JSON.parse(raw) as unknown;
            } catch {
              throw new OutboundError('invalid_response');
            }
          },
          cancel: () => res.destroy(),
        });
      },
    );
    req.on('error', fail);
    req.end(body);
  });
}

async function* limited(
  res: http.IncomingMessage,
  maxBytes: number,
  deadline: AbortSignal,
): AsyncGenerator<Buffer> {
  let total = 0;
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > maxBytes) throw new OutboundError('too_large');
      yield chunk;
    }
  } catch (err) {
    throw toOutboundError(err, deadline);
  } finally {
    res.destroy();
  }
}

function toOutboundError(err: unknown, deadline: AbortSignal): OutboundError {
  if (err instanceof OutboundError) return err;
  if (deadline.aborted) return new OutboundError('timeout');
  // Errors raised inside our lookup arrive wrapped by the socket layer in some Node versions.
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof OutboundError) return cause;
  return new OutboundError('network');
}
