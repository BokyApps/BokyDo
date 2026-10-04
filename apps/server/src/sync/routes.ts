import { syncRequestSchema } from '@bokydo/shared';
import type { FastifyInstance } from 'fastify';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { SessionStore } from '../auth/sessions.js';
import { readSessionToken, requireSession } from '../http/access.js';
import { parseBody } from '../http/validation.js';
import type { EventBus } from './events.js';
import type { SyncService } from './sync-service.js';

const HEARTBEAT_MS = 25_000;

export function registerSyncRoutes(
  app: FastifyInstance,
  deps: { sync: SyncService; events: EventBus; sessions: SessionStore },
): void {
  // Writes serialise on one lock, so one user mustn't be able to monopolise it.
  const window = { windowMs: 60_000, freeFailures: Number.POSITIVE_INFINITY, maxBackoffMs: 0 };
  const requests = new RateLimiter({ ...window, maxPerWindow: 120 });
  const commands = new RateLimiter({ ...window, maxPerWindow: 1200 });

  app.post('/api/v1/sync', { config: { access: 'user' } }, async (req, reply) => {
    const body = parseBody(syncRequestSchema, req.body, reply);
    if (!body) return;
    const userId = requireSession(req).user.id;
    for (const check of [
      requests.attempt(userId),
      commands.attempt(userId, body.commands?.length ?? 0),
    ]) {
      if (!check.allowed) {
        reply.header('Retry-After', String(check.retryAfterSeconds));
        return reply.status(429).send({ error: 'too_many_requests' });
      }
    }
    return deps.sync.sync(userId, body);
  });

  /**
   * Server-sent events: `poke` means "call /sync". Same-origin cookie auth (EventSource can't be
   * read cross-origin without CORS, which we never enable). The session is re-validated on every
   * heartbeat so a revoked or expired session stops receiving within one interval.
   */
  app.get('/api/v1/sync/events', { config: { access: 'user' } }, (req, reply) => {
    const session = requireSession(req);
    const token = readSessionToken(req);
    const res = reply.raw;
    let closed = false;
    let heartbeat: NodeJS.Timeout | undefined = undefined;
    let unsubscribe: (() => void) | null = null;

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsubscribe?.();
      res.end();
    };

    unsubscribe = deps.events.subscribe({
      userId: session.user.id,
      sessionId: session.id,
      poke: () => !closed && res.write('event: poke\ndata: {}\n\n'),
      close,
    });
    if (!unsubscribe) return reply.status(429).send({ error: 'too_many_requests' });

    reply.hijack();
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      // Disable proxy buffering (nginx) so events arrive immediately.
      'x-accel-buffering': 'no',
    });
    res.write('retry: 5000\n: connected\n\n');

    heartbeat = setInterval(() => {
      void (async () => {
        const still = token ? await deps.sessions.lookup(token) : null;
        if (!still || still.id !== session.id || still.user.mustChangePassword) return close();
        res.write(': heartbeat\n\n');
      })().catch(close);
    }, HEARTBEAT_MS);
    req.raw.on('close', close);
  });
}
