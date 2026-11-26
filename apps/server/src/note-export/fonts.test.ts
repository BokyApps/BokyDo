import { readFileSync, existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  FONT_FILES,
  familyForScript,
  faceFile,
  isDefaultIgnorable,
  isJoiner,
  loadFontCatalog,
  resolveFontDir,
  scriptOf,
  segmentByScript,
} from './fonts.js';

const LOCK_URL = new URL('../../fonts.lock.json', import.meta.url);
const SHA_URL = new URL('../../fonts.sha256', import.meta.url);
const FONTS_URL = new URL('../../fonts/', import.meta.url);

interface LockedFont {
  name: string;
  file: string;
  family: string;
  style: string;
  version: string;
  url: string;
  archiveSha256: string;
  archiveEntry: string;
  sha256: string;
  licence: string;
}

describe('PDF font script segmentation', () => {
  it('keeps Latin, Cyrillic and Greek in separate runs that share Noto Sans', () => {
    expect(segmentByScript('Hello, Привет!')).toEqual([
      { script: 'latin', text: 'Hello, ' },
      { script: 'cyrillic', text: 'Привет' },
      { script: 'latin', text: '!' },
    ]);
    expect(segmentByScript('Καλημέρα')).toEqual([{ script: 'greek', text: 'Καλημέρα' }]);
    expect(familyForScript('latin', false)).toBe('sans');
    expect(familyForScript('cyrillic', false)).toBe('sans');
    expect(familyForScript('greek', false)).toBe('sans');
  });

  it('splits Han, Hiragana, Katakana and Hangul runs and maps all of them to Noto Sans CJK', () => {
    expect(segmentByScript('你好，世界')).toEqual([{ script: 'han', text: '你好，世界' }]);
    expect(segmentByScript('こんにちは')).toEqual([{ script: 'hiragana', text: 'こんにちは' }]);
    expect(segmentByScript('カタカナ')).toEqual([{ script: 'katakana', text: 'カタカナ' }]);
    expect(segmentByScript('안녕하세요')).toEqual([{ script: 'hangul', text: '안녕하세요' }]);
    expect(segmentByScript('日本語 and English')).toEqual([
      { script: 'han', text: '日本語' },
      { script: 'latin', text: ' and English' },
    ]);
    expect(familyForScript('han', false)).toBe('cjk');
    expect(familyForScript('hiragana', false)).toBe('cjk');
    expect(familyForScript('katakana', false)).toBe('cjk');
    expect(familyForScript('hangul', false)).toBe('cjk');
  });

  it('keeps Khmer base, vowel and coeng subscripts in one run', () => {
    expect(segmentByScript('សួស្តី')).toEqual([{ script: 'khmer', text: 'សួស្តី' }]);
    expect(segmentByScript('ខ្មែរ')).toEqual([{ script: 'khmer', text: 'ខ្មែរ' }]);
    expect(familyForScript('khmer', false)).toBe('khmer');
    expect(familyForScript('khmer', true)).toBe('khmer');
  });

  it('keeps combining marks, joiners and variation selectors with the preceding run', () => {
    expect(segmentByScript('e\u0301')).toEqual([{ script: 'latin', text: 'e\u0301' }]);
    expect(segmentByScript('Приве\u0301т')).toEqual([{ script: 'cyrillic', text: 'Приве\u0301т' }]);
    expect(segmentByScript('a\u200Db')).toEqual([{ script: 'latin', text: 'a\u200Db' }]);
    expect(segmentByScript('❤\uFE0F')).toEqual([{ script: 'latin', text: '❤\uFE0F' }]);
    expect(segmentByScript('x\u0301 你好')).toEqual([
      { script: 'latin', text: 'x\u0301 ' },
      { script: 'han', text: '你好' },
    ]);
    expect(isJoiner(0x0301)).toBe(true);
    expect(isJoiner(0x200d)).toBe(true);
    expect(isJoiner(0xfe0f)).toBe(true);
    expect(isJoiner(0x17d2)).toBe(true);
  });

  it('gives emoji their own run so the renderer can use its `?` fallback', () => {
    expect(segmentByScript('a😀b')).toEqual([
      { script: 'latin', text: 'a' },
      { script: 'emoji', text: '😀' },
      { script: 'latin', text: 'b' },
    ]);
    expect(segmentByScript('👨\u200D👩\u200D👧')).toEqual([
      { script: 'emoji', text: '👨\u200D👩\u200D👧' },
    ]);
    expect(scriptOf(0x1f600)).toBe('emoji');
    expect(familyForScript('emoji', false)).toBe('sans');
    expect(isDefaultIgnorable(0xfe0f)).toBe(true);
  });

  it('uses Noto Sans Mono for code, with CJK and Khmer characters still in their own faces', () => {
    expect(familyForScript('latin', true)).toBe('mono');
    expect(familyForScript('cyrillic', true)).toBe('mono');
    expect(familyForScript('greek', true)).toBe('mono');
    expect(familyForScript('han', true)).toBe('cjk');
    expect(familyForScript('khmer', true)).toBe('khmer');
  });

  it('falls back to the closest existing face for a missing style, never synthesising one', () => {
    const full = {
      regular: 'r',
      bold: 'b',
      italic: 'i',
      boldItalic: 'bi',
    };
    expect(faceFile(full, false, false)).toBe('r');
    expect(faceFile(full, true, false)).toBe('b');
    expect(faceFile(full, false, true)).toBe('i');
    expect(faceFile(full, true, true)).toBe('bi');
    expect(faceFile({ regular: 'r', bold: 'b' }, false, true)).toBe('r');
    expect(faceFile({ regular: 'r' }, true, true)).toBe('r');
  });

  it('resolves the font directory from an explicit path, the environment or the app default', () => {
    expect(resolveFontDir('/tmp/example-fonts')).toBe('/tmp/example-fonts');
    expect(resolveFontDir()).toMatch(/apps[/\\]server[/\\]fonts$/u);
  });

  it('reports every family missing when the directory does not exist', () => {
    const catalog = loadFontCatalog('/nonexistent/bokydo-fonts-for-tests');
    expect(catalog.families).toEqual({});
    expect(catalog.missing).toEqual(['sans', 'mono', 'cjk', 'khmer']);
  });
});

