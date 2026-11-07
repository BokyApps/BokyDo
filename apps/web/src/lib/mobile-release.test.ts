import { describe, expect, it, vi, afterEach } from 'vitest';
import { fetchMobileRelease, parseMobileRelease } from './mobile-release.js';

const release = {
  version: '0.1.3',
  url: '/downloads/bokydo-0.1.3.apk',
  minAndroid: '8.0',
  sizeBytes: 12_345_678,
  sha256: 'a'.repeat(64),
};

afterEach(() => vi.unstubAllGlobals());

describe('mobile release metadata', () => {
  it('accepts a versioned same-origin release', () => {
    expect(parseMobileRelease(release)).toEqual(release);
  });
  it.each([
    'https://other.example/app.apk',
    '//other.example/app.apk',
    '/downloads/../app.apk',
    '/downloads/%2e%2e/app.apk',
    '/downloads/app.apk?redirect=1',
    'javascript:alert(1)',
  ])('rejects unsafe download URL %s', (url) => {
    expect(() => parseMobileRelease({ ...release, url })).toThrow();
  });
  it.each([
    null,
    {},
    { ...release, sizeBytes: -1 },
    { ...release, sha256: 'bad' },
    { ...release, version: '<script>' },
  ])('rejects malformed metadata', (value) => {
    expect(() => parseMobileRelease(value)).toThrow();
  });
  it('handles a server without hosted downloads (SPA fallback)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('<html>app</html>', { headers: { 'content-type': 'text/html' } }),
        ),
    );
    await expect(fetchMobileRelease(new AbortController().signal)).rejects.toThrow('unavailable');
  });
  it('bypasses browser caches and rejects redirects', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(release));
    vi.stubGlobal('fetch', fetcher);
    await expect(fetchMobileRelease(new AbortController().signal)).resolves.toEqual(release);
    expect(fetcher).toHaveBeenCalledWith(
      '/downloads/android.json',
      expect.objectContaining({ cache: 'no-store', redirect: 'error', credentials: 'omit' }),
    );
  });
});
