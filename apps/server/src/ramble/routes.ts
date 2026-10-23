import {
  RAMBLE_LIMITS,
  rambleCommitRequestSchema,
  rambleExtractRequestSchema,
  rambleTranscribeQuerySchema,
  type RambleCommitResponse,
  type RambleExtractResponse,
} from '@bokydo/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import { AUDIO_TYPES } from '../ai/media.js';
import { AiNotConfiguredError, type AiService } from '../ai/service.js';
import { AiProviderError } from '../ai/transport.js';
import { AiBudgetExceededError } from '../ai/usage.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { SessionStore } from '../auth/sessions.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { callerScope, originAllowed, readSessionToken, requireUser } from '../http/access.js';
import { parseBody } from '../http/validation.js';
import type { LiveConnector } from '../net/outbound-ws.js';
import type { ApiTokenStore } from '../oauth/token-store.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { SyncService } from '../sync/sync-service.js';
import { relayLive } from './live.js';
import { extract, loadRambleContext, resolveDraftTask } from './ramble.js';

export interface RambleRouteDeps {
  db: Database;
  settings: SettingsService;
  sync: SyncService;
  ai: AiService;
  sessions: SessionStore;
  tokens: ApiTokenStore;
  /** How the relay reaches a provider. */
  connect: LiveConnector;
}

/** Live sessions one user may have open at once. */
const MAX_LIVE_SESSIONS = 2;

/**
 * The most bytes a second of audio plausibly takes: uncompressed PCM up to 48 kHz 16-bit stereo,
 * compressed formats up to 256 kbit/s. A client can't claim a long recording is short to save
 * budget: metering never counts less than the size implies.
 */
const maxBytesPerSecond = (type: string) =>
  type === 'audio/wav' || type === 'audio/x-wav'
    ? 192_000
    : type === 'audio/flac'
      ? 96_000
      : 32_000;

const perMinute = (max: number) =>
  new RateLimiter({ windowMs: 60_000, maxPerWindow: max, freeFailures: 0, maxBackoffMs: 0 });

/** AI failures as HTTP answers; never the provider's own words. */
export function aiError(err: unknown, reply: FastifyReply) {
  if (err instanceof AiNotConfiguredError)
    return reply.status(409).send({ error: 'ai_not_configured', feature: err.feature });
  if (err instanceof AiBudgetExceededError)
    return reply.status(429).send({ error: 'ai_budget_exceeded', kind: err.kind });
  if (err instanceof AiProviderError) {
    if (err.code === 'refused') return reply.status(422).send({ error: 'ai_refused' });
    if (err.code === 'cancelled') return reply.status(499).send({ error: 'cancelled' });
    return reply.status(502).send({ error: 'ai_provider_error', code: err.code });
  }
  throw err;
}

/**
 * Ramble: audio chunks to text, text to a draft of tasks, and the reviewed draft to real tasks.
 * Audio is only held in memory for the transcription call, never stored. The draft lives with
 * the client; every call re-checks it, and committing goes through the sync engine's own checks.
 */
