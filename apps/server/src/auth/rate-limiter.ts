/**
 * In-memory limiter for authentication endpoints (single replica; moves to Postgres when BokyDo
 * supports several). Two mechanisms:
 *  - a fixed window per key (e.g. per client IP), and
 *  - exponential backoff per key after repeated failures (e.g. per username), capped so an
 *    attacker can delay but never permanently lock out a real user.
 */
export interface LimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  windowStart: number;
  count: number;
  failures: number;
  blockedUntil: number;
}

export interface RateLimiterOptions {
  windowMs: number;
  maxPerWindow: number;
  /** Failures allowed before backoff starts. */
  freeFailures: number;
  maxBackoffMs: number;
  maxKeys?: number;
  now?: () => number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(private readonly opts: RateLimiterOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** Count an attempt (of the given cost); returns whether it may proceed. */
  attempt(key: string, cost = 1): LimitResult {
    const now = this.now();
    const bucket = this.bucket(key, now);
    if (bucket.blockedUntil > now) {
      return { allowed: false, retryAfterSeconds: Math.ceil((bucket.blockedUntil - now) / 1000) };
    }
    if (now - bucket.windowStart >= this.opts.windowMs) {
      bucket.windowStart = now;
      bucket.count = 0;
    }
    bucket.count += cost;
    if (bucket.count > this.opts.maxPerWindow) {
      const retry = bucket.windowStart + this.opts.windowMs - now;
      return { allowed: false, retryAfterSeconds: Math.ceil(retry / 1000) };
    }
    return { allowed: true, retryAfterSeconds: 0 };
  }

  failure(key: string): void {
    const now = this.now();
    const bucket = this.bucket(key, now);
    bucket.failures++;
    const over = bucket.failures - this.opts.freeFailures;
    if (over > 0) {
      bucket.blockedUntil = now + Math.min(1000 * 2 ** (over - 1), this.opts.maxBackoffMs);
    }
  }

  success(key: string): void {
    this.buckets.delete(key);
  }

  private bucket(key: string, now: number): Bucket {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= (this.opts.maxKeys ?? 10_000)) {
        // Evict the oldest entry (Map preserves insertion order) to bound memory.
        const oldest = this.buckets.keys().next().value;
        if (oldest !== undefined) this.buckets.delete(oldest);
      }
      bucket = { windowStart: now, count: 0, failures: 0, blockedUntil: 0 };
      this.buckets.set(key, bucket);
    }
    return bucket;
  }
}
