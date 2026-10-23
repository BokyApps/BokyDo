import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

interface FakeUrl {
  origin: string;
  pathname: string;
}
type ShouldIntercept = (url: FakeUrl, method: string) => boolean;

const ORIGIN = 'https://bokydo.example';

/** Load the real public/sw.js in a sandbox and read back the routing function it exposes. */
function loadWorker(): { shouldIntercept: ShouldIntercept; source: string } {
  const source = readFileSync(
    fileURLToPath(new URL('../../public/sw.js', import.meta.url)),
    'utf8',
  );
  const sandbox = {
    self: {
      location: { origin: ORIGIN },
      addEventListener: () => undefined,
      clients: { claim: () => undefined },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  const api = (sandbox.self as { BokyDoSW?: { shouldIntercept: ShouldIntercept } }).BokyDoSW;
  if (!api) throw new Error('sw.js did not expose the routing function');
  return { shouldIntercept: api.shouldIntercept, source };
}

const url = (pathname: string): FakeUrl => ({ origin: ORIGIN, pathname });

describe('service worker routing', () => {
  const { shouldIntercept } = loadWorker();

  it('never intercepts private API and protocol paths', () => {
    for (const path of [
      '/api',
      '/api/',
      '/api/v1/sync',
      '/api/v1/attachments/abc',
      '/mcp',
      '/mcp/',
      '/oauth/token',
      '/oauth/authorize',
      '/.well-known/oauth-authorization-server',
      '/healthz',
      '/readyz',
    ]) {
      expect(shouldIntercept(url(path), 'GET'), path).toBe(false);
    }
  });

  it('does not confuse a look-alike path with a reserved prefix', () => {
    expect(shouldIntercept(url('/apixyz'), 'GET')).toBe(true);
    expect(shouldIntercept(url('/oauth2'), 'GET')).toBe(true);
    expect(shouldIntercept(url('/healthz-ish'), 'GET')).toBe(true);
  });

  it('ignores non-GET and cross-origin requests', () => {
    expect(shouldIntercept(url('/today'), 'POST')).toBe(false);
    expect(shouldIntercept(url('/assets/app.js'), 'PUT')).toBe(false);
    expect(
      shouldIntercept({ origin: 'https://evil.example', pathname: '/assets/app.js' }, 'GET'),
    ).toBe(false);
  });

  it('intercepts the shell, hashed assets and navigations', () => {
    for (const path of ['/', '/index.html', '/assets/index-abc.js', '/favicon.svg', '/today']) {
      expect(shouldIntercept(url(path), 'GET'), path).toBe(true);
    }
  });
});

describe('service worker contents', () => {
  it('keeps the push handlers untouched', () => {
    const { source } = loadWorker();
    expect(source).toContain("addEventListener('push'");
    expect(source).toContain('showNotification');
    expect(source).toContain("addEventListener('notificationclick'");
  });

  it('has versioned shell caching and the SKIP_WAITING message hook', () => {
    const { source } = loadWorker();
    expect(source).toContain('bokydo-shell-');
    expect(source).toContain('SKIP_WAITING');
  });
});
