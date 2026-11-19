import { describe, expect, it } from 'vitest';
import { exportFilename, redactExportText } from './export.js';

const SALT = 'A'.repeat(22);
const IV = 'B'.repeat(16);
const CIPHERTEXT = 'c2VjcmV0cGhyYXNl';
const TOKEN = `{{censored:v1:${SALT}:${IV}:${CIPHERTEXT}}}`;
const ENCODED = TOKEN.replace(
  /[{}:]/g,
  (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
);
const PLACEHOLDER = '█████';

describe('export name redaction', () => {
  it('replaces a raw token', () => {
    expect(redactExportText(`shot ${TOKEN}.png`)).toBe(`shot ${PLACEHOLDER}.png`);
  });

  it('replaces a fully percent-encoded token', () => {
    const text = redactExportText(`shot ${ENCODED}.png`);
    expect(text).toBe(`shot ${PLACEHOLDER}.png`);
    expect(text).not.toContain(CIPHERTEXT);
  });

  it('replaces a raw and an encoded marker in the same name', () => {
    const text = redactExportText(`${TOKEN} and ${ENCODED}`);
    expect(text).toBe(`${PLACEHOLDER} and ${PLACEHOLDER}`);
    expect(text).not.toContain(SALT);
    expect(text).not.toContain('censored');
  });

  it('detects a marker with mixed raw and encoded characters, in any case', () => {
    const mixed = `{%7BCENSORED:v1:${SALT}:${IV}:${CIPHERTEXT}}%7d`;
    expect(redactExportText(`x ${mixed}`)).toBe(`x ${PLACEHOLDER}`);
  });

  it('finds an encoded marker with whitespace after the braces, like the shared redactor', () => {
    // `{{ censored` is censored for `redactCensored`; the encoded scan must agree.
    for (const marker of [
      `%7B%7B%20censored secret words%7D%7D`,
      `%7B%7B%09CeNsOrEd:${CIPHERTEXT}`,
    ]) {
      const text = redactExportText(`title ${marker} tail`);
      expect(text, marker).not.toMatch(/secret|censored|c2VjcmV0/i);
      expect(text).toContain('title');
    }
  });

  it('ignores a malformed escape elsewhere and still finds the marker', () => {
    const text = redactExportText(`100%zz ${ENCODED}`);
    expect(text).toBe(`100%zz ${PLACEHOLDER}`);
    expect(text).not.toContain(CIPHERTEXT);
  });

  it('leaves a benign percent escape alone', () => {
    expect(redactExportText('Caf%C3%A9.png')).toBe('Caf%C3%A9.png');
  });
});

describe('export filename', () => {
  it('applies the Windows device-name check to the whole filename', () => {
    expect(exportFilename('CON', 'md')).toContain('_CON.md');
    expect(exportFilename('com¹', 'pdf')).toContain('_com%C2%B9.pdf');
    expect(exportFilename('ＣＯＮ', 'docx')).toContain(encodeURIComponent('_ＣＯＮ.docx'));
    expect(exportFilename('COM10', 'md')).toContain('COM10.md');
  });

  it('never puts a censor marker, raw or encoded, in the header value', () => {
    for (const title of [TOKEN, ENCODED, `x ${TOKEN} ${ENCODED}`]) {
      const header = exportFilename(title, 'md');
      expect(header).not.toContain('censored');
      expect(header).not.toContain(SALT);
      const marker = "filename*=UTF-8''";
      expect(
        decodeURIComponent(header.slice(header.indexOf(marker) + marker.length)),
      ).not.toContain(CIPHERTEXT);
    }
  });
});
