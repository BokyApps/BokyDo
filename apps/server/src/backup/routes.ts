import { localNow } from '@bokydo/nlp';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { z } from 'zod';
import { audit } from '../audit.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { Database } from '../db/client.js';
import { requireRecentAuth, requireSession } from '../http/access.js';
import { parseBody } from '../http/validation.js';
import type { SettingsService } from '../settings/settings-service.js';
import { BackupError, type BackupService } from './backup.js';
import { BackupAuthError, BackupFormatError } from './crypto-stream.js';

export interface BackupRouteDeps {
  db: Database;
  settings: SettingsService;
  backups: BackupService;
  /** After a successful restore: restart the process so every cache and key is reloaded. */
  onRestored: () => void;
}

const nameParams = z.object({ name: z.string().max(80) });
const restoreSchema = z
  .object({ passphrase: z.string().min(1).max(1024), confirm: z.literal('RESTORE') })
  .strict();

/**
 * Admin → Backups. Usable during first-run setup too, so a new server can be restored from a
 * backup before anything else is configured. Downloading, deleting, uploading and restoring need
 * a recent password/passkey check.
 */
export function registerBackupRoutes(app: FastifyInstance, deps: BackupRouteDeps): void {
  const { db, settings, backups } = deps;
  const config = { access: 'admin', setup: 'always' } as const;
  const manual = new RateLimiter({
    windowMs: 3600_000,
    maxPerWindow: 6,
    freeFailures: Number.POSITIVE_INFINITY,
    maxBackoffMs: 0,
  });
  const actor = (req: FastifyRequest) => ({
    actorType: 'user' as const,
    actorUserId: requireSession(req).user.id,
    ip: req.ip,
  });
  const failed = (err: unknown, reply: FastifyReply) => {
    if (err instanceof BackupError) {
      const status = err.code === 'not_found' ? 404 : err.code === 'busy' ? 409 : 400;
      return reply
        .status(status)
        .send({ error: err.code === 'not_found' ? 'not_found' : 'backup_' + err.code });
    }
    if (err instanceof BackupAuthError)
      return reply.status(400).send({ error: 'backup_passphrase_or_damaged' });
    if (err instanceof BackupFormatError)
      return reply.status(400).send({ error: 'backup_invalid' });
    throw err;
  };

  app.get('/api/v1/admin/backups', { config }, async () => ({
    backups: await backups.list(),
    passphraseSet: settings.toPublic()['backups.passphrase'].isSet,
  }));

  app.post('/api/v1/admin/backups', { config }, async (req, reply) => {
    const passphrase = settings.getSecret('backups.passphrase');
    if (!passphrase)
      return reply.status(409).send({ error: 'conflict', message: 'passphrase_not_set' });
    if (!manual.attempt(requireSession(req).user.id).allowed)
      return reply.status(429).send({ error: 'too_many_requests' });
    const info = await backups.create(passphrase);
    await audit(db, {
      ...actor(req),
      action: 'backup.created',
      targetType: 'backup',
      targetId: info.name,
    });
    return reply.status(201).send(info);
  });

  app.get('/api/v1/admin/backups/:name', { config }, async (req, reply) => {
    if (!requireRecentAuth(req, reply)) return;
    const params = nameParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'not_found' });
    try {
      const file = backups.path(params.data.name);
      const stream = createReadStream(file);
      await new Promise<void>((resolve, reject) => {
        stream.once('open', () => resolve());
        stream.once('error', () => reject(new BackupError('not_found')));
      });
      await audit(db, {
        ...actor(req),
        action: 'backup.downloaded',
        targetType: 'backup',
        targetId: params.data.name,
      });
      return reply
        .header('content-type', 'application/octet-stream')
        .header('content-disposition', `attachment; filename="${params.data.name}"`)
        .header('cache-control', 'no-store')
        .send(stream);
    } catch (err) {
      return failed(err, reply);
    }
  });

  app.delete('/api/v1/admin/backups/:name', { config }, async (req, reply) => {
    if (!requireRecentAuth(req, reply)) return;
    const params = nameParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'not_found' });
    try {
      await backups.remove(params.data.name);
    } catch (err) {
      return failed(err, reply);
    }
    await audit(db, {
      ...actor(req),
      action: 'backup.deleted',
      targetType: 'backup',
      targetId: params.data.name,
    });
    return reply.status(204).send();
  });

  void app.register(async (scoped) => {
    scoped.addContentTypeParser('application/octet-stream', (_req, payload, done) =>
      done(null, payload),
    );
    scoped.post(
      '/api/v1/admin/backups/upload',
      { config, bodyLimit: 50 * 1024 * 1024 * 1024 },
      async (req, reply) => {
        if (req.headers['content-type'] !== 'application/octet-stream')
          return reply.status(415).send({ error: 'unsupported_media_type' });
        if (!requireRecentAuth(req, reply)) return;
        try {
          const info = await backups.saveUpload(req.body as Readable);
          await audit(db, {
            ...actor(req),
            action: 'backup.uploaded',
            targetType: 'backup',
            targetId: info.name,
          });
          return reply.status(201).send(info);
        } catch (err) {
          return failed(err, reply);
        }
      },
    );
  });

  /** Replace everything with a backup. Signs everyone out; the server restarts afterwards. */
  app.post('/api/v1/admin/backups/:name/restore', { config }, async (req, reply) => {
    const params = nameParams.safeParse(req.params);
    if (!params.success) return reply.status(404).send({ error: 'not_found' });
    const body = parseBody(restoreSchema, req.body, reply);
    if (!body) return;
    if (!requireRecentAuth(req, reply)) return;
    const who = actor(req);
    let result: { preRestore: string };
    try {
      result = await backups.restore(params.data.name, body.passphrase);
    } catch (err) {
      await audit(db, {
        ...who,
        action: 'backup.restore_failed',
        targetType: 'backup',
        targetId: params.data.name,
      }).catch(() => undefined);
      return failed(err, reply);
    }
    // The audit log was replaced with the backup's: record the restore in the restored one.
    await audit(db, {
      actorType: 'user',
      actorUserId: null,
      ip: who.ip,
      action: 'backup.restored',
      targetType: 'backup',
      targetId: params.data.name,
      meta: { preRestore: result.preRestore, by: who.actorUserId },
    });
    reply.raw.once('finish', deps.onRestored);
    return { restored: true, restarting: true, preRestore: result.preRestore };
  });
}

