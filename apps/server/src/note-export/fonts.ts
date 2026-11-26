import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which bundled Noto font draws which character, and where those files live.
 *
 * The PDF renderer embeds subsetted Noto fonts from `apps/server/fonts` (fetched by
 * `scripts/fetch-fonts.mjs` from the pinned releases in `fonts.lock.json`; the binaries are
 * deliberately not in git). This module owns the script classification, the family mapping and
 * the font-directory resolution, so `pdf.ts` can stay about layout.
 *
 * Latin, Cyrillic, Greek and common punctuation share Noto Sans; code uses Noto Sans Mono;
 * Han, kana, Hangul, CJK punctuation/symbols and full-width forms share Noto Sans CJK; the
 * Khmer blocks use Noto Sans Khmer. Anything else (emoji, scripts no bundled font covers)
 * reaches the renderer's per-character coverage check and becomes `?`, like the built-in
 * fonts behaved before fonts were bundled.
 */

export type Script =
  'latin' | 'cyrillic' | 'greek' | 'han' | 'hiragana' | 'katakana' | 'hangul' | 'khmer' | 'emoji';

export type FontFamily = 'sans' | 'mono' | 'cjk' | 'khmer';

export interface ScriptSegment {
  script: Script;
  text: string;
}

export interface FaceFiles {
  regular: string;
  bold?: string;
  italic?: string;
  boldItalic?: string;
}

/** The files the renderer knows by name; `fonts.lock.json` pins how each one is downloaded. */
export const FONT_FILES: Record<FontFamily, FaceFiles> = {
  sans: {
    regular: 'NotoSans-Regular.ttf',
    bold: 'NotoSans-Bold.ttf',
    italic: 'NotoSans-Italic.ttf',
    boldItalic: 'NotoSans-BoldItalic.ttf',
  },
  mono: {
    regular: 'NotoSansMono-Regular.ttf',
    bold: 'NotoSansMono-Bold.ttf',
  },
  cjk: {
    regular: 'NotoSansCJKsc-Regular.otf',
    bold: 'NotoSansCJKsc-Bold.otf',
  },
  khmer: {
    regular: 'NotoSansKhmer-Regular.ttf',
    bold: 'NotoSansKhmer-Bold.ttf',
  },
};

export interface FontCatalog {
  dir: string;
  /** Families whose regular face exists; optional styles are present only when their file is. */
  families: Partial<Record<FontFamily, FaceFiles>>;
  missing: FontFamily[];
}

const COMBINING_MARK = /\p{M}/u;
const DEFAULT_IGNORABLE = new Set([
  0x00ad, 0x034f, 0x061c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c,
  0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0x206a,
  0x206b, 0x206c, 0x206d, 0x206e, 0x206f, 0xfeff,
]);

function inRanges(cp: number, ranges: readonly (readonly [number, number])[]): boolean {
  for (const [start, end] of ranges) if (cp >= start && cp <= end) return true;
  return false;
}

const CYRILLIC: readonly (readonly [number, number])[] = [
  [0x0400, 0x052f],
  [0x1c80, 0x1c8f],
  [0x2de0, 0x2dff],
  [0xa640, 0xa69f],
];

const GREEK: readonly (readonly [number, number])[] = [
  [0x0370, 0x03ff],
  [0x1f00, 0x1fff],
];

const HIRAGANA: readonly (readonly [number, number])[] = [
  [0x3040, 0x309f],
  [0x1b001, 0x1b11f],
];

const KATAKANA: readonly (readonly [number, number])[] = [
  [0x30a0, 0x30ff],
  [0x31f0, 0x31ff],
  [0x1b000, 0x1b000],
  [0x1b120, 0x1b16f],
  [0xff66, 0xff9d],
];

const HANGUL: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff],
  [0x3130, 0x318f],
  [0xa960, 0xa97f],
  [0xac00, 0xd7af],
  [0xd7b0, 0xd7ff],
];

const HAN: readonly (readonly [number, number])[] = [
  [0x2e80, 0x2eff],
  [0x2f00, 0x2fdf],
  [0x2ff0, 0x2fff],
  [0x3000, 0x303f],
  [0x3100, 0x312f],
  [0x3190, 0x319f],
  [0x31a0, 0x31bf],
  [0x31c0, 0x31ef],
  [0x3200, 0x32ff],
  [0x3300, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe1f],
  [0xfe30, 0xfe4f],
  [0xfe50, 0xfe6f],
  [0xff00, 0xffef],
  [0x1f200, 0x1f2ff],
  [0x20000, 0x2fa1f],
  [0x30000, 0x3ffff],
];

/** Code points that never stand alone: they belong to the character run before them. */
export function isJoiner(cp: number): boolean {
  if (COMBINING_MARK.test(String.fromCodePoint(cp))) return true;
  if (cp === 0x200c || cp === 0x200d || cp === 0x20e3) return true;
  if (cp >= 0xfe00 && cp <= 0xfe0f) return true;
  if (cp >= 0xe0100 && cp <= 0xe01ef) return true;
  if (cp >= 0xe0020 && cp <= 0xe007f) return true;
  // Emoji skin-tone modifiers are part of the preceding emoji, never a character of their own.
  return cp >= 0x1f3fb && cp <= 0x1f3ff;
}

