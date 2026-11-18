import { describe, expect, it } from 'vitest';
import { parseNoteBody } from './ast.js';
import { buildDocx } from './docx.js';
import type { LoadedImage } from './images.js';
import { collect, PNG_1X1, readZipEntries, zipText } from './test-support.js';

const PNG_ID = '44444444-4444-4444-8444-444444444444';
const GIF_ID = '55555555-5555-4555-8555-555555555555';

const images = new Map<string, LoadedImage>([
  [
    PNG_ID,
    {
      id: PNG_ID,
      filename: 'shot.png',
      type: 'png',
      width: 1,
      height: 1,
      bytes: PNG_1X1,
    },
  ],
]);

const filenames = new Map([
  [PNG_ID, 'shot.png'],
  [GIF_ID, 'anim.gif'],
]);

const BODY = [
  '# Quarterly plan',
  '',
  'A **bold** and *italic* line with `code`, a [link](https://example.com) and a hidden █████.',
  '',
  '> quoted text',
  '',
  '- bullet one',
  '  - nested bullet',
  '- [ ] open task',
  '- [x] done task',
  '',
  '1. first',
  '2. second',
  '',
  '| head | other |',
  '| ---- | ----- |',
  '| cell | more |',
  '',
  '```js',
  'const x = 1;',
  '```',
  '',
  '---',
  '',
  `![shot](/api/v1/note-files/${PNG_ID}?inline=1)`,
  '',
  `![anim](/api/v1/note-files/${GIF_ID}?inline=1)`,
  '',
  '::embed[Watch this](https://youtu.be/dQw4w9WgXcQ)',
].join('\n');

async function render(body = BODY, title = 'Quarterly plan') {
  const doc = parseNoteBody(body);
  const buffer = await collect(buildDocx(title, doc.blocks, { images, fileNames: filenames }));
  return { buffer, xml: zipText(buffer, 'word/document.xml') };
}

describe('note export DOCX', () => {
  it('produces a real zip-based DOCX with the document part', async () => {
    const { buffer, xml } = await render();
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    const entries = readZipEntries(buffer);
    expect([...entries.keys()]).toContain('[Content_Types].xml');
    expect([...entries.keys()]).toContain('word/document.xml');
    expect(xml).toContain('<w:document');
  });

  it('writes the title, headings, text and inline formatting', async () => {
    const { xml } = await render();
    expect(xml).toContain('Quarterly plan');
    expect(xml).toContain('Heading1');
    expect(xml).toContain('A ');
    expect(xml).toContain('<w:b/>');
    expect(xml).toContain('<w:i/>');
    expect(xml).toContain('<w:strike');
    expect(xml).toContain('Courier New');
    expect(xml).toContain('█████');
    expect(xml).not.toContain('censored');
  });

  it('writes quotes, lists, task boxes, tables, code and a rule', async () => {
    const { xml } = await render();
    expect(xml).toContain('quoted text');
    expect(xml).toContain('w:ind');
    expect(xml).toContain('<w:numPr>');
    expect(xml).toContain('☐');
    expect(xml).toContain('☑');
    expect(xml).toContain('<w:tbl>');
    expect(xml).toContain('cell');
    expect(xml).toContain('const x = 1;');
  });

  it('keeps safe links as external hyperlinks and in-app links as text', async () => {
    const { buffer, xml } = await render(
      `[site](https://example.com) [note](bokydo:note/11111111-1111-4111-8111-111111111111) [file](/api/v1/note-files/${GIF_ID})\n`,
    );
    expect(xml).toContain('w:hyperlink');
    expect(zipText(buffer, 'word/_rels/document.xml.rels')).toContain('https://example.com/');
    expect(xml).toContain('note');
    expect(xml).toContain('anim.gif');
    expect(xml).not.toContain('bokydo:');
    expect(xml).not.toContain('/api/v1/note-files/');
  });

  it('embeds this note’s PNG image and names the ones it cannot embed', async () => {
    const { buffer, xml } = await render();
    expect([...readZipEntries(buffer).keys()].some((name) => name.startsWith('word/media/'))).toBe(
      true,
    );
    expect(xml).toContain('w:drawing');
    // A GIF is shown as its name; only PNG and JPEG are embedded (ADR 0025).
    expect(xml).toContain('[image: anim]');
  });

  it('exports an embed as a hyperlink with its open URL', async () => {
    const { buffer, xml } = await render();
    expect(xml).toContain('▶');
    expect(zipText(buffer, 'word/_rels/document.xml.rels')).toContain(
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    );
  });

  it('never puts a censored token in the archive', async () => {
    const salt = 'A'.repeat(22);
    const iv = 'B'.repeat(16);
    const body = `before {{censored:v1:${salt}:${iv}:c2VjcmV0cGhyYXNl}} after\n`;
    const { buffer, xml } = await render(body, 'Censored');
    expect(xml).toContain('█████');
    for (const entry of readZipEntries(buffer).values())
      expect(entry.toString('latin1')).not.toContain('censored');
    expect(xml).not.toContain(salt);
  });
});
