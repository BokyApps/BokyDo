// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  browserSupportsCredentialless,
  parseEmbedUrl,
  supportsCredentialless,
  EMBED_LINE,
} from './embed.js';

describe('parseEmbedUrl — allow-listed (good)', () => {
  const good: [string, 'youtube' | 'drive', string][] = [
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=___________', 'youtube', '___________'],
    ['https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view', 'drive', '1AbCdEfGhIjKlMn'],
    ['https://drive.google.com/file/d/1AbCdEfGhIjKlMn/preview', 'drive', '1AbCdEfGhIjKlMn'],
    ['https://drive.google.com/file/d/1234567890', 'drive', '1234567890'],
  ];
  for (const [url, provider, id] of good) {
    it(`accepts ${url}`, () => {
      const embed = parseEmbedUrl(url);
      expect(embed).not.toBeNull();
      expect(embed!.provider).toBe(provider);
      expect(embed!.id).toBe(id);
      expect(embed!.embedUrl.startsWith('https://')).toBe(true);
      expect(embed!.openUrl.startsWith('https://')).toBe(true);
    });
  }

  it('rewrites YouTube to the no-cookie embed host', () => {
    expect(parseEmbedUrl('https://youtu.be/dQw4w9WgXcQ')!.embedUrl).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });

  it('rewrites Drive to the /preview embed URL', () => {
    expect(parseEmbedUrl('https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view')!.embedUrl).toBe(
      'https://drive.google.com/file/d/1AbCdEfGhIjKlMn/preview',
    );
  });
});

describe('parseEmbedUrl — rejected (bad)', () => {
  const bad = [
    'http://www.youtube.com/watch?v=dQw4w9WgXcQ', // http
    'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ', // suffix trick
    'https://evilyoutube.com/watch?v=dQw4w9WgXcQ', // prefix trick
    'https://notyoutube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com@evil.com/watch?v=dQw4w9WgXcQ', // user@host userinfo
    'https://evil.com@youtube.com/watch?v=dQw4w9WgXcQ', // user@host userinfo
    'https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com:8443/watch?v=dQw4w9WgXcQ', // explicit port
    'https://www.youtube.com/watch?v=short', // id too short
    'https://www.youtube.com/watch?v=dQw4w9WgXc', // 10 chars
    'https://www.youtube.com/watch?v=dQw4w9WgXcQQ', // 12 chars
    'https://youtu.be/dQw4w9WgXcQextra',
    'https://youtu.be/short',
    'https://www.youtube.com/shorts/short',
    'https://www.youtube.com/watch', // no v=
    'https://www.youtube.com/watch?v=dQw4w9WgXc!', // illegal char in id
    'https://example.com/watch?v=dQw4w9WgXcQ', // wrong host
    'https://drive.google.com/file/d/short/view', // drive id too short
    'https://drive.google.com/other/d/1AbCdEfGhIjKlMn/view', // wrong path
    'https://drive.google.com/uc?id=1AbCdEfGhIjKlMn', // wrong path
    'ftp://youtube.com/watch?v=dQw4w9WgXcQ',
    'javascript:alert(1)',
    'not a url',
    '',
    'https://www.youtube.com/watch?v=' + 'a'.repeat(12),
  ];
  for (const url of bad) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      expect(parseEmbedUrl(url)).toBeNull();
    });
  }
});

describe('EMBED_LINE', () => {
  it('matches a paragraph that is solely an embed', () => {
    const m = EMBED_LINE.exec('::embed[My label](https://youtu.be/dQw4w9WgXcQ)');
    expect(m?.[1]).toBe('My label');
    expect(m?.[2]).toBe('https://youtu.be/dQw4w9WgXcQ');
  });
  it('does not match a paragraph with trailing text', () => {
    expect(EMBED_LINE.test('::embed[x](https://youtu.be/dQw4w9WgXcQ) trailing')).toBe(false);
  });
});

describe('credentialless decision', () => {
  it('is a pure function of the prototype', () => {
    expect(supportsCredentialless({})).toBe(false);
    expect(supportsCredentialless({ credentialless: true })).toBe(true);
    expect(supportsCredentialless(HTMLIFrameElementDummy())).toBe(true);
  });
  it('never throws in a headless environment', () => {
    expect(typeof browserSupportsCredentialless()).toBe('boolean');
  });
});

function HTMLIFrameElementDummy(): object {
  return { credentialless: false };
}
