import { collect } from './test-support.js';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXPORT_LIMITS,
  ExportDeadline,
  ExportTimeoutError,
  TooLargeError,
  type ExportLimits,
} from './limits.js';
import { ExportWorker, type NoteExportInternal } from './runner.js';

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
});