export function registerRambleRoutes(app: FastifyInstance, deps: RambleRouteDeps): void {
  const { db, settings, sync, ai, sessions, tokens, connect } = deps;
  const aiConfig = { config: { access: 'user', scopes: ['ai:use'] } } as const;
  const transcribes = perMinute(40);
  const extractions = perMinute(30);
  const commits = perMinute(30);
  const liveByUser = new Map<string, number>();
  const caller = (req: FastifyRequest) => {
    const u = requireUser(req);
    return { id: u.id, isAdmin: u.isAdmin };
  };
  const tooMany = (reply: FastifyReply) => reply.status(429).send({ error: 'too_many_requests' });
  // Cancelled when the client goes away before the answer, so an abandoned call stops costing
  // money. (The request's own 'close' fires once its body is read, so watch the response.)
  const abortOnClose = (reply: FastifyReply) => {
    const controller = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableEnded) controller.abort();
    });
    return controller.signal;
  };

  void app.register(async (scoped) => {
    scoped.addContentTypeParser(
      /^audio\//,
      { parseAs: 'buffer', bodyLimit: RAMBLE_LIMITS.maxAudioBytes },
      (_req, body, done) => done(null, body),
    );
    scoped.post(
      '/api/v1/ramble/transcribe',
      { ...aiConfig, bodyLimit: RAMBLE_LIMITS.maxAudioBytes },
      async (req, reply) => {
        const me = caller(req);
        const type = (req.headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
        if (!AUDIO_TYPES[type] || !Buffer.isBuffer(req.body))
          return reply.status(415).send({ error: 'unsupported_media_type' });
        const query = rambleTranscribeQuerySchema.safeParse(req.query);
        if (!query.success) return reply.status(400).send({ error: 'validation_failed' });
        const audio = req.body;
        if (audio.length === 0) return reply.status(400).send({ error: 'validation_failed' });
        const seconds = Math.max(query.data.seconds, audio.length / maxBytesPerSecond(type));
        if (seconds > RAMBLE_LIMITS.maxAudioSeconds)
          return reply.status(413).send({ error: 'audio_too_long' });
        if (!transcribes.attempt(me.id).allowed) return tooMany(reply);
        try {
          const text = await ai.transcribe(
            me,
            'ramble.transcribe',
            {
              audio,
              mimeType: type,
              durationSeconds: seconds,
              ...(query.data.language ? { language: query.data.language } : {}),
            },
            { signal: abortOnClose(reply) },
          );
          return { text: text.slice(0, RAMBLE_LIMITS.maxTextChars) };
        } catch (err) {
          return aiError(err, reply);
        }
      },
    );
  });

  app.post('/api/v1/ramble/extract', aiConfig, async (req, reply) => {
    const me = caller(req);
    const body = parseBody(rambleExtractRequestSchema, req.body, reply);
    if (!body) return;
    if (!extractions.attempt(me.id).allowed) return tooMany(reply);
    const ctx = await loadRambleContext(
      db,
      me.id,
      settings.get('instance.defaultTimezone'),
      callerScope(req),
    );
    try {
      const result: RambleExtractResponse = await extract(
        ai,
        me,
        ctx,
        body.draft,
        body.text,
        abortOnClose(reply),
      );
      return result;
    } catch (err) {
      return aiError(err, reply);
    }
  });

  /** Create the reviewed draft's tasks in one go: all of them, or none. */
  app.post(
    '/api/v1/ramble/commit',
    { config: { access: 'user', scopes: ['tasks:write'] } },
    async (req, reply) => {
      const me = caller(req);
      const body = parseBody(rambleCommitRequestSchema, req.body, reply);
      if (!body) return;
      if (!commits.attempt(me.id).allowed) return tooMany(reply);
      const ctx = await loadRambleContext(
        db,
        me.id,
        settings.get('instance.defaultTimezone'),
        callerScope(req),
      );
      const created: RambleCommitResponse['created'] = [];
      const commands = body.tasks.map((t) => {
        const r = resolveDraftTask(t, ctx, t.projectId);
        const id = newId();
        created.push({ ref: t.ref, taskId: id });
        return {
          type: 'task_add' as const,
          args: {
            id,
            content: t.content,
            ...(r.projectId ? { projectId: r.projectId } : {}),
            ...(r.sectionId ? { sectionId: r.sectionId } : {}),
            ...(t.description ? { description: t.description } : {}),
            ...(r.due ? { due: r.due } : {}),
            ...(t.priority ? { priority: t.priority } : {}),
            ...(r.labels.length ? { labels: r.labels } : {}),
            ...(r.assigneeId ? { assigneeId: r.assigneeId } : {}),
          },
        };
      });
      // The sync engine re-checks each task: write access to the project, assignee membership.
      const result = await sync.applyAll(me.id, commands, callerScope(req));
      if (!result.ok)
        return reply.status(result.result.ok ? 500 : 400).send({
          error: 'not_created',
          ref: body.tasks[result.index]?.ref,
          reason: result.result.ok ? undefined : result.result.error,
        });
      return reply.status(201).send({ created } satisfies RambleCommitResponse);
    },
  );

  /**
   * Live Ramble (W8-live, ADR 0014): a WebSocket relay to OpenAI Realtime / Gemini Live. The
   * access hook has already run (session or `ai:use` token); a browser can't set a CSRF header on
   * a WebSocket, so cookie-authenticated upgrades additionally require a same-origin Origin.
   */
  app.get('/api/v1/ramble/live', { ...aiConfig, websocket: true }, (socket: WebSocket, req) => {
    if (req.session && !originAllowed(req, settings)) {
      socket.close(1008, 'csrf_failed');
      return;
    }
    const user = requireUser(req);
    const cookie = req.session ? readSessionToken(req) : null;
    const sessionId = req.session?.id ?? `token:${req.token?.id ?? ''}`;
    const bearer = req.token ? (req.headers.authorization ?? '').slice('Bearer '.length) : null;
    const stillValid = async () => {
      if (bearer) {
        const t = await tokens.authenticate(bearer, 'api');
        return !!t && t.id === req.token?.id && !t.user.mustChangePassword && !t.user.mustEnrollMfa;
      }
      const still = cookie ? await sessions.lookup(cookie) : null;
      return (
        !!still &&
        still.id === sessionId &&
        !still.user.mustChangePassword &&
        !still.user.mustEnrollMfa
      );
    };
    const active = liveByUser.get(user.id) ?? 0;
    if (active >= MAX_LIVE_SESSIONS) {
      socket.close(1013, 'too_many_requests');
      return;
    }
    liveByUser.set(user.id, active + 1);
    socket.on('close', () => {
      const left = (liveByUser.get(user.id) ?? 1) - 1;
      if (left <= 0) liveByUser.delete(user.id);
      else liveByUser.set(user.id, left);
    });
    void relayLive(
      socket,
      { user: { id: user.id, isAdmin: user.isAdmin }, scope: callerScope(req), stillValid },
      { db, settings, ai, connect },
    ).catch(() => {
      try {
        socket.close(1011, 'internal_error');
      } catch {
        // The client is already gone.
      }
    });
  });
}
