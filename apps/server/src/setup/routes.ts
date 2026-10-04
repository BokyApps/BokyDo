import { setPublicUrlRequestSchema, type SetupStatus } from '@bokydo/shared';
import type { FastifyInstance } from 'fastify';
import { insecurePublicUrl, requireSession } from '../http/access.js';
import { parseBody } from '../http/validation.js';
import type { SettingsService } from '../settings/settings-service.js';

/** First-run wizard. All routes are admin-only and disappear (404) once setup is complete. */
export function registerSetupRoutes(app: FastifyInstance, settings: SettingsService): void {
  const config = { access: 'admin', setup: 'before' } as const;

  const status = (): SetupStatus => {
    const publicUrl = settings.get('instance.publicUrl');
    return {
      // Reaching an `admin` route means the password has already been changed.
      passwordChanged: true,
      publicUrl,
      publicUrlWarning: insecurePublicUrl(publicUrl) ? 'insecure_http' : null,
      canComplete: publicUrl !== null,
    };
  };

  app.get('/api/v1/setup', { config }, async () => status());

  app.put('/api/v1/setup/public-url', { config }, async (req, reply) => {
    const body = parseBody(setPublicUrlRequestSchema, req.body, reply);
    if (!body) return;
    await settings.update(
      { 'instance.publicUrl': body.publicUrl },
      { userId: requireSession(req).user.id, ip: req.ip },
    );
    return status();
  });

  app.post('/api/v1/setup/complete', { config }, async (req, reply) => {
    if (!status().canComplete)
      return reply.status(409).send({ error: 'conflict', message: 'public_url_required' });
    await settings.markSetupComplete({ userId: requireSession(req).user.id, ip: req.ip });
    return reply.status(204).send();
  });
}
