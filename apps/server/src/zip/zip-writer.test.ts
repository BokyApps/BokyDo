import { describe, expect, it } from 'vitest';
import { ZipWriter, safeEntryName } from './zip-writer.js';
import { collect, readZipEntries } from '../note-export/test-support.js';

/**
 * The streaming writer's two contracts that matter to an export: a path that is safe on every
 * platform, and a producer that stops when the reader goes away instead of waiting for a
 * `'drain'` that never comes.
 */

describe('archive entry names', () => {
  it('strips a drive prefix and turns Windows separators into path separators', () => {
    expect(safeEntryName('C:\\Users\\ana\\note.md')).toBe('Users/ana/note.md');
    expect(safeEntryName('c:/temp/x.txt')).toBe('temp/x.txt');
    expect(safeEntryName('C:')).toBe('file');
  });

  it('drops `..`, dot segments and control characters', () => {
    expect(safeEntryName('../../etc/passwd')).toBe('etc/passwd');
    expect(safeEntryName('/abs/path')).toBe('abs/path');
    expect(safeEntryName('a\u0000b\u007fc.txt')).toBe('abc.txt');
    expect(safeEntryName('./')).toBe('file');
  });

  it('neutralises Windows device names, trailing dots and spaces', () => {
    expect(safeEntryName('CON')).toBe('_CON');
    expect(safeEntryName('files/COM1.txt')).toBe('files/_COM1.txt');
    expect(safeEntryName('files/LPT9.log')).toBe('files/_LPT9.log');
    expect(safeEntryName('files/CONSOLE.txt')).toBe('files/CONSOLE.txt');
    expect(safeEntryName('files/name. . ')).toBe('files/name');
    expect(safeEntryName('files/a:b*c?.txt')).toBe('files/a_b_c_.txt');
  });

  it('bounds every component to 200 UTF-8 bytes without splitting a character', () => {
    const name = safeEntryName(`files/${'é'.repeat(150)}.png`);
    const component = name.split('/')[1] ?? '';
    expect(Buffer.byteLength(component)).toBeLessThanOrEqual(200);
    expect(component.endsWith('\uFFFD')).toBe(false);
    expect(component.startsWith('é')).toBe(true);
  });
});

describe('ZipWriter', () => {
  it('writes entries that read back', async () => {
    const zip = new ZipWriter();
    const written = collect(zip.stream);
    await zip.add('a.txt', 'hello');
    await zip.add('b/c.txt', Buffer.from('world'));
    await zip.finish();
    const entries = readZipEntries(await written);
    expect(entries.get('a.txt')?.toString()).toBe('hello');
    expect(entries.get('b/c.txt')?.toString()).toBe('world');
  });

  it('rejects an add whose reader is destroyed, instead of hanging on drain', async () => {
    const zip = new ZipWriter();
    zip.stream.on('error', () => undefined);
    // A big enough body that the deflate output cannot all fit in the PassThrough's buffer,
    // so the producer hits backpressure; the reader then goes away without ever draining.
    const body = Buffer.alloc(8 * 1024 * 1024, 0x61);
    const done = zip.add('big.txt', body);
    await new Promise((resolve) => setImmediate(resolve));
    zip.stream.destroy(new Error('client went away'));
    await expect(done).rejects.toThrow(/zip stream closed|client went away/);
  });
});
