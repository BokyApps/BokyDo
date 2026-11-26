import { PNG_1X1, collect, makePng, readZipEntries } from './test-support.js';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_LIMITS,
  ExportDeadline,
  ExportTimeoutError,
  TooLargeError,
  type ExportLimits,
} from './limits.js';
import { ExportWorker, type NoteExportInternal } from './runner.js';
import type { WorkerImage } from './worker.js';

/**
 * The worker boundary's own tests. They run the real thread, the real tsx/dev resolution and
 * the real renderers; nothing here reaches into the route or the database.
 */

const limits = (overrides: Partial<ExportLimits> = {}): ExportLimits => ({
  ...DEFAULT_EXPORT_LIMITS,
  ...overrides,
});

interface Harness {
  worker: ExportWorker;
  releases: number;
  exits: number;
}

function worker(
  opts: {
    limits?: Partial<ExportLimits>;
    deadlineMs?: number;
    internal?: NoteExportInternal;
  } = {},
): Harness {
  const harness: Harness = { worker: null as unknown as ExportWorker, releases: 0, exits: 0 };
  const internal: NoteExportInternal = {
    ...opts.internal,
    onWorkerExit: () => {
      harness.exits++;
      opts.internal?.onWorkerExit?.();
    },
  };
  harness.worker = new ExportWorker({
    limits: limits(opts.limits),
    deadline: new ExportDeadline(opts.deadlineMs ?? 15_000),
    release: () => {
      harness.releases++;
    },
    internal,
  });
  return harness;
}

function renderMessage(format: 'docx' | 'pdf') {
  return { format, title: 'Worker test', fileNames: [] as [string, string][] };
}

/** Bytes as the worker takes them: a transferred ArrayBuffer, never a pooled Buffer. */
function image(id: string, filename: string, bytes: Buffer): WorkerImage {
  return {
    id,
    filename,
    bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  };
}

