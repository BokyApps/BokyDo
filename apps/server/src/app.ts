import cookie from '@fastify/cookie';
import { type Health, type InstanceStatus } from '@bokydo/shared';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { STATUS_CODES } from 'node:http';
import { registerAdminSettingsRoutes } from './admin/settings-routes.js';
import { registerAccountRoutes } from './account/routes.js';
import { registerAdminUserRoutes } from './admin/users-routes.js';
import type { AuthDeps } from './auth/deps.js';
import { FlowStore } from './auth/flows.js';
import { registerPublicAuthRoutes } from './auth/public-routes.js';
import { registerAuthRoutes } from './auth/routes.js';
import { UserTokenStore } from './auth/user-tokens.js';
import { relyingParty } from './auth/webauthn.js';
import { Notifier } from './email/notifier.js';
import { SessionStore } from './auth/sessions.js';
import type { DbHandle } from './db/client.js';
import { Mailer } from './email/mailer.js';
import { registerAccessControl } from './http/access.js';
import { registerSecurityHeaders } from './http/security-headers.js';
import { registerWebApp } from './http/static.js';
import type { AppSecrets } from './security/app-secrets.js';
import { SettingsService } from './settings/settings-service.js';
import { registerSetupRoutes } from './setup/routes.js';
import { EventBus } from './sync/events.js';
import { registerSyncRoutes } from './sync/routes.js';
import { SyncService } from './sync/sync-service.js';
import { VERSION } from './version.js';

export interface AppDeps {
  db: DbHandle;
  secrets: AppSecrets;
  webRoot: string | null;
  logger?: FastifyServerOptions['logger'];
  /** Outbound fetch (breached-password check); injectable for tests. */
  fetchImpl?: typeof fetch;
}

export interface AppServices {
  settings: SettingsService;
  sessions: SessionStore;
  mailer: Mailer;
  sync: SyncService;
  events: EventBus;
  flows: FlowStore;
  tokens: UserTokenStore;
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
  const events = new EventBus(db);

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
  const sync = new SyncService(db, (affected) => {
    events.publish(affected).catch((err: unknown) => app.log.warn({ err }, 'event publish failed'));
  });
  const flows = new FlowStore(db, deps.secrets.sessionKey);
  const tokens = new UserTokenStore(db, deps.secrets.sessionKey);
  const notifier = new Notifier(db, settings, mailer, app.log);
  const services: AppServices = { settings, sessions, mailer, sync, events, flows, tokens };
  app.decorate('services', services);
  app.addHook('onClose', async () => events.closeAll());

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
      registrationOpen: settings.get('access.registrationMode') === 'open',
      emailEnabled: notifier.canEmail,
      passkeysAvailable: relyingParty(settings) !== null,
    }),
  );

  const authDeps: AuthDeps = {
    db,
    settings,
    sessions,
    events,
    flows,
    tokens,
    notifier,
    secrets: deps.secrets,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  };
  await registerAuthRoutes(app, authDeps);
  registerPublicAuthRoutes(app, authDeps);
  registerAccountRoutes(app, authDeps);
  registerAdminUserRoutes(app, authDeps);
  registerSetupRoutes(app, settings);
  registerAdminSettingsRoutes(app, { db, settings, mailer });
  registerSyncRoutes(app, { sync, events, sessions });

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
