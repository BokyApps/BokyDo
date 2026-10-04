import { describe, expect, it } from 'vitest';
import { RateLimiter } from './rate-limiter.js';

const make = () => {
  let t = 0;
  const limiter = new RateLimiter({
    windowMs: 60_000,
    maxPerWindow: 3,
    freeFailures: 2,
    maxBackoffMs: 8_000,
    maxKeys: 3,
    now: () => t,
  });
  return { limiter, advance: (ms: number) => (t += ms) };
};

describe('RateLimiter', () => {
  it('caps attempts per window', () => {
    const { limiter, advance } = make();
    expect([1, 2, 3, 4].map(() => limiter.attempt('ip').allowed)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    advance(60_000);
    expect(limiter.attempt('ip').allowed).toBe(true);
  });

  it('backs off exponentially after free failures, capped', () => {
    const { limiter, advance } = make();
    limiter.failure('u');
    limiter.failure('u');
    expect(limiter.attempt('u').allowed).toBe(true);
    limiter.failure('u'); // 1s
    expect(limiter.attempt('u')).toEqual({ allowed: false, retryAfterSeconds: 1 });
    advance(1000);
    for (let i = 0; i < 10; i++) limiter.failure('u');
    expect(limiter.attempt('u').retryAfterSeconds).toBe(8); // capped, never permanent
    advance(8000);
    expect(limiter.attempt('u').allowed).toBe(true);
  });

  it('resets on success', () => {
    const { limiter } = make();
    for (let i = 0; i < 5; i++) limiter.failure('u');
    limiter.success('u');
    expect(limiter.attempt('u').allowed).toBe(true);
  });

  it('bounds memory', () => {
    const { limiter } = make();
    for (let i = 0; i < 100; i++) limiter.attempt(`k${i}`);
    expect((limiter as unknown as { buckets: Map<string, unknown> }).buckets.size).toBe(3);
  });
});
