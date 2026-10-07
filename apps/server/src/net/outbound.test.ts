import { parseIp, type ParsedIp } from '@bokydo/shared';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowlistPolicy,
  createOutbound,
  OutboundError,
  PUBLIC_ONLY,
  type OutboundPolicy,
  type Resolver,
} from './outbound.js';

const ip = (s: string) => parseIp(s)!;

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof OutboundError) return err.reason;
    throw err;
  }
  return 'no error';
}

const fakeDns =
  (table: Record<string, string[]>): Resolver =>
  async (host) => {
    const found = table[host];
    if (!found) throw new Error('ENOTFOUND');
    return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

describe('PUBLIC_ONLY policy', () => {
  const fetch = createOutbound(
    PUBLIC_ONLY,
    fakeDns({
      'internal.example': ['10.0.0.5'],
      'rebind.example': ['93.184.215.14', '127.0.0.1'],
      'mapped.example': ['::ffff:169.254.169.254'],
    }),
  );

  it('refuses unsafe URLs before connecting', async () => {
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request -- asserts plain http is refused
    expect(await reason(fetch('http://example.com/'))).toBe('insecure_url');
    expect(await reason(fetch('https://user:pw@example.com/'))).toBe('invalid_url');
    expect(await reason(fetch('file:///etc/passwd'))).toBe('invalid_url');
    expect(await reason(fetch('not a url'))).toBe('invalid_url');
  });

  it('refuses internal IP literals in any spelling', async () => {
    for (const url of [
      'https://127.0.0.1/',
      'https://2130706433/', // 127.0.0.1 as an integer
      'https://0x7f.1/',
      'https://[::1]/',
      'https://[::ffff:7f00:1]/',
      'https://169.254.169.254/latest/meta-data/',
      'https://10.1.2.3/',
      'https://[fd00::1]/',
      'https://0.0.0.0/',
    ]) {
      expect(await reason(fetch(url)), url).toBe('blocked_address');
    }
  });

  it('checks every resolved address, including mapped IPv6', async () => {
    expect(await reason(fetch('https://internal.example/'))).toBe('blocked_address');
    expect(await reason(fetch('https://rebind.example/'))).toBe('blocked_address');
    expect(await reason(fetch('https://mapped.example/'))).toBe('blocked_address');
    expect(await reason(fetch('https://missing.example/'))).toBe('dns_failed');
  });
});

describe('allowlistPolicy', () => {
  const allows = (p: OutboundPolicy, addr: string, host = 'x.example') => p.allows(ip(addr), host);

  it('opens only the listed private networks', () => {
    const p = allowlistPolicy(['192.168.1.0/24', 'ollama']);
    expect(allows(p, '8.8.8.8')).toBe(true);
    expect(allows(p, '192.168.1.40')).toBe(true);
    expect(allows(p, '::ffff:192.168.1.40')).toBe(true);
    expect(allows(p, '192.168.2.40')).toBe(false);
    expect(allows(p, '172.18.0.3', 'ollama')).toBe(true);
    expect(allows(p, '172.18.0.3', 'OLLAMA.')).toBe(true);
    expect(allows(p, '172.18.0.3', 'other')).toBe(false);
    expect(p.httpsOnly).toBe(false);
  });

  it('never opens loopback, link-local or metadata addresses', () => {
    const p = allowlistPolicy(['127.0.0.0/8', '169.254.0.0/16', '::/0', '0.0.0.0/0', 'metadata']);
    for (const addr of ['127.0.0.1', '169.254.169.254', '::1', 'fe80::1', 'fd00:ec2::254']) {
      expect(allows(p, addr, 'metadata'), addr).toBe(false);
    }
  });
});

describe('transport', () => {
  let server: http.Server;
  let port = 0;
  const seen: {
    url: string | undefined;
    host: string | undefined;
    encoding: string | undefined;
  }[] = [];
  // Test-only policy: the local test server is the one reachable address.
  const loopbackOnly: OutboundPolicy = {
    httpsOnly: false,
    allows: (a: ParsedIp) => a.version === 4 && a.bytes.join('.') === '127.0.0.1',
  };
  const fetch = createOutbound(
    loopbackOnly,
    fakeDns({ 'api.example.test': ['127.0.0.1'], 'two.example.test': ['127.0.0.1', '10.0.0.1'] }),
  );
  const base = () => `http://api.example.test:${port}`;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, host: req.headers.host, encoding: req.headers['accept-encoding'] });
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
      } else if (req.url === '/big') {
        res.writeHead(200, { 'content-length': '5000' }).end('x'.repeat(5000));
      } else if (req.url === '/stream') {
        res.writeHead(200);
        for (let i = 0; i < 10; i++) res.write('y'.repeat(1000));
        res.end();
      } else if (req.url === '/hang') {
        // never answers
      } else {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      }
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });

  it('connects to the vetted address and keeps the requested Host', async () => {
    const res = await fetch(`${base()}/ok`, { headers: { host: 'evil.example', 'x-test': '1' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const last = seen.at(-1)!;
    expect(last.host).toBe(`api.example.test:${port}`);
    expect(last.encoding).toBe('identity');
  });

  it('refuses a name with any unacceptable address', async () => {
    expect(await reason(fetch(`http://two.example.test:${port}/ok`))).toBe('blocked_address');
  });

  it('never follows redirects', async () => {
    const before = seen.length;
    expect(await reason(fetch(`${base()}/redirect`))).toBe('redirect');
    expect(seen.length).toBe(before + 1);
  });

  it('caps response size, declared or streamed', async () => {
    expect(await reason(fetch(`${base()}/big`, { maxResponseBytes: 1000 }))).toBe('too_large');
    const res = await fetch(`${base()}/stream`, { maxResponseBytes: 5000 });
    expect(await reason(res.text())).toBe('too_large');
  });

  it('times out', async () => {
    expect(await reason(fetch(`${base()}/hang`, { timeoutMs: 200 }))).toBe('timeout');
  });
});
