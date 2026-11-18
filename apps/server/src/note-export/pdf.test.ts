import { describe, expect, it } from 'vitest';
import { parseNoteBody } from './ast.js';
import type { LoadedImage } from './images.js';
import { buildPdf, pdfSafe } from './pdf.js';
import { collect, PNG_1X1 } from './test-support.js';

const PNG_ID = '44444444-4444-4444-8444-444444444444';
const SALT = 'A'.repeat(22);
const IV = 'B'.repeat(16);

const images = new Map<string, LoadedImage>([
  [PNG_ID, { id: PNG_ID, filename: 'shot.png', type: 'png', width: 1, height: 1, bytes: PNG_1X1 }],
]);

const BODY = [
  '## Section',
  '',
  'A **bold** and *italic* line with a [link](https://example.com/page) and a hidden █████.',
  '',
  '> quoted text',
  '',
  '- bullet one',
  '  - nested bullet',
  '- [ ] open task',
  '- [x] done task',
  '',
  '3. third',
  '4. fourth',
  '',
  '| head | other |',
  '| ---- | ----- |',
  '| cell | more |',
  '',
  '```js',
  'const value = 1;',
  '```',
  '',
  '---',
  '',
  `![shot](/api/v1/note-files/${PNG_ID}?inline=1)`,
  '',
  `![missing](/api/v1/note-files/55555555-5555-4555-8555-555555555555?inline=1)`,
  '',
  '::embed[Watch this](https://youtu.be/dQw4w9WgXcQ)',
].join('\n');

/** The cp1252 half of WinAnsiEncoding, which is what the built-in fonts write. */
const CP1252: Record<number, string> = {
  0x80: '€',
  0x82: '‚',
  0x83: 'ƒ',
  0x84: '„',
  0x85: '…',
  0x86: '†',
  0x87: '‡',
  0x88: 'ˆ',
  0x89: '‰',
  0x8a: 'Š',
  0x8b: '‹',
  0x8c: 'Œ',
  0x8e: 'Ž',
  0x91: '‘',
  0x92: '’',
  0x93: '“',
  0x94: '”',
  0x95: '•',
  0x96: '–',
  0x97: '—',
  0x98: '˜',
  0x99: '™',
  0x9a: 'š',
  0x9b: '›',
  0x9c: 'œ',
  0x9e: 'ž',
  0x9f: 'Ÿ',
};

function winAnsi(bytes: Buffer): string {
  let out = '';
  for (const byte of bytes) {
    if (byte >= 0x80 && byte <= 0x9f) out += CP1252[byte] ?? '?';
    else out += String.fromCharCode(byte);
  }
  return out;
}

/** Every text-showing array in the (uncompressed) content streams, joined by single spaces. */
function pdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1');
  const parts: string[] = [];
  let at = 0;
  for (;;) {
    // A text array always starts with a hex string; `/MediaBox [` and `/ProcSet [` do not.
    const open = raw.indexOf('[<', at);
    if (open === -1) break;
    const close = raw.indexOf('] TJ', open);
    if (close === -1) break;
    const inner = raw.slice(open + 1, close);
    let hex = '';
    let start = inner.indexOf('<');
    while (start !== -1) {
      const end = inner.indexOf('>', start);
      if (end === -1) break;
      hex += inner.slice(start + 1, end);
      start = inner.indexOf('<', end);
    }
    parts.push(winAnsi(Buffer.from(hex, 'hex')));
    at = close + 4;
  }
  return parts.join(' ');
}

async function render(body = BODY, title = 'Quarterly plan') {
  const doc = parseNoteBody(body);
  const pdf = await collect(
    buildPdf(
      title,
      doc.blocks,
      { images, fileNames: new Map([[PNG_ID, 'shot.png']]) },
      { compress: false },
    ),
  );
  return { pdf, text: pdfText(pdf) };
}

describe('note export PDF', () => {
  it('produces a PDF on A4 with the title as the first heading', async () => {
    const { pdf, text } = await render();
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.toString('latin1')).toContain('/MediaBox [0 0 595.28 841.89]');
    expect(text).toContain('Quarterly plan');
    expect(text).toContain('Section');
  });

  it('writes paragraphs, quotes, lists, tasks, tables, code and rules', async () => {
    const { text } = await render();
    expect(text).toContain('A');
    expect(text).toContain('bold');
    expect(text).toContain('italic');
    expect(text).toContain('quoted text');
    expect(text).toContain('bullet one');
    expect(text).toContain('nested bullet');
    expect(text).toContain('open task');
    expect(text).toContain('done task');
    expect(text).toContain('third');
    expect(text).toContain('fourth');
    expect(text).toContain('head');
    expect(text).toContain('cell');
    expect(text).toContain('const');
    expect(text).toContain('value');
  });

  it('creates a link annotation and an embed link', async () => {
    const { pdf, text } = await render();
    const raw = pdf.toString('latin1');
    expect(raw).toContain('/URI (https://example.com/page)');
    expect(raw).toContain('/URI (https://www.youtube.com/watch?v=dQw4w9WgXcQ)');
    expect(text).toContain('Watch this');
  });

  it('never writes a censored token and draws the bar instead', async () => {
    const { pdf, text } = await render(
      `before {{censored:v1:${SALT}:${IV}:c2VjcmV0cGhyYXNl}} after\n`,
    );
    const raw = pdf.toString('latin1');
    expect(raw).not.toContain('censored');
    expect(raw).not.toContain(SALT);
    expect(text).not.toContain('█████');
    expect(text).toContain('before');
    expect(text).toContain('after');
    // The placeholder is a filled rectangle (a `re` path, then a fill) between the two words.
    const content = raw.slice(raw.indexOf('stream'), raw.indexOf('endstream'));
    expect(content.includes(' re\n')).toBe(true);
    expect(content.includes('\nf\n')).toBe(true);
  });

  it('embeds a PNG note file and names the ones it cannot embed', async () => {
    const { pdf, text } = await render();
    const raw = pdf.toString('latin1');
    expect(raw).toContain('/Subtype /Image');
    expect(text).toContain('[image:');
    expect(text).toContain('missing');
  });

  it('replaces characters the built-in fonts cannot draw', async () => {
    expect(pdfSafe('Café — naïve')).toBe('Café — naïve');
    expect(pdfSafe('Привет')).toBe('??????');
    expect(pdfSafe('សួស្តី')).toBe('??????');
    expect(pdfSafe('a▶b')).toBe('a»b');
    expect(pdfSafe('😀')).toBe('?');
    const { pdf } = await render('Привет **мир**\n');
    expect(pdf.toString('latin1')).not.toContain('Привет');
  });

  it('starts a new page instead of writing past the bottom margin', async () => {
    const body = Array.from({ length: 120 }, (_, index) => `Paragraph number ${index}.`).join(
      '\n\n',
    );
    const { pdf } = await render(body, 'Long');
    const pages = pdf.toString('latin1').match(/\/Type \/Page/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
  });
});
