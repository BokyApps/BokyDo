import { describe, expect, it } from 'vitest';
import {
  CENSOR_PLACEHOLDER,
  notePatchSchema,
  notePatchWrites,
  noteSnippet,
  normaliseNoteTags,
  parseCensorToken,
  parseEmbedUrl,
  redactCensored,
  toSearchText,
  utf8Length,
} from './notes.js';

const SALT = 'A'.repeat(22);
const IV = 'B'.repeat(16);
const token = (ciphertext: string) => `{{censored:v1:${SALT}:${IV}:${ciphertext}}}`;

describe('note tags', () => {
  it('trims, lower-cases and de-duplicates in order', () => {
    expect(normaliseNoteTags([' Work ', 'work', 'Ideas', '  ', 'idea'])).toEqual([
      'work',
      'ideas',
      'idea',
    ]);
    expect(normaliseNoteTags(['same', 'same', 'same'])).toEqual(['same']);
    expect(normaliseNoteTags([])).toEqual([]);
  });

  it('rejects forbidden characters, lengths and counts', () => {
    expect(normaliseNoteTags(['#tag'])).toBeNull();
    expect(normaliseNoteTags(['a,b'])).toBeNull();
    expect(normaliseNoteTags(['two words'])).toBeNull();
    expect(normaliseNoteTags(['x'.repeat(51)])).toBeNull();
    expect(normaliseNoteTags(['ok', 'control\u0000char'])).toBeNull();
    expect(normaliseNoteTags(Array.from({ length: 21 }, (_, i) => `tag-${i}`))).toBeNull();
    // Exactly at the limits is fine.
    expect(normaliseNoteTags(['x'.repeat(50)])).toEqual(['x'.repeat(50)]);
    expect(normaliseNoteTags(Array.from({ length: 20 }, (_, i) => `tag-${i}`))).toHaveLength(20);
  });
});

describe('note patch revisions', () => {
  it('takes only a canonical instant as expectedUpdatedAt, and never as the only field', () => {
    const canonical = '2026-11-18T12:00:00.000Z';
    expect(notePatchSchema.safeParse({ title: 'x', expectedUpdatedAt: canonical }).success).toBe(
      true,
    );
    for (const value of [
      '2026-11-18T12:00:00Z',
      '2026-11-18T12:00:00.000+00:00',
      '2026-11-18T12:00:00.000+01:00',
      '2026-11-18 12:00:00.000Z',
      '2026-11-18',
      'now',
      '',
      '2026-13-18T12:00:00.000Z',
    ])
      expect(
        notePatchSchema.safeParse({ title: 'x', expectedUpdatedAt: value }).success,
        value,
      ).toBe(false);
    // The precondition alone changes nothing, so it is not a patch.
    expect(notePatchSchema.safeParse({ expectedUpdatedAt: canonical }).success).toBe(false);
    expect(notePatchWrites({ expectedUpdatedAt: canonical })).toBe(false);
    expect(notePatchWrites({ expectedUpdatedAt: canonical, body: '' })).toBe(true);
  });
});

describe('search text and snippets', () => {
  it('keeps words, labels and tags but drops Markdown, URLs and censor tokens', () => {
    const text = toSearchText(
      'Trip #plans',
      ['travel', '2026'],
      [
        '# Heading',
        `Secret: ${token('c2VjcmV0cGhyYXNl')} end.`,
        'See [the site](https://evil.example/secret) and https://also.example/hidden.',
        'Mail mailto:hidden@example.com or visit www.hidden.example/path.',
        `![alt text](/api/v1/note-files/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e)`,
        '**bold** `code` _italic_',
      ].join('\n'),
    );
    for (const hidden of [
      'censored',
      'c2VjcmV0',
      'evil',
      'also',
      'note-files',
      'Heading #',
      'hidden',
    ])
      expect(text).not.toContain(hidden);
    for (const kept of [
      'Trip',
      'plans',
      'travel',
      '2026',
      'Secret',
      'end',
      'the',
      'site',
      'alt',
      'text',
      'bold',
      'code',
      'italic',
    ])
      expect(text).toContain(kept);
    expect(text).not.toContain('  ');
  });

  it('replaces valid censor tokens in snippets and bounds their length', () => {
    const body = `${token('c2VjcmV0')} ${'word '.repeat(200)}`;
    const snippet = noteSnippet(body);
    expect(snippet.startsWith(CENSOR_PLACEHOLDER)).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(200);
    expect(snippet).not.toContain('c2VjcmV0');
  });

  it('handles a body at the size limit quickly', () => {
    const body =
      'some words and [a link](bokydo:note/0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b) '.repeat(6000);
    const started = performance.now();
    const text = toSearchText('title', ['tag'], body);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(text).toContain('some words');
  });

  it('measures UTF-8 bytes, not UTF-16 units', () => {
    expect(utf8Length('abc')).toBe(3);
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('😀')).toBe(4);
  });
});