/** Formatting code points a font should not be asked to map to a visible glyph. */
export function isDefaultIgnorable(cp: number): boolean {
  return (
    DEFAULT_IGNORABLE.has(cp) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0000 && cp <= 0xe0fff)
  );
}

/** `Script` of one code point; joiners are handled by `segmentByScript` before this. */
export function scriptOf(cp: number): Script {
  if ((cp >= 0x1780 && cp <= 0x17ff) || (cp >= 0x19e0 && cp <= 0x19ff)) return 'khmer';
  if ((cp >= 0x1f000 && cp <= 0x1faff) || (cp >= 0x1fc00 && cp <= 0x1ffff)) return 'emoji';
  if (inRanges(cp, HIRAGANA)) return 'hiragana';
  if (inRanges(cp, KATAKANA)) return 'katakana';
  if (inRanges(cp, HANGUL)) return 'hangul';
  if (inRanges(cp, HAN)) return 'han';
  if (inRanges(cp, CYRILLIC)) return 'cyrillic';
  if (inRanges(cp, GREEK)) return 'greek';
  return 'latin';
}

/**
 * Split text into runs that share a font. A combining mark, ZWJ, variation selector or emoji
 * modifier stays with the run of the character before it, so a Khmer or Latin cluster is never
 * cut between its base and its marks. Common punctuation and spaces are Latin (Noto Sans).
 */
export function segmentByScript(text: string): ScriptSegment[] {
  const segments: ScriptSegment[] = [];
  let current: ScriptSegment | null = null;
  for (const character of text) {
    const cp = character.codePointAt(0) ?? 0;
    if (isJoiner(cp)) {
      if (current) current.text += character;
      else {
        current = { script: 'latin', text: character };
        segments.push(current);
      }
      continue;
    }
    const script = scriptOf(cp);
    if (current?.script === script) current.text += character;
    else {
      current = { script, text: character };
      segments.push(current);
    }
  }
  return segments;
}

/**
 * The family for a run. Han/kana/Hangul share the one pan-CJK font; code uses the mono family
 * for the scripts it covers and still asks CJK/Khmer for their own characters.
 */
export function familyForScript(script: Script, code: boolean): FontFamily {
  if (script === 'khmer') return 'khmer';
  if (script === 'han' || script === 'hiragana' || script === 'katakana' || script === 'hangul')
    return 'cjk';
  return code ? 'mono' : 'sans';
}

/** The face for a style: the closest existing file, never a style pdfkit has to synthesise. */
export function faceFile(files: FaceFiles, bold: boolean, italic: boolean): string {
  if (bold && italic) return files.boldItalic ?? files.bold ?? files.italic ?? files.regular;
  if (bold) return files.bold ?? files.regular;
  if (italic) return files.italic ?? files.regular;
  return files.regular;
}

/** `BOKYDO_FONT_DIR` when set, else the `fonts/` directory next to the app (src and dist alike). */
export function resolveFontDir(override?: string): string {
  if (override !== undefined && override !== '') return path.resolve(override);
  const fromEnv = process.env.BOKYDO_FONT_DIR;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return path.resolve(fromEnv);
  return path.resolve(fileURLToPath(new URL('../../fonts/', import.meta.url)));
}

/** Which families are on disk. Only the regular face is required; the rest are optional. */
export function loadFontCatalog(dir = resolveFontDir()): FontCatalog {
  const families: Partial<Record<FontFamily, FaceFiles>> = {};
  const missing: FontFamily[] = [];
  for (const family of Object.keys(FONT_FILES) as FontFamily[]) {
    const wanted = FONT_FILES[family];
    if (!existsSync(path.join(dir, wanted.regular))) {
      missing.push(family);
      continue;
    }
    const files: FaceFiles = { regular: wanted.regular };
    if (wanted.bold !== undefined && existsSync(path.join(dir, wanted.bold)))
      files.bold = wanted.bold;
    if (wanted.italic !== undefined && existsSync(path.join(dir, wanted.italic)))
      files.italic = wanted.italic;
    if (wanted.boldItalic !== undefined && existsSync(path.join(dir, wanted.boldItalic)))
      files.boldItalic = wanted.boldItalic;
    families[family] = files;
  }
  return { dir, families, missing };
}

const warned = new Set<string>();

/** One warning per process and directory; a dev checkout without fetched fonts stays usable. */
export function warnMissingFonts(catalog: FontCatalog): void {
  if (catalog.missing.length === 0) return;
  const key = `${catalog.dir}\0${catalog.missing.join(',')}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(
    `[note-export] PDF fonts missing in ${catalog.dir} (${catalog.missing.join(', ')}); ` +
      'those scripts fall back to the built-in Helvetica/Courier fonts. ' +
      'Run "pnpm --filter @bokydo/server fonts:fetch" to enable Unicode text.',
  );
}