describe('note export worker', () => {
  it('parses in the worker and renders Markdown there', async () => {
    const harness = worker();
    try {
      const analysis = await harness.worker.analyze('Hello **world** and `code`\n');
      expect(analysis.size.blocks).toBe(1);
      expect(analysis.tokens).toBeGreaterThan(0);
      const result = await harness.worker.renderMarkdown({
        title: 'Greeting',
        fileNames: [],
      });
      expect(result.markdown).toBe('# Greeting\n\nHello **world** and `code`\n');
      expect(result.fileIds).toEqual([]);
    } finally {
      await harness.worker.dispose();
    }
    expect(harness.releases).toBe(1);
    expect(harness.exits).toBe(1);
  });

  it('streams a PDF through the ack protocol', async () => {
    const harness = worker();
    try {
      await harness.worker.analyze('Hello world\n');
      const stream = await harness.worker.render(renderMessage('pdf'));
      const pdf = await collect(stream);
      expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    } finally {
      await harness.worker.dispose();
    }
    expect(harness.releases).toBe(1);
  });

  it('rejects a sparse-table bomb before markdown-it can allocate', async () => {
    const harness = worker();
    try {
      const row = `|${' |'.repeat(2500)}a|\n`;
      const body = row.repeat(21); // 52,542 pipes
      const started = performance.now();
      await expect(harness.worker.analyze(body)).rejects.toBeInstanceOf(TooLargeError);
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      await harness.worker.dispose();
    }
    expect(harness.releases).toBe(1);
  });

  it('refuses a 512 KiB list body quickly instead of crashing', async () => {
    const harness = worker();
    try {
      const body = '- a\n'.repeat(131_072);
      expect(body.length).toBe(524_288);
      const started = performance.now();
      await expect(harness.worker.analyze(body)).rejects.toBeInstanceOf(TooLargeError);
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      await harness.worker.dispose();
    }
  });

  it('kills a worker that runs out of heap and reports 413, then keeps working', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const harness = worker({ internal: { testRenderer: 'oom' } });
      try {
        await harness.worker.analyze('Hello\n');
        await expect(harness.worker.render(renderMessage('docx'))).rejects.toBeInstanceOf(
          TooLargeError,
        );
      } finally {
        await harness.worker.dispose();
      }
      expect(harness.releases).toBe(1);
      expect(harness.exits).toBe(1);

      // The process survived; a fresh worker renders normally.
      const next = worker();
      try {
        await next.worker.analyze('Hello again\n');
        const stream = await next.worker.render(renderMessage('pdf'));
        expect((await collect(stream)).subarray(0, 5).toString('latin1')).toBe('%PDF-');
      } finally {
        await next.worker.dispose();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('answers an internally thrown render with an error, never a crash', async () => {
    const harness = worker({ internal: { testRenderer: 'throw' } });
    try {
      await harness.worker.analyze('Hello\n');
      const error = await harness.worker.render(renderMessage('pdf')).then(
        () => null,
        (err: Error) => err,
      );
      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain('injected worker render failure');
      expect(error).not.toBeInstanceOf(TooLargeError);
    } finally {
      await harness.worker.dispose();
    }
    expect(harness.releases).toBe(1);
  });

  it('terminates a slow render at the deadline and frees the slot for the next worker', async () => {
    // Long enough for the worker to start and answer `analyze`; the injected render then hangs.
    const slow = worker({ deadlineMs: 1500, internal: { testRenderer: 'slow' } });
    try {
      await slow.worker.analyze('Hello\n');
      await expect(slow.worker.render(renderMessage('docx'))).rejects.toBeInstanceOf(
        ExportTimeoutError,
      );
      await slow.worker.dispose();
    } finally {
      await slow.worker.dispose();
    }
    expect(slow.releases).toBe(1);
    expect(slow.exits).toBe(1);

    // The next export (its own worker/slot) succeeds.
    const next = worker();
    try {
      await next.worker.analyze('Hello\n');
      const stream = await next.worker.render(renderMessage('pdf'));
      expect((await collect(stream)).subarray(0, 5).toString('latin1')).toBe('%PDF-');
    } finally {
      await next.worker.dispose();
    }
  });

  it('kills the worker when the consumer disconnects mid-render', async () => {
    let exited!: () => void;
    const exit = new Promise<void>((resolve) => {
      exited = resolve;
    });
    const harness = worker({
      internal: { testRenderer: 'slow-stream', onWorkerExit: () => exited() },
    });
    try {
      await harness.worker.analyze('Hello\n');
      const stream = await harness.worker.render(renderMessage('docx'));
      stream.destroy();
      await Promise.race([
        exit,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('worker did not exit after disconnect')), 5000),
        ),
      ]);
    } finally {
      await harness.worker.dispose();
    }
    expect(harness.exits).toBe(1);
    expect(harness.releases).toBe(1);
  });

  it('stops a render that passes the output cap and reports 413', async () => {
    const harness = worker({ limits: { maxOutputBytes: 16 } });
    try {
      await harness.worker.analyze('Hello world, a paragraph long enough to emit bytes.\n');
      await expect(harness.worker.render(renderMessage('pdf'))).rejects.toBeInstanceOf(
        TooLargeError,
      );
    } finally {
      await harness.worker.dispose();
    }
    expect(harness.releases).toBe(1);
  });

  it('validates images inside the worker: a bad CRC never reaches DOCX', async () => {
    const goodId = '11111111-1111-4111-8111-111111111111';
    const badId = '22222222-2222-4222-8222-222222222222';
    const corrupt = makePng({ colorType: 2, corruptIdatCrc: true });
    const harness = worker();
    try {
      await harness.worker.analyze(
        `![good](/api/v1/note-files/${goodId}?inline=1)\n\n![bad](/api/v1/note-files/${badId}?inline=1)\n`,
      );
      const stream = await harness.worker.render({
        format: 'docx',
        title: 'Images',
        fileNames: [
          [goodId, 'good.png'],
          [badId, 'bad.png'],
        ],
        images: [image(goodId, 'good.png', PNG_1X1), image(badId, 'bad.png', corrupt)],
      });
      const media = [...readZipEntries(await collect(stream)).keys()].filter((name) =>
        name.startsWith('word/media/'),
      );
      expect(media).toHaveLength(1);
    } finally {
      await harness.worker.dispose();
    }
  });

  it('refuses a 20,000-chunk PNG quickly in the worker', async () => {
    const id = '33333333-3333-4333-8333-333333333333';
    const bomb = makePng({
      colorType: 2,
      extra: Array.from({ length: 20_000 }, () => ({ type: 'tEXt', data: Buffer.alloc(0) })),
    });
    const harness = worker();
    try {
      await harness.worker.analyze(`![bomb](/api/v1/note-files/${id}?inline=1)\n`);
      const started = performance.now();
      const stream = await harness.worker.render({
        format: 'docx',
        title: 'Bomb',
        fileNames: [[id, 'bomb.png']],
        images: [image(id, 'bomb.png', bomb)],
      });
      const media = [...readZipEntries(await collect(stream)).keys()].filter((name) =>
        name.startsWith('word/media/'),
      );
      expect(performance.now() - started).toBeLessThan(2000);
      // The chunk cap refuses it, so it is drawn as its name, never embedded.
      expect(media).toEqual([]);
    } finally {
      await harness.worker.dispose();
    }
  });
});
