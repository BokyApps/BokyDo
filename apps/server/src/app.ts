import cookie from '@fastify/cookie';
import { type Health, type InstanceStatus } from '@bokydo/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { STATUS_CODES } from 'node:http';
import { registerAdminSettingsRoutes } from './admin/settings-routes.js';
import { registerAuthRoutes } from './auth/routes.js';
import { SessionStore } from './auth/sessions.js';
import type { DbHandle } from './db/client.js';
import { Mailer } from './email/mailer.js';
import { registerAccessControl } from './http/access.js';
import { registerSecurityHeaders } from './http/security-headers.js';
import { registerWebApp } from './http/static.js';
import type { AppSecrets } from './security/app-secrets.js';
import { SettingsService } from './settings/settings-service.js';
import { registerSetupRoutes } from './setup/routes.js';
import { VERSION } from './version.js';

export interface AppDeps {
  db: DbHandle;
  secrets: AppSecrets;
  webRoot: string | null;
  logger?: FastifyServerOptions['logger'];
}

export interface AppServices {
  settings: SettingsService;
  sessions: SessionStore;
  mailer: Mailer;
}

declare module 'fastify' {
  interface FastifyInstance {
    services: AppServices;
  }
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { db } = deps.db;
  const settings = await SettingsService.load(db, deps.secrets.masterKey);
  const sessions = new SessionStore(db, deps.secrets.sessionKey, settings);
  const mailer = new Mailer(settings);

  const app = Fastify({
    logger: deps.logger ?? false,
    // Hop count comes from Admin → Settings; 0 (default) ignores X-Forwarded-* entirely.
    trustProxy: (_address: string, hop: number) => hop < settings.get('instance.trustedProxyHops'),
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 60_000,
    return503OnClosing: true,
    routerOptions: { maxParamLength: 200 },
  });
  const services: AppServices = { settings, sessions, mailer };
  app.decorate('services', services);

  app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
    const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (statusCode >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.status(statusCode).send({ error: 'internal_error' });
    }
    return reply.status(statusCode).send({ error: errorSlug(statusCode), message: err.message });
  });

  await app.register(cookie);
  await registerSecurityHeaders(app, settings);
  registerAccessControl(app, { settings, sessions });

  // Liveness: process is up. Readiness: database reachable.
  app.get('/healthz', async (): Promise<Health> => ({ status: 'ok' }));
  app.get('/readyz', async (_req, reply): Promise<Health> => {
    try {
      await deps.db.sql`select 1`;
      return { status: 'ok' };
    } catch {
      reply.status(503);
      return { status: 'unavailable' };
    }
  });

  app.get(
    '/api/v1/instance',
    { config: { access: 'public', setup: 'always' } },
    async (): Promise<InstanceStatus> => ({
      name: 'BokyDo',
      version: VERSION,
      setupComplete: settings.isSetupComplete(),
      passwordMinLength: settings.get('security.passwordMinLength'),
    }),
  );

  await registerAuthRoutes(app, { db, settings, sessions });
  registerSetupRoutes(app, settings);
  registerAdminSettingsRoutes(app, { db, settings, mailer });

  const servesWebApp = await registerWebApp(app, deps.webRoot);
  app.setNotFoundHandler((req, reply) => {
    const isPageNavigation =
      req.method === 'GET' &&
      !req.url.startsWith('/api/') &&
      req.headers.accept?.includes('text/html') === true;
    if (servesWebApp && isPageNavigation) {
      // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile -- constant path
      return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
    }
    return reply.status(404).send({ error: 'not_found' });
  });
  return app;
}

/** 413 → "payload_too_large", etc. */
function errorSlug(statusCode: number): string {
  return (STATUS_CODES[statusCode] ?? 'bad_request').toLowerCase().replace(/[^a-z]+/g, '_');
}