/** The job runner's backup step: once per day/week after the configured hour, then prune. */
export function scheduledBackups(deps: {
  settings: SettingsService;
  backups: BackupService;
  db: Database;
  log: FastifyBaseLogger;
}): (now: Date) => Promise<void> {
  let running = false;
  let lastCheck = 0;
  return async (now) => {
    const schedule = deps.settings.get('backups.schedule');
    const passphrase = deps.settings.getSecret('backups.passphrase');
    if (schedule === 'off' || !passphrase || running) return;
    if (now.getTime() - lastCheck < 5 * 60_000) return;
    lastCheck = now.getTime();
    const local = localNow(deps.settings.get('instance.defaultTimezone'), now);
    if (Number(local.time.slice(0, 2)) < deps.settings.get('backups.hour')) return;
    const latest = (await deps.backups.list()).find((b) => b.kind === 'backup');
    const age = latest?.createdAt ? now.getTime() - Date.parse(latest.createdAt) : Infinity;
    const interval = (schedule === 'daily' ? 1 : 7) * 86_400_000 - 2 * 3600_000;
    if (age < interval) return;
    // In the background: a big backup must not hold up reminders and email in the same tick.
    running = true;
    void (async () => {
      try {
        const info = await deps.backups.create(passphrase);
        await audit(deps.db, {
          actorType: 'system',
          action: 'backup.created',
          targetType: 'backup',
          targetId: info.name,
        });
        await deps.backups.prune(deps.settings.get('backups.retention'));
      } catch (err) {
        deps.log.error({ err }, 'scheduled backup failed');
      } finally {
        running = false;
      }
    })();
  };
}
