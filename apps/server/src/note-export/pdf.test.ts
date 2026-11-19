import { describe, expect, it } from 'vitest';
import { parseNoteBody } from './ast.js';
import type { LoadedImage } from './images.js';
import { ExportDeadline, ExportTimeoutError, TooLargeError } from './limits.js';
import { buildPdf, pdfSafe } from './pdf.js';
import { PNG_1X1, PNG_RGB, collect, makeJpeg, makePng } from './test-support.js';

const PNG_ID = '44444444-4444-4444-8444-444444444444';
const ALPHA_ID = '66666666-6666-4666-8666-666666666666';
const TEXT_ID = '77777777-7777-4777-8777-777777777777';
const MOTION_ID = '88888888-8888-4888-8888-888888888888';
const TEXT_PNG = makePng({
  colorType: 2,
  extra: [
    {
      type: 'tEXt',
      data: Buffer.from(`Comment\0${'x'.repeat(256 * 1024)}`, 'latin1'),
    },
  ],
});
const MOTION_JPEG = makeJpeg({
  width: 2,
  height: 2,
  append: Buffer.from('ftypmp42-appended-video', 'latin1'),
});
const SALT = 'A'.repeat(22);
const IV = 'B'.repeat(16);

const images = new Map<string, LoadedImage>([
  [PNG_ID, { id: PNG_ID, filename: 'shot.png', type: 'png', width: 1, height: 1, bytes: PNG_RGB }],
  // An alpha PNG: pdfkit would decode it through png-js, so the renderer must refuse it.
  [
    ALPHA_ID,
    { id: ALPHA_ID, filename: 'alpha.png', type: 'png', width: 1, height: 1, bytes: PNG_1X1 },
  ],
  [
    TEXT_ID,
    { id: TEXT_ID, filename: 'meta.png', type: 'png', width: 1, height: 1, bytes: TEXT_PNG },
  ],
  [
    MOTION_ID,
    {
      id: MOTION_ID,
      filename: 'motion.jpg',
      type: 'jpeg',
      width: 2,
      height: 2,
      bytes: MOTION_JPEG,
    },
  ],
]);

