import { instanceStatusSchema } from '@bokydo/shared';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from './test/db.js';
import { testApp, type TestApp } from './test/app.js';

let t: TestApp | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function webRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'bokydo-web-'));
  await writeFile(path.join(dir, 'index.html'), '<!doctype html><title>BokyDo</title>');
  await writeFile(path.join(dir, '.env'), 'SECRET=1');
  return dir;
}

describe.skipIf(!TEST_DATABASE_URL)('HTTP app', () => {
  it('reports liveness and readiness', async () => {
    t = await testApp();
    expect((await t.app.inject('/healthz')).json()).toEqual({ status: 'ok' });
    expect((await t.app.inject('/readyz')).json()).toEqual({ status: 'ok' });
  });

  it('exposes only the public instance status, uncached', async () => {
    t = await testApp();
    const res = await t.app.inject('/api/v1/instance');
    expect(instanceStatusSchema.strict().parse(res.json()).setupComplete).toBe(false);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('sends strict security headers', async () => {
    t = await testApp();
    const { headers } = await t.app.inject('/healthz');
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
    expect(headers['permissions-policy']).toContain('microphone=(self)');
    expect(headers['permissions-policy']).toContain('camera=()');
    // Cross-origin isolation (F-008): the app loads only same-origin resources, so COEP is free.
    expect(headers['cross-origin-embedder-policy']).toBe('require-corp');
    expect(headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(headers['cross-origin-resource-policy']).toBe('same-origin');
    expect(headers['x-powered-by']).toBeUndefined();
    // Off until an HTTPS public URL is confirmed in setup (see settings tests).
    expect(headers['strict-transport-security']).toBeUndefined();
  });

  it('never leaks internal error details', async () => {
    t = await testApp();
    t.app.get('/api/v1/boom', { config: { access: 'public', setup: 'always' } }, async () => {
      throw new Error('password=hunter2 at /app/dist/secret.js');
    });
    const res = await t.app.inject('/api/v1/boom');
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('hunter2');
    expect(res.json()).toEqual({ error: 'internal_error' });
  });

  it('refuses to register an /api route without an access level', async () => {
    t = await testApp();
    expect(() => t!.app.get('/api/v1/oops', async () => ({}))).toThrow(
      /must declare config.access/,
    );
  });

  it('labels client errors by status', async () => {
    t = await testApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        host: 'localhost',
      },
      payload: 'x'.repeat(1024 * 1024 + 1),
    });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('payload_too_large');
  });

  it('rejects prototype-pollution payloads', async () => {
    t = await testApp();
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost',
        host: 'localhost',
      },
      payload: '{"__proto__":{"isAdmin":true},"username":"a","password":"b"}',
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns JSON 404 for unknown API routes and the SPA shell for page navigations', async () => {
    t = await testApp({ webRoot: await webRoot() });
    const api = await t.app.inject({ url: '/api/v1/nope', headers: { accept: 'text/html' } });
    expect(api.statusCode).toBe(404);
    expect(api.json()).toEqual({ error: 'not_found' });
    const page = await t.app.inject({ url: '/today', headers: { accept: 'text/html' } });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<title>BokyDo</title>');
  });

  it('does not serve dotfiles or escape the web root', async () => {
    t = await testApp({ webRoot: await webRoot() });
    for (const url of ['/.env', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd']) {
      const res = await t.app.inject({ url });
      expect(res.body, url).not.toContain('SECRET=1');
      expect(res.body, url).not.toContain('root:');
    }
  });
});
