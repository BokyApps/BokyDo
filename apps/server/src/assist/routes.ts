import {
  filterAssistRequestSchema,
  taskAssistRequestSchema,
  type FilterAssistResponse,
  type TaskAssistResponse,
} from '@bokydo/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AiService } from '../ai/service.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { Database } from '../db/client.js';
import { callerScope, requireUser } from '../http/access.js';
import { parseBody } from '../http/validation.js';
import { aiError } from '../ramble/routes.js';
import type { SettingsService } from '../settings/settings-service.js';
import { AssistNotFoundError, AssistUnusableError, filterAssist, taskAssist } from './assist.js';

const perMinute = (max: number) =>
  new RateLimiter({ windowMs: 60_000, maxPerWindow: max, freeFailures: 0, maxBackoffMs: 0 });

/** Task Assist and Filter Assist: suggestions only; the client applies what the user accepts. */
export function registerAssistRoutes(
  app: FastifyInstance,
  deps: { db: Database; settings: SettingsService; ai: AiService },
): void {
  const { db, settings, ai } = deps;
  const limiter = perMinute(30);
  const tooMany = (reply: FastifyReply) => reply.status(429).send({ error: 'too_many_requests' });
  const abortOnClose = (reply: FastifyReply) => {
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });
    return controller.signal;
  };

  app.post(
    '/api/v1/assist/task',
    { config: { access: 'user', scopes: ['ai:use', 'tasks:read'] } },
    async (req, reply) => {
      const body = parseBody(taskAssistRequestSchema, req.body, reply);
      if (!body) return;
      const me = requireUser(req);
      if (!limiter.attempt(me.id).allowed) return tooMany(reply);
      try {
        const suggestion = await taskAssist(
          db,
          ai,
          { id: me.id, isAdmin: me.isAdmin },
          body.taskId,
          callerScope(req),
          settings.get('instance.defaultTimezone'),
          abortOnClose(reply),
        );
        return { suggestion } satisfies TaskAssistResponse;
      } catch (err) {
        if (err instanceof AssistNotFoundError)
          return reply.status(404).send({ error: 'not_found' });
        return aiError(err, reply);
      }
    },
  );

  app.post(
    '/api/v1/assist/filter',
    { config: { access: 'user', scopes: ['ai:use', 'projects:read'] } },
    async (req, reply) => {
      const body = parseBody(filterAssistRequestSchema, req.body, reply);
      if (!body) return;
      const me = requireUser(req);
      if (!limiter.attempt(me.id).allowed) return tooMany(reply);
      try {
        const result: FilterAssistResponse = await filterAssist(
          db,
          ai,
          { id: me.id, isAdmin: me.isAdmin },
          body.text,
          callerScope(req),
          settings.get('instance.defaultTimezone'),
          abortOnClose(reply),
        );
        return result;
      } catch (err) {
        if (err instanceof AssistUnusableError)
          return reply.status(422).send({ error: 'ai_unusable' });
        return aiError(err, reply);
      }
    },
  );
}
