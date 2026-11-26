import path from 'node:path';
import PdfDocument from 'pdfkit';
import { describe, expect, it } from 'vitest';
import { parseNoteBody } from './ast.js';
import { loadFontCatalog, resolveFontDir } from './fonts.js';
import { buildPdf } from './pdf.js';
import { collect, extractPdfText } from './test-support.js';

/**
 * These tests need the fetched Noto files (`pnpm --filter @bokydo/server fonts:fetch`). Without
 * them the exporter falls back to Helvetica/Courier, which `pdf.test.ts` covers; here every
 * assertion is about the embedded Unicode fonts, so the suite is skipped rather than weakened.
 */

const FONT_DIR = resolveFontDir();
const FONTS_PRESENT = loadFontCatalog(FONT_DIR).missing.length === 0;
const describeFonts = FONTS_PRESENT ? describe : describe.skip;

const SCRIPT_TEXT = ['Привет', 'Καλημέρα', '你好', 'こんにちは', '안녕하세요', 'សួស្តី'];

const BODY = [
  ...SCRIPT_TEXT,
  '',
  'Mixed: English Привет Καλημέρα 你好 こんにちは 안녕하세요 សួស្តី.',
  '',
  '**你好 bold** and *Привет italic*',
  '',
  '```js',
  'const value = 1;',
  '```',
].join('\n\n');

async function render(body: string, title = 'Unicode') {
  const doc = parseNoteBody(body);
  const pdf = await collect(
    buildPdf(title, doc.blocks, { images: new Map(), fileNames: new Map() }, { compress: false }),
  );
  return { pdf, text: extractPdfText(pdf), raw: pdf.toString('latin1') };
}

interface LayoutGlyph {
  codePoints: number[];
}

interface LayoutRun {
  glyphs: LayoutGlyph[];
}

interface KitFace {
  layout(text: string): LayoutRun;
}

/** The fontkit face pdfkit uses, reached the same way the renderer's coverage check does. */
function kitFace(file: string): KitFace {
  const doc = new PdfDocument();
  doc.registerFont('face', path.join(FONT_DIR, file));
  doc.font('face');
  return (doc as unknown as { _font: { font: KitFace } })._font.font;
}

describeFonts('note export PDF with bundled Noto fonts (fonts:fetch)', () => {
  it('renders Cyrillic, Greek, Han, Kana, Hangul and Khmer instead of ?', async () => {
    const { text } = await render(BODY);
    for (const value of SCRIPT_TEXT) expect(text).toContain(value);
    expect(text).not.toContain('?');
    expect(text).toContain('Mixed: English');
    expect(text).toContain('English Привет Καλημέρα 你好 こんにちは 안녕하세요 សួស្តី');
  });

  it('embeds subsetted font files for every family and names them in BaseFont', async () => {
    const { raw } = await render(BODY);
    expect(raw).toContain('/FontFile2'); // TrueType subsets (Noto Sans, Mono, Khmer)
    expect(raw).toContain('/FontFile3'); // CFF subset (Noto Sans CJK)
    for (const name of [
      'NotoSans-Regular',
      'NotoSans-Bold',
      'NotoSansMono-Regular',
      'NotoSansCJKsc-Regular',
      'NotoSansCJKsc-Bold',
      'NotoSansKhmer-Regular',
    ]) {
      expect(raw).toMatch(new RegExp(`/BaseFont /[A-Z]{6}\\+${name}\\b`, 'u'));
    }
    // A subset is small; embedding the full 16 MB CJK face would make the file hundreds of times
    // larger than this note needs.
    expect(raw.length).toBeLessThan(4 * 1024 * 1024);
  });

  it('shapes Khmer through the font GSUB and maps the shaped glyphs back through ToUnicode', async () => {
    const khmer = 'សួស្តី';
    const { pdf, text, raw } = await render(khmer);
    expect(text).toContain(khmer);
    expect(text).not.toContain('?');
    expect(raw).toMatch(/\/BaseFont \/[A-Z]{6}\+NotoSansKhmer-Regular\b/u);
    expect(pdf.includes(Buffer.from('NotoSansKhmer-Regular', 'latin1'))).toBe(true);

    // The coeng sign + consonant becomes one subscript glyph: fewer glyphs than code points and
    // one glyph carrying two code points. pdfkit uses fontkit's layout for `doc.text`, so this
    // is the exact path the renderer exercised above.
    const run = kitFace('NotoSansKhmer-Regular.ttf').layout(khmer);
    expect([...khmer]).toHaveLength(6);
    expect(run.glyphs.length).toBe(5);
    expect(run.glyphs.some((glyph) => glyph.codePoints.length === 2)).toBe(true);
  });

  it('keeps a Khmer cluster in one shaping unit when a long word has to wrap', async () => {
    const word = 'សួស្តី'.repeat(1200);
    const { pdf, text } = await render(word, 'Khmer wrap');
    const pages = pdf.toString('latin1').match(/\/Type \/Page\b/gu) ?? [];
    expect(pages.length).toBeGreaterThan(1);
    expect(text).toContain('សួស្តី');
    expect(text).not.toContain('?');
  });

  it('renders a long CJK paragraph and a CJK table without substitutions', async () => {
    const body = [
      '你好世界'.repeat(800),
      '',
      '| 语言 | 例 |',
      '| ---- | -- |',
      '| 中文 | 你好 |',
      '| 日本語 | こんにちは |',
      '| 한국어 | 안녕하세요 |',
      '| ខ្មែរ | សួស្តី |',
    ].join('\n');
    const { pdf, text } = await render(body, 'CJK wrap');
    const pages = pdf.toString('latin1').match(/\/Type \/Page\b/gu) ?? [];
    expect(pages.length).toBeGreaterThan(1);
    expect(text).toContain('中文');
    expect(text).toContain('こんにちは');
    expect(text).toContain('안녕하세요');
    expect(text).toContain('សួស្តី');
    expect(text).not.toContain('?');
  });

  it('still writes ? for an emoji no bundled font covers, and keeps the surrounding text', async () => {
    const { text } = await render('emoji 😀 done');
    expect(text).toContain('emoji');
    expect(text).toContain('done');
    expect(text).toContain('?');
    expect(text).not.toContain('😀');
  });

  it('draws the censored placeholder as a bar, not as unsupported block characters', async () => {
    const salt = 'A'.repeat(22);
    const iv = 'B'.repeat(16);
    const { text, raw } = await render(`before {{censored:v1:${salt}:${iv}:c2VjcmV0}} after`);
    expect(text).toContain('before');
    expect(text).toContain('after');
    expect(text).not.toContain('█████');
    const content = raw.slice(raw.indexOf('stream'), raw.indexOf('endstream'));
    expect(content.includes(' re\n')).toBe(true);
  });
});

describe('note export PDF Unicode font availability', () => {
  it('reports the font directory and whether it is complete', () => {
    expect(FONT_DIR).toMatch(/fonts$/u);
    expect(typeof FONTS_PRESENT).toBe('boolean');
    if (!FONTS_PRESENT)
      console.info(
        `[note-export] PDF Unicode font tests skipped: run "pnpm --filter @bokydo/server fonts:fetch" to install the Noto files in ${FONT_DIR}`,
      );
  });
});