describe('censor tokens', () => {
  it('parses the v1 shape', () => {
    expect(parseCensorToken(token('abc'))).toEqual({ salt: SALT, iv: IV, ciphertext: 'abc' });
    const atLimit = token('A'.repeat(87_382));
    expect(parseCensorToken(atLimit)?.ciphertext.length).toBe(87_382);
    expect(parseCensorToken(token('A'.repeat(87_383)))).toBeNull();
  });

  it('rejects wrong versions, padding, part sizes and empty ciphertexts', () => {
    for (const bad of [
      `{{censored:v2:${SALT}:${IV}:abc}}`,
      `{{censored:v1:${SALT}=:${IV}:abc}}`,
      `{{censored:v1:${SALT}:${IV}:ab=}}`,
      `{{censored:v1:${'A'.repeat(21)}:${IV}:abc}}`,
      `{{censored:v1:${SALT}:${'B'.repeat(15)}:abc}}`,
      `{{censored:v1:${SALT}:${IV}:}}`,
      `{{censored:v1:${SALT}:${IV}:abc`,
      `{{censored:v1:${SALT}:${IV}:abc}} trailing`,
      `{{censored:v1:${SALT}:${IV}:ab!c}}`,
      '',
    ])
      expect(parseCensorToken(bad), bad).toBeNull();
  });

  it('redacts valid tokens and malformed look-alikes alike', () => {
    const text = `before ${token('c2VjcmV0')} after`;
    expect(redactCensored(text)).toBe(`before ${CENSOR_PLACEHOLDER} after`);
    // Lenient on purpose: a hand-edited token must not leak its ciphertext-looking middle.
    expect(redactCensored('{{censored:v1:not:a:token}}')).toBe(CENSOR_PLACEHOLDER);
    expect(redactCensored(token('c2VjcmV0'))).toBe(CENSOR_PLACEHOLDER);
  });

  it('accepts any case and optional whitespace after the braces', () => {
    for (const text of [
      '{{CENSORED}}',
      '{{Censored}}',
      '{{   censored}}',
      '{{\n\tCENSORED:v1:x}}',
      '{{  censored:v1:not:a:token}}',
      '{{censoredsecret}}',
      'x{{{censored:y}}z',
    ])
      expect(redactCensored(text), text).toContain(CENSOR_PLACEHOLDER);
    expect(redactCensored('x{{{censored:y}}z')).toBe(`x{${CENSOR_PLACEHOLDER}z`);
  });

  it('leaves ordinary braces and similar words alone', () => {
    for (const text of [
      'a {{ b }} c',
      '{{canceled}}',
      '{{ censors }}',
      'plain {text} and }} stray',
      '',
    ])
      expect(redactCensored(text), text).toBe(text);
  });

  it('without a closer, redacts to the end of the text', () => {
    expect(redactCensored('{{censored')).toBe(CENSOR_PLACEHOLDER);
    expect(redactCensored('{{censored:abc')).toBe(CENSOR_PLACEHOLDER);
    // Words after an unclosed opener may be the span's own: they go too.
    expect(redactCensored('before {{censored secret words')).toBe(`before ${CENSOR_PLACEHOLDER}`);
    // A closer, however far away, ends the span: words with spaces before it never leak.
    const far = `{{censored secret words ${'a '.repeat(80_000)}}} tail`;
    expect(redactCensored(far)).toBe(`${CENSOR_PLACEHOLDER} tail`);
  });

  it('never indexes malformed censored text for search', () => {
    for (const body of [
      'keep {{ CENSORED secret words }} keep',
      'keep {{Censored:v1:secret}} keep',
      'keep {{censored secret words',
    ]) {
      const text = toSearchText('title', ['tag'], body);
      expect(text, body).not.toMatch(/secret|words/);
      expect(text).toContain('keep');
    }
    // An unclosed span in the title does not swallow the body.
    expect(toSearchText('{{censored oops', [], 'body text')).toContain('body text');
  });

  it('scans a hostile megabyte in well under 200 ms', () => {
    for (const body of [
      '{{censored '.repeat(100_000),
      '{{'.repeat(500_000),
      `${'{{censored '.repeat(50_000)}${'a'.repeat(500_000)}}}`,
      `{{censored${'x'.repeat(1024 * 1024)}}}`,
    ]) {
      const started = performance.now();
      const redacted = redactCensored(body);
      expect(performance.now() - started).toBeLessThan(200);
      expect(redacted).not.toContain('censored');
    }
  });
});

describe('embeds', () => {
  it('recognises the allow-listed YouTube forms and canonicalises them', () => {
    const expected = {
      provider: 'youtube',
      id: 'dQw4w9WgXcQ',
      embedUrl: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
      openUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    };
    for (const url of [
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s',
      'https://m.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ',
      'https://youtu.be/dQw4w9WgXcQ?t=1',
      'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    ])
      expect(parseEmbedUrl(url), url).toEqual(expected);
  });

  it('recognises Google Drive file links and canonicalises them', () => {
    const id = '1AbC_dEf-1234567890';
    for (const url of [
      `https://drive.google.com/file/d/${id}/view`,
      `https://drive.google.com/file/d/${id}/preview?usp=sharing`,
      `https://drive.google.com/file/d/${id}`,
    ])
      expect(parseEmbedUrl(url), url).toEqual({
        provider: 'drive',
        id,
        embedUrl: `https://drive.google.com/file/d/${id}/preview`,
        openUrl: `https://drive.google.com/file/d/${id}/view`,
      });
  });

  it('rejects everything else, including look-alike hosts and schemes', () => {
    for (const url of [
      'http://www.youtube.com/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      'https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ',
      'https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ',
      'https://youtube.com:8443/watch?v=dQw4w9WgXcQ',
      'https://www.youtube.com/watch?v=short',
      'https://www.youtube.com/watch',
      'https://youtu.be/dQw4w9WgXcQ/extra',
      'https://youtu.be/aMuchLongerIdentifier',
      'https://drive.google.com/file/d/short/view',
      'https://drive.google.com/drive/folders/1AbC_dEf-1234567890',
      'https://docs.google.com/file/d/1AbC_dEf-1234567890/view',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'not a url',
      `https://www.youtube.com/watch?v=${'a'.repeat(3000)}`,
    ])
      expect(parseEmbedUrl(url), url).toBeNull();
  });
});
