import { todoistConnectSchema, todoistImportChoicesSchema } from '@bokydo/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { RateLimiter } from '../auth/rate-limiter.js';
import { requireSession } from '../http/access.js';
import { parseBody } from '../http/validation.js';
import { TodoistError } from './todoist-client.js';
import { ImportSessionError, type TodoistImporter } from './todoist-import.js';

const TODOIST_STATUS: Record<TodoistError['reason'], number> = {
  unauthorized: 422,
  unavailable: 502,
  too_large: 413,
  invalid_response: 502,
  // The chosen window is longer than Todoist allows: the user can pick a shorter one.
  window_too_long: 400,
  // More pages of completed tasks than the cap: the account is simply very busy.
  too_many_pages: 413,
};
const SESSION_STATUS: Record<ImportSessionError['code'], number> = {
  session_expired: 404,
  import_running: 409,
  invalid_choice: 400,
};

/**
 * Settings → Your data → Import from Todoist. Session-only (a bearer token can't reach it): the
 * user hands over a credential for another service, so it happens in the app, never through the
 * API. The Todoist token is in one request body, used once, and never stored, logged or echoed.
 */
export function registerImportRoutes(app: FastifyInstance, importer: TodoistImporter): void {
  const user = { config: { access: 'user' } } as const;
  const window = { windowMs: 3600_000, freeFailures: Number.POSITIVE_INFINITY, maxBackoffMs: 0 };
  const connects = new RateLimiter({ ...window, maxPerWindow: 10 });
  const runs = new RateLimiter({ ...window, maxPerWindow: 20 });

  const failed = (err: unknown, reply: FastifyReply) => {
    if (err instanceof TodoistError)
      return reply.status(TODOIST_STATUS[err.reason]).send({ error: `todoist_${err.reason}` });
    if (err instanceof ImportSessionError)
      return reply.status(SESSION_STATUS[err.code]).send({ error: err.code });
    throw err;
  };
  const tooMany = (reply: FastifyReply, retryAfter: number) => {
    reply.header('Retry-After', String(retryAfter));
    return reply.status(429).send({ error: 'too_many_requests' });
  };

  app.post('/api/v1/import/todoist/connect', user, async (req, reply) => {
    const body = parseBody(todoistConnectSchema, req.body, reply);
    if (!body) return;
    const me = requireSession(req).user;
    const limit = connects.attempt(me.id);
    if (!limit.allowed) return tooMany(reply, limit.retryAfterSeconds);
    try {
      return await importer.connect(me.id, body.token);
    } catch (err) {
      return failed(err, reply);
    }
  });

  app.post('/api/v1/import/todoist/disconnect', user, async (req, reply) => {
    const body = parseBody(z.object({ sessionId: z.string().max(64) }).strict(), req.body, reply);
    if (!body) return;
    importer.disconnect(requireSession(req).user.id, body.sessionId);
    return reply.status(204).send();
  });

  app.post('/api/v1/import/todoist/plan', user, async (req, reply) => {
    const body = parseBody(todoistImportChoicesSchema, req.body, reply);
    if (!body) return;
    try {
      return await importer.plan(requireSession(req).user.id, body);
    } catch (err) {
      return failed(err, reply);
    }
  });

  app.post('/api/v1/import/todoist/runs', user, async (req, reply) => {
    const body = parseBody(todoistImportChoicesSchema, req.body, reply);
    if (!body) return;
    const me = requireSession(req).user;
    const limit = runs.attempt(me.id);
    if (!limit.allowed) return tooMany(reply, limit.retryAfterSeconds);
    try {
      return reply.status(202).send(await importer.start(me.id, body));
    } catch (err) {
      return failed(err, reply);
    }
  });

  app.get('/api/v1/import/todoist/runs/latest', user, async (req) => ({
    run: await importer.latest(requireSession(req).user.id),
  }));

  app.get('/api/v1/import/todoist/runs/:id', user, async (req, reply) => {
    const params = z.object({ id: z.uuid() }).strict().safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'not_found' });
    const run = await importer.status(requireSession(req).user.id, params.data.id);
    if (!run) return reply.status(404).send({ error: 'not_found' });
    return { run };
  });
}
