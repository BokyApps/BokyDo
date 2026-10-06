import type { FastifyBaseLogger } from 'fastify';

export interface Job {
  name: string;
  run(now: Date): Promise<unknown>;
}

/**
 * Background work (reminders, notification delivery, digests) on a short timer. State lives in
 * Postgres (due times, `firedFor`, the notification outbox), so a restart simply catches up on
 * the next tick. Ticks never overlap; a failing job is logged and retried on the next tick.
 */
export class JobRunner {
  private timer: NodeJS.Timeout | null = null;
  private started = false;
  private current: Promise<void> = Promise.resolve();

  constructor(
    private readonly jobs: Job[],
    private readonly log: FastifyBaseLogger,
    private readonly intervalMs = 10_000,
  ) {}

  start(): void {
    this.started = true;
    this.schedule(1000);
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.current;
  }

  /** Run soon (e.g. after a write that created notifications). */
  poke(): void {
    if (this.started) this.schedule(200);
  }

  /** Run every job once, after any tick already in progress. */
  tick(now?: Date): Promise<void> {
    this.current = this.current.then(() => this.runAll(now ?? new Date()));
    return this.current;
  }

  private async runAll(now: Date): Promise<void> {
    for (const job of this.jobs) {
      try {
        await job.run(now);
      } catch (err) {
        this.log.warn({ err, job: job.name }, 'background job failed');
      }
    }
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.tick().finally(() => {
        if (this.started && !this.timer) this.schedule(this.intervalMs);
      });
    }, delayMs);
    this.timer.unref();
  }
}