const fileNames = new Map([
  [PNG_ID, 'shot.png'],
  [ALPHA_ID, 'alpha.png'],
  [TEXT_ID, 'meta.png'],
  [MOTION_ID, 'motion.jpg'],
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
    buildPdf(title, doc.blocks, { images, fileNames }, { compress: false }),
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

  it('creates one link annotation per contiguous link run, not per word', async () => {
    const { pdf } = await render(
      'See [the whole annual report page](https://example.com/page) for details.\n',
    );
    const raw = pdf.toString('latin1');
    expect(raw).toContain('/URI (https://example.com/page)');
    const annotations = raw.match(/\/Subtype \/Link/g) ?? [];
    expect(annotations).toHaveLength(1);
  });

  it('refuses a link annotation explosion before the stream is closed', () => {
    const body = Array.from(
      { length: 5 },
      (_, index) => `[link ${index}](https://example.com/${index}) and more text.`,
    ).join('\n\n');
    const doc = parseNoteBody(body);
    expect(() =>
      buildPdf(
        'Links',
        doc.blocks,
        { images: new Map(), fileNames: new Map() },
        { compress: false, maxLinkAnnotations: 2 },
      ),
    ).toThrow(/link annotations/);
  });

  it('creates an embed link and shows its label', async () => {
    const { pdf, text } = await render();
    expect(pdf.toString('latin1')).toContain('/URI (https://www.youtube.com/watch?v=dQw4w9WgXcQ)');
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

  it('embeds a validated RGB PNG and names the ones it cannot embed', async () => {
    const { pdf, text } = await render();
    const raw = pdf.toString('latin1');
    expect(raw).toContain('/Subtype /Image');
    // A PNG with alpha must never reach png-js: pdfkit would decode it in a zlib callback.
    expect(raw).toContain('/DeviceRGB');
    expect(text).toContain('[image:');
    expect(text).toContain('missing');
  });

  it('rebuilds a PNG with a 256 KiB tEXt chunk before pdfkit sees it', async () => {
    const body = `![metadata](/api/v1/note-files/${TEXT_ID}?inline=1)\n`;
    const { pdf } = await render(body);
    const raw = pdf.toString('latin1');
    expect(raw).toContain('/Subtype /Image');
    // The ancillary chunk is dropped, so no metadata text (or tEXt parser path) reaches pdfkit.
    expect(raw).not.toContain('tEXt');
    expect(raw).not.toContain('xxxxx');
  });

  it('embeds a motion-photo JPEG only through its first EOI', async () => {
    const body = `![motion](/api/v1/note-files/${MOTION_ID}?inline=1)\n`;
    const { pdf } = await render(body);
    const raw = pdf.toString('latin1');
    expect(raw).toContain('/Subtype /Image');
    expect(raw).not.toContain('ftypmp42');
  });

  it('renders an alpha PNG as text even when a caller hands it over unvalidated', async () => {
    const body = `![alpha](/api/v1/note-files/${ALPHA_ID}?inline=1)\n`;
    const { pdf, text } = await render(body);
    expect(pdf.toString('latin1')).not.toContain('/Subtype /Image');
    expect(text).toContain('[image: alpha]');
  });

  it('renders a note-file link as the file’s name, not its label', async () => {
    const body = `[the label](/api/v1/note-files/${PNG_ID})\n`;
    const { text } = await render(body);
    expect(text).toContain('shot.png');
    expect(text).not.toContain('the label');
  });

  it('renders an image inside a paragraph as text', async () => {
    const body = `before ![inline shot](/api/v1/note-files/${PNG_ID}?inline=1) after\n`;
    const { text } = await render(body);
    expect(text).toContain('[image: inline shot]');
    expect(text).toContain('before');
    expect(text).toContain('after');
  });

  it('wraps cell text into content-sized columns and breaks table rows across pages', async () => {
    const cell = 'a long cell that has to wrap several times inside its column';
    const rows = Array.from({ length: 60 }, (_, index) => `| row ${index} | ${cell} |`);
    const body = ['| first | second |', '| ----- | ------ |', ...rows].join('\n');
    const { pdf, text } = await render(body, 'Table');
    const pages = pdf.toString('latin1').match(/\/Type \/Page\b/g) ?? [];
    expect(pages.length).toBeGreaterThan(1);
    // The header row is repeated on the later pages.
    expect(text.split('second').length - 1).toBeGreaterThan(1);
    expect(text).toContain('row 59');
  });

  it('renders a table too wide for its minimum columns as header: value lines', async () => {
    const columns = 40;
    const header = Array.from({ length: columns }, (_, index) => `head${index}`);
    const values = Array.from({ length: columns }, (_, index) => `value${index}`);
    const body = [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      `| ${values.join(' | ')} |`,
    ].join('\n');
    const { pdf, text } = await render(body, 'Wide table');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    // No grid is drawn; every cell is a readable line instead of running off the page.
    expect(text).toContain('head0: value0');
    expect(text).toContain('head39: value39');
  });

  it('truncates a header taller than a page with an ellipsis instead of looping', async () => {
    const columns = 19;
    const header = Array.from({ length: columns }, (_, index) =>
      index === 0 ? Array.from({ length: 1200 }, () => 'word').join(' ') : `h${index}`,
    );
    const values = Array.from({ length: columns }, (_, index) => `v${index}`);
    const body = [
      `| ${header.join(' | ')} |`,
      `| ${header.map(() => '---').join(' | ')} |`,
      `| ${values.join(' | ')} |`,
    ].join('\n');
    const { pdf, text } = await render(body, 'Tall header');
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(text).toContain('…');
    expect(text).toContain('v0');
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

  it('aborts the render as soon as pdfkit produces more than the output budget', async () => {
    const doc = parseNoteBody(BODY);
    const stream = buildPdf(
      'Too big',
      doc.blocks,
      { images, fileNames },
      { compress: false, maxOutputBytes: 256 },
    );
    await expect(collect(stream)).rejects.toBeInstanceOf(TooLargeError);
  });

  it('abandons a render that has run past its deadline', () => {
    const doc = parseNoteBody(BODY);
    expect(() =>
      buildPdf(
        'Late',
        doc.blocks,
        { images, fileNames },
        { compress: false, deadline: new ExportDeadline(0) },
      ),
    ).toThrow(ExportTimeoutError);
  });
});
