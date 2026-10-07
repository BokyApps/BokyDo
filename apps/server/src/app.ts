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
import { registerOAuthRoutes } from './oauth/routes.js';
import { purgeOAuth, registerOAuthServer } from './oauth/server.js';
import { ApiTokenStore } from './oauth/token-store.js';
import { registerMcpServer } from './mcp/server.js';
import { ensureFirstPartyClients, registerAndroidRoutes } from './android/routes.js';
import { registerRestRoutes } from './rest/routes.js';
import { registerTaskRoutes } from './tasks/routes.js';
import { registerInviteRoutes } from './projects/invite-routes.js';
import { registerActivityRoutes } from './activity/routes.js';
import { registerAttachmentRoutes } from './attachments/routes.js';
import { AttachmentStore } from './attachments/store.js';
import { SyncService } from './sync/sync-service.js';
import { JobRunner } from './jobs/runner.js';
import { Delivery } from './delivery/delivery.js';
import { AiCredentialStore } from './ai/credentials.js';
import { registerAiRoutes } from './ai/routes.js';
import { AiService } from './ai/service.js';
import type { Resolver } from './net/outbound.js';
import { registerDeliveryRoutes } from './delivery/routes.js';
import { registerCalendarRoutes } from './calendar/routes.js';
import { VapidKeys } from './delivery/webpush.js';
import { fireDueReminders } from './reminders/reminders.js';
import { VERSION } from './version.js';

export interface AppDeps {
  db: DbHandle;
  secrets: AppSecrets;
  webRoot: string | null;
  /** The data volume (attachments live under it). */
  dataDir: string;
  logger?: FastifyServerOptions['logger'];
  /** Outbound fetch (breached-password check); injectable for tests. */
  fetchImpl?: typeof fetch;
  /** DNS for the SSRF-safe outbound client; injectable for tests. */
  resolver?: Resolver;
}

export interface AppServices {
  settings: SettingsService;
  sessions: SessionStore;
  mailer: Mailer;
  sync: SyncService;
  events: EventBus;
  flows: FlowStore;
  tokens: UserTokenStore;
  /** Reminders, notification delivery and digests (started by main; tests call `tick`). */
  jobs: JobRunner;
  delivery: Delivery;
  ai: AiService;
  apiTokens: ApiTokenStore;
  /** Remove unused or orphaned attachment files (runs hourly; callable from tests). */
  purgeAttachments?: () => Promise<void>;
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
  const apiTokens = new ApiTokenStore(db, deps.secrets.sessionKey, settings);
  sessions.onRevokeAll = (userId) => apiTokens.revokeAllForUser(userId);
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
  const jobs = new JobRunner(app.log);
  let lastOAuthPurge = 0;
  const sync = new SyncService(
    db,
    (affected) => {
      events
        .publish(affected)
        .catch((err: unknown) => app.log.warn({ err }, 'event publish failed'));
      // New notifications may be waiting for email/push delivery.
      jobs.poke();
    },
    () => settings.get('instance.defaultTimezone'),
  );
  const flows = new FlowStore(db, deps.secrets.sessionKey);
  const tokens = new UserTokenStore(db, deps.secrets.sessionKey);
  const notifier = new Notifier(db, settings, mailer, app.log);
  notifier.onAlert = (userId) => {
    events
      .publish({ projectIds: new Set(), userIds: new Set([userId]) })
      .catch((err: unknown) => app.log.warn({ err }, 'event publish failed'));
    jobs.poke();
  };
  const vapid = new VapidKeys(deps.secrets.vapidKey);
  const delivery = new Delivery({
    db,
    settings,
    mailer,
    vapid,
    sessionKey: deps.secrets.sessionKey,
    log: app.log,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });
  jobs.add(
    {
      name: 'reminders',
      run: async (now) => {
        // Batches of 200 until caught up (after downtime there may be many).
        for (let i = 0; i < 50; i++) {
          const handled = await sync.write((tx, changes) => fireDueReminders(tx, changes, now));
          if (handled < 200) break;
        }
      },
    },
    {
      name: 'delivery',
      run: async (now) => {
        for (let i = 0; i < 20; i++) if ((await delivery.dispatch(now)) < 100) break;
      },
    },
    { name: 'digests', run: (now) => delivery.digests(now) },
    {
      name: 'oauth-housekeeping',
      run: async (now) => {
        // Hourly is plenty: expired rows are already unusable.
        if (now.getTime() - lastOAuthPurge < 3600_000) return;
        lastOAuthPurge = now.getTime();
        await purgeOAuth(db, now);
        await apiTokens.purge(now);
      },
    },
  );
  const aiCredentials = new AiCredentialStore(db, deps.secrets.masterKey);
  const ai = new AiService({
    db,
    settings,
    credentials: aiCredentials,
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
  });
  const services: AppServices = {
    settings,
    sessions,
    mailer,
    sync,
    events,
    flows,
    tokens,
    jobs,
    delivery,
    ai,
    apiTokens,
  };
  app.decorate('services', services);
  app.addHook('onClose', async () => {
    await jobs.stop();
    events.closeAll();
  });

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
  registerAccessControl(app, { settings, sessions, tokens: apiTokens });

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
      attachmentMaxMb: settings.get('attachments.maxSizeMb'),
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
  registerSyncRoutes(app, { sync, events, sessions, tokens: apiTokens });
  registerOAuthServer(app, { db, settings, tokens: apiTokens, key: deps.secrets.sessionKey });
  registerOAuthRoutes(app, {
    db,
    settings,
    tokens: apiTokens,
    notifier,
    key: deps.secrets.sessionKey,
  });
  registerTaskRoutes(app, db, () => settings.get('instance.defaultTimezone'));
  registerRestRoutes(app, db, () => settings.get('instance.publicUrl') ?? null);
  registerMcpServer(app, { db, sync, settings, tokens: apiTokens });
  await ensureFirstPartyClients(db);
  registerAndroidRoutes(app, { settings });
  registerInviteRoutes(app, { db, sync, sessionKey: deps.secrets.sessionKey });
  registerActivityRoutes(app, db);
  registerDeliveryRoutes(app, {
    db,
    sync,
    delivery,
    vapid,
    sessionKey: deps.secrets.sessionKey,
  });
  registerAiRoutes(app, { db, settings, credentials: aiCredentials, ai });
  registerCalendarRoutes(app, { db, settings, sessionKey: deps.secrets.sessionKey });
  const attachmentStore = new AttachmentStore(deps.dataDir);
  services.purgeAttachments = await registerAttachmentRoutes(app, {
    db,
    settings,
    store: attachmentStore,
  });

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
