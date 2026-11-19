import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

  it('checks the reserved stem before the first dot, superscript digits included', () => {
    // `COM1.backup.txt` is still the COM1 device on Windows: the device name is the stem before
    // the first dot, not before the last one.
    expect(safeEntryName('files/COM1.backup.txt')).toBe('files/_COM1.backup.txt');
    expect(safeEntryName('files/com¹.txt')).toBe('files/_com¹.txt');
    expect(safeEntryName('files/LPT³.log')).toBe('files/_LPT³.log');
    expect(safeEntryName('files/COM¹⁰.txt')).toBe('files/COM¹⁰.txt');
    expect(safeEntryName('files/LPT¹0.txt')).toBe('files/LPT¹0.txt');
  });

  it('folds compatibility forms and trailing spaces before the device check', () => {
    // NFKC folds full-width letters and superscript digits: these are the same devices.
    expect(safeEntryName('files/ＣＯＮ.txt')).toBe('files/_ＣＯＮ.txt');
    expect(safeEntryName('files/COM².txt')).toBe('files/_COM².txt');
    expect(safeEntryName('files/con .txt')).toBe('files/_con .txt');
    expect(safeEntryName('files/con. .txt')).toBe('files/_con. .txt');
    // …but a longer number is not a device, in any form.
    expect(safeEntryName('files/COM10.txt')).toBe('files/COM10.txt');
    expect(safeEntryName('files/COM¹¹.txt')).toBe('files/COM¹¹.txt');
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

  it('has no unhandled rejection when the reader disappears mid-entry', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const zip = new ZipWriter();
      zip.stream.on('error', () => undefined);
      // Incompressible, so the entry really is under backpressure when the output is destroyed.
      const done = zip.add('big.bin', randomBytes(8 * 1024 * 1024));
      await new Promise((resolve) => setTimeout(resolve, 25));
      zip.stream.destroy(new Error('client went away'));
      // One observed pipeline promise rejects; nothing else is left dangling.
      let rejections = 0;
      await done.catch(() => {
        rejections++;
      });
      expect(rejections).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('does not accumulate close listeners on the shared output over 100 entries', async () => {
    const warnings: Error[] = [];
    const onWarning = (warning: Error) => warnings.push(warning);
    process.on('warning', onWarning);
    try {
      const zip = new ZipWriter();
      const written = collect(zip.stream);
      // Two permanent listeners: the entry teardown and the signal cleanup. The point is that
      // neither grows by one per entry.
      const closeListeners = zip.stream.listenerCount('close');
      expect(closeListeners).toBeGreaterThan(0);
      for (let index = 0; index < 100; index++) {
        await zip.add(`entry-${index}.txt`, `value ${index}`);
        expect(zip.stream.listenerCount('close'), `after entry ${index}`).toBe(closeListeners);
      }
      await zip.finish();
      const entries = readZipEntries(await written);
      expect(entries.size).toBe(100);
      // The stream's own close cleanup removes one listener when it finishes; nothing added.
      expect(zip.stream.listenerCount('close')).toBeLessThanOrEqual(closeListeners);
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings.filter((warning) => warning.name === 'MaxListenersExceededWarning')).toEqual(
      [],
    );
  });

  it('stops reading a file between chunks when the signal is aborted', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bokydo-zip-'));
    const file = path.join(dir, 'big.bin');
    try {
      await writeFile(file, randomBytes(4 * 1024 * 1024));
      const abort = new AbortController();
      const zip = new ZipWriter({ signal: abort.signal });
      zip.stream.on('error', () => undefined);
      zip.stream.resume();
      let reads = 0;
      const done = zip.addFile('big.bin', file, {
        onRead: () => {
          reads++;
          if (reads === 1) abort.abort(new Error('client went away'));
        },
      });
      await expect(done).rejects.toThrow('client went away');
      // The first 64 KiB chunk was read; the abort stopped the rest of the 4 MiB file.
      expect(reads).toBe(1);
      zip.abort(new Error('client went away'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('destroys a producer stalled on a reader that never reads when its deadline fires', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'bokydo-zip-'));
    const file = path.join(dir, 'big.bin');
    try {
      await writeFile(file, randomBytes(4 * 1024 * 1024));
      const abort = new AbortController();
      const zip = new ZipWriter({ signal: abort.signal });
      zip.stream.on('error', () => undefined);
      // No consumer: the shared stream buffers its 16 KiB and the producer waits on backpressure.
      const done = zip.addFile('big.bin', file);
      setTimeout(() => abort.abort(new Error('deadline')), 25);
      await expect(done).rejects.toThrow(/deadline|zip stream closed/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
