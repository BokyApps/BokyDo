import { describe, expect, it } from 'vitest';
import { ExportSemaphore } from './limits.js';

const MiB = 1024 * 1024;

describe('export admission', () => {
  // A 1 GiB limit at 85 % leaves ~870 MiB; with 300 MiB already resident, one 400 MiB peak fits
  // (700) but a second, or a 250 MiB Markdown peak beside it, does not (950 / 1100).
  const memory = (peakBytes: number) => ({
    limitBytes: 1024 * MiB,
    rssBytes: 300 * MiB,
    peakBytes,
    fraction: 0.85,
  });

  it('reserves each admitted peak, so overlapping requests cannot share the headroom', () => {
    const semaphore = new ExportSemaphore(1, 1, 2);
    const first = semaphore.tryAdmit('u1', 'file', memory(400 * MiB));
    expect(typeof first).toBe('function');
    expect(semaphore.reserved).toBe(400 * MiB);
    // Same fixed RSS: without the reservation this Markdown export would have been admitted.
    expect(semaphore.tryAdmit('u2', 'markdown', memory(250 * MiB))).toBe('overloaded');
    if (typeof first === 'function') first();
    expect(semaphore.reserved).toBe(0);
    const second = semaphore.tryAdmit('u2', 'markdown', memory(250 * MiB));
    expect(typeof second).toBe('function');
    if (typeof second === 'function') second();
  });

  it('refuses a busy pool before considering memory, and releases only once', () => {
    const semaphore = new ExportSemaphore(1, 1, 2);
    const first = semaphore.tryAdmit('u1', 'file', memory(100 * MiB));
    expect(semaphore.tryAdmit('u2', 'file', memory(100 * MiB))).toBe('busy');
    expect(semaphore.tryAdmit('u1', 'markdown', memory(100 * MiB))).toBe('busy');
    if (typeof first === 'function') {
      first();
      first();
    }
    expect(semaphore.reserved).toBe(0);
    expect(semaphore.running).toBe(0);
  });
});