describe('PDF font manifest', () => {
  const locked = JSON.parse(readFileSync(LOCK_URL, 'utf8')) as {
    licence: string;
    licenceFile: string;
    fonts: LockedFont[];
  };

  it('pins every file the renderer names, exactly once', () => {
    const wanted = Object.values(FONT_FILES).flatMap((files) => [
      files.regular,
      ...(files.bold ? [files.bold] : []),
      ...(files.italic ? [files.italic] : []),
      ...(files.boldItalic ? [files.boldItalic] : []),
    ]);
    expect(locked.fonts.map((font) => font.file).sort()).toEqual([...wanted].sort());
    expect(new Set(locked.fonts.map((font) => font.file)).size).toBe(locked.fonts.length);
  });

  it('uses official notofonts release assets at an exact version, with SHA-256 for both archive and file', () => {
    for (const font of locked.fonts) {
      expect(font.url).toMatch(
        /^https:\/\/github\.com\/notofonts\/[a-z-]+\/releases\/download\/[^/]+\/[^/]+$/u,
      );
      expect(font.version).toMatch(/^\d+\.\d{3}$/u);
      expect(font.archiveSha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(font.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(font.licence).toBe('OFL-1.1');
      expect(font.archiveEntry).toMatch(/\.(?:ttf|otf)$/u);
    }
  });

  it('keeps the checked-in sha256 list in agreement with the lock file', () => {
    const listed = new Map<string, string>();
    for (const line of readFileSync(SHA_URL, 'utf8').split('\n')) {
      if (line.trim() === '') continue;
      const match = /^([0-9a-f]{64}) {2}(.+)$/u.exec(line);
      expect(match, line).not.toBeNull();
      if (match) listed.set(match[2] ?? '', match[1] ?? '');
    }
    expect([...listed.keys()].sort()).toEqual(locked.fonts.map((font) => font.file).sort());
    for (const font of locked.fonts) expect(listed.get(font.file)).toBe(font.sha256);
  });

  it('ships the OFL text that the lock file names', () => {
    expect(locked.licence).toBe('OFL-1.1');
    expect(locked.licenceFile).toBe('LICENSES/OFL.txt');
    const licenceUrl = new URL(locked.licenceFile, FONTS_URL);
    expect(existsSync(licenceUrl)).toBe(true);
    expect(readFileSync(licenceUrl, 'utf8')).toContain('SIL OPEN FONT LICENSE');
  });
});
