import {
  askConfirmSchema,
  askRequestSchema,
  filterAssistRequestSchema,
  reportRequestSchema,
  taskAssistRequestSchema,
  type FilterAssistResponse,
  type TaskAssistResponse,
} from '@bokydo/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AiService } from '../ai/service.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { Database } from '../db/client.js';
import { callerScope, requireSession, requireUser } from '../http/access.js';
import { parseBody } from '../http/validation.js';
import { aiError } from '../ramble/routes.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { SyncService } from '../sync/sync-service.js';
import { ask, confirm, type AskDeps } from './ask.js';
import { report } from './report.js';
import { AssistNotFoundError, AssistUnusableError, filterAssist, taskAssist } from './assist.js';

const perMinute = (max: number) =>
  new RateLimiter({ windowMs: 60_000, maxPerWindow: max, freeFailures: 0, maxBackoffMs: 0 });

/**
 * Task Assist, Filter Assist and Ask your tasks. None of them writes on its own: the client
 * applies what the user accepts (Ask: through the confirm endpoint, one change at a time).
 */
export function registerAssistRoutes(
  app: FastifyInstance,
  deps: { db: Database; settings: SettingsService; ai: AiService; sync: SyncService },
): void {
  const { db, settings, ai, sync } = deps;
  const limiter = perMinute(30);
  const asks = perMinute(20);
  const confirms = perMinute(60);
  const askDeps = (): AskDeps => ({
    db,
    sync,
    ai,
    baseUrl: settings.get('instance.publicUrl') ?? '',
    defaultTimeZone: settings.get('instance.defaultTimezone'),
  });
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

  app.post(
    '/api/v1/assist/report',
    { config: { access: 'user', scopes: ['ai:use', 'tasks:read'] } },
    async (req, reply) => {
      const body = parseBody(reportRequestSchema, req.body, reply);
      if (!body) return;
      const me = requireUser(req);
      if (!limiter.attempt(me.id).allowed) return tooMany(reply);
      try {
        return await report(
          db,
          ai,
          { id: me.id, isAdmin: me.isAdmin },
          body.kind,
          body.projectId,
          callerScope(req),
          settings.get('instance.defaultTimezone'),
          abortOnClose(reply),
        );
      } catch (err) {
        if (err instanceof AssistNotFoundError)
          return reply.status(404).send({ error: 'not_found' });
        return aiError(err, reply);
      }
    },
  );

  // Session only: an app with a token has its own model and the MCP server.
  app.post('/api/v1/assist/ask', { config: { access: 'user' } }, async (req, reply) => {
    const body = parseBody(askRequestSchema, req.body, reply);
    if (!body) return;
    const me = requireSession(req).user;
    if (!asks.attempt(me.id).allowed) return tooMany(reply);
    try {
      return await ask(
        askDeps(),
        { id: me.id, isAdmin: me.isAdmin },
        body.messages,
        abortOnClose(reply),
      );
    } catch (err) {
      return aiError(err, reply);
    }
  });

  /** One proposed change the user confirmed: run like the MCP tool, with their own rights. */
  app.post('/api/v1/assist/ask/confirm', { config: { access: 'user' } }, async (req, reply) => {
    const body = parseBody(askConfirmSchema, req.body, reply);
    if (!body) return;
    const me = requireSession(req).user;
    if (!confirms.attempt(me.id).allowed) return tooMany(reply);
    const done = await confirm(askDeps(), me.id, body.tool, body.args);
    if (!done.ok) return reply.status(422).send({ error: 'not_done', message: done.message });
    return { result: done.result };
  });
}
