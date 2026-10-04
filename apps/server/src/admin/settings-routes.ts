import { settingsPatchSchema, testEmailRequestSchema } from '@bokydo/shared';
import type { FastifyInstance } from 'fastify';
import { audit } from '../audit.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import type { Database } from '../db/client.js';
import { EmailNotConfiguredError, type Mailer } from '../email/mailer.js';
import { requireSession } from '../http/access.js';
import { parseBody } from '../http/validation.js';
import type { SettingsService } from '../settings/settings-service.js';

/** Admin → Settings. Usable during setup too, so SMTP can be configured in the wizard. */
export function registerAdminSettingsRoutes(
  app: FastifyInstance,
  deps: { db: Database; settings: SettingsService; mailer: Mailer },
): void {
  const { db, settings, mailer } = deps;
  const config = { access: 'admin', setup: 'always' } as const;
  const testMailLimiter = new RateLimiter({
    windowMs: 60_000,
    maxPerWindow: 5,
    freeFailures: Number.POSITIVE_INFINITY,
    maxBackoffMs: 0,
  });

  app.get('/api/v1/admin/settings', { config }, async () => settings.toPublic());

  app.patch('/api/v1/admin/settings', { config }, async (req, reply) => {
    const patch = parseBody(settingsPatchSchema, req.body, reply);
    if (!patch) return;
    const changed = await settings.update(patch, {
      userId: requireSession(req).user.id,
      ip: req.ip,
    });
    return { changed, settings: settings.toPublic() };
  });

  app.post('/api/v1/admin/email/test', { config }, async (req, reply) => {
    const body = parseBody(testEmailRequestSchema, req.body, reply);
    if (!body) return;
    if (!testMailLimiter.attempt(requireSession(req).user.id).allowed) {
      return reply.status(429).send({ error: 'too_many_requests' });
    }
    try {
      await mailer.send({
        to: body.to,
        subject: `${settings.get('instance.name')}: test email`,
        text: 'Email delivery from your BokyDo instance is working.\n',
      });
    } catch (err) {
      if (err instanceof EmailNotConfiguredError) {
        return reply.status(409).send({ error: 'conflict', message: 'smtp_not_configured' });
      }
      // Admin-only diagnostics: SMTP error code and server response, never credentials.
      const e = err as { code?: string; responseCode?: number; message?: string };
      req.log.warn({ code: e.code, responseCode: e.responseCode }, 'test email failed');
      return reply.status(502).send({
        error: 'smtp_failed',
        message: [e.code, e.responseCode].filter(Boolean).join(' ') || 'delivery failed',
      });
    }
    await audit(db, {
      action: 'email.test_sent',
      actorType: 'user',
      actorUserId: requireSession(req).user.id,
      ip: req.ip,
    });
    return { sent: true };
  });
}
