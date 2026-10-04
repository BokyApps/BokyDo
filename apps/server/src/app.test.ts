import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { instanceStatusSchema } from '@bokydo/shared';
import { buildApp, type AppDeps } from './app.js';

const fakeDb = (opts: { up?: boolean; setupComplete?: boolean } = {}): AppDeps['db'] => {
  const rows = opts.setupComplete === undefined ? [] : [{ value: opts.setupComplete }];
  const chain = { from: () => chain, where: async () => rows };
  return {
    sql: (async () => {
      if (opts.up === false) throw new Error('down');
      return [];
    }) as unknown as AppDeps['db']['sql'],
    db: { select: () => chain } as unknown as AppDeps['db']['db'],
  };
};

let app: FastifyInstance;
afterEach(async () => app?.close());

async function webRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bokydo-web-'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>BokyDo</title>');
  await writeFile(path.join(dir, '.env'), 'SECRET=1');
  return dir;
}

describe('HTTP app', () => {
  it('reports liveness and readiness', async () => {
    app = await buildApp({ db: fakeDb({ up: false }), webRoot: null });
    expect((await app.inject('/healthz')).json()).toEqual({ status: 'ok' });
    const ready = await app.inject('/readyz');
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toEqual({ status: 'unavailable' });
  });

  it('exposes only the public instance status', async () => {
    app = await buildApp({ db: fakeDb({ setupComplete: false }), webRoot: null });
    const res = await app.inject('/api/v1/instance');
    expect(instanceStatusSchema.strict().parse(res.json()).setupComplete).toBe(false);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sends strict security headers', async () => {
    app = await buildApp({ db: fakeDb(), webRoot: null });
    const { headers } = await app.inject('/healthz');
    const csp = String(headers['content-security-policy']);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).not.toContain('unsafe-inline');
    expect(csp).not.toContain('unsafe-eval');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('DENY');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['permissions-policy']).toContain('microphone=()');
    expect(headers['x-powered-by']).toBeUndefined();
    // Off until an HTTPS public URL is confirmed in setup.
    expect(headers['strict-transport-security']).toBeUndefined();
  });

  it('never leaks internal error details', async () => {
    app = await buildApp({ db: fakeDb(), webRoot: null });
    app.get('/api/v1/boom', async () => {
      throw new Error('password=hunter2 at /app/dist/secret.js');
    });
    const res = await app.inject('/api/v1/boom');
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.json()).toEqual({ error: 'internal_error' });
  });

  it('labels client errors by status', async () => {
    app = await buildApp({ db: fakeDb(), webRoot: null });
    app.post('/api/v1/echo', async () => ({}));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      payload: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('payload_too_large');
  });

  it('rejects prototype-pollution payloads', async () => {
    app = await buildApp({ db: fakeDb(), webRoot: null });
    app.post('/api/v1/echo', async (req) => req.body);
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{"__proto__":{"isAdmin":true}}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns JSON 404 for unknown API routes and SPA shell for page navigations', async () => {
    app = await buildApp({ db: fakeDb(), webRoot: await webRoot() });
    const api = await app.inject({ url: '/api/v1/nope', headers: { accept: 'text/html' } });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: 'not_found' });

    const page = await app.inject({ url: '/today', headers: { accept: 'text/html' } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>BokyDo</title>');
  });

  it('does not serve dotfiles or escape the web root', async () => {
    app = await buildApp({ db: fakeDb(), webRoot: await webRoot() });
    for (const url of ['/.env', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd']) {
      const res = await app.inject({ url });
      expect(res.body, url).not.toContain('SECRET=1');
      expect(res.body, url).not.toContain('root:');
    }
  });

  it('ignores X-Forwarded-For by default', async () => {
    app = await buildApp({ db: fakeDb(), webRoot: null });
    app.get('/api/v1/ip', async (req) => ({ ip: req.ip }));
    const res = await app.inject({ url: '/api/v1/ip', headers: { 'x-forwarded-for': '6.6.6.6' } });
    expect(res.json().ip).not.toBe('6.6.6.6');
  });
});
