import path from 'node:path';
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
import { registerAccountDataRoutes } from './account/data-routes.js';
import { BackupService } from './backup/backup.js';
import { registerBackupRoutes, scheduledBackups } from './backup/routes.js';
import { AttachmentStore } from './attachments/store.js';
import { SyncService } from './sync/sync-service.js';
import { JobRunner } from './jobs/runner.js';
import { Delivery } from './delivery/delivery.js';
import { AiCredentialStore } from './ai/credentials.js';
import { registerAiRoutes } from './ai/routes.js';
import { AiService } from './ai/service.js';
import { createOutbound, PUBLIC_ONLY, type OutboundFetch, type Resolver } from './net/outbound.js';
import { registerDeliveryRoutes } from './delivery/routes.js';
import { registerCalendarRoutes } from './calendar/routes.js';
import { VapidKeys } from './delivery/webpush.js';
import { registerProductivityRoutes } from './productivity/routes.js';
import { report } from './assist/report.js';
import { registerAssistRoutes } from './assist/routes.js';
import { registerImportRoutes } from './import/routes.js';
import { TodoistImporter } from './import/todoist-import.js';
import { registerRambleRoutes } from './ramble/routes.js';
import { fireDueReminders } from './reminders/reminders.js';
import { registerWebhookRoutes } from './webhooks/routes.js';
import { Webhooks } from './webhooks/webhooks.js';
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
  /** Where the instance keys live (default: `<dataDir>/secrets`); backups include them. */
  secretsDir?: string;
  /** After a backup restore (default: exit, so the container restarts with the restored keys). */
  onRestored?: () => void;
  /** DNS for the SSRF-safe outbound client; injectable for tests. */
  resolver?: Resolver;
  /** Tests only: the network for users' own AI credentials and subscription sign-in. */
  aiUserFetch?: OutboundFetch;
  /** Tests only: the network the Todoist importer reads through. */
  importFetch?: OutboundFetch;
  /** Tests only: the importer's clock, so completed-task windows are not wall-clock bound. */
  importNow?: () => Date;
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
  backups: BackupService;
  /** Outgoing webhook deliveries (the `webhooks` background job drives enqueue + dispatch). */
  webhooks: Webhooks;
  /** Imports from Todoist (W11a). */
  importer: TodoistImporter;
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
  const backups = new BackupService({
    sql: deps.db.sql,
    dataDir: deps.dataDir,
    secretsDir: deps.secretsDir ?? path.join(deps.dataDir, 'secrets'),
  });
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
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
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
    { name: 'backups', run: scheduledBackups({ settings, backups, db, log: app.log }) },
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
    {
      name: 'webhooks',
      run: async (now) => {
        // Batches of 500 (enqueue) / 100 (dispatch) until caught up, like the delivery job.
        for (let i = 0; i < 50; i++) if ((await webhooks.enqueue(now)) < 500) break;
        for (let i = 0; i < 20; i++) if ((await webhooks.dispatch(now)) < 100) break;
      },
    },
  );
  const aiCredentials = new AiCredentialStore(db, deps.secrets.masterKey);
  const ai = new AiService({
    db,
    settings,
    credentials: aiCredentials,
    ...(deps.resolver ? { resolver: deps.resolver } : {}),
    ...(deps.aiUserFetch ? { userFetch: deps.aiUserFetch } : {}),
  });
  let lastSignInKeepAlive = 0;
  jobs.add({
    name: 'ai-sign-in-keepalive',
    run: async (now) => {
      // Hourly: renew subscription sign-ins idle for 3 days, so their refresh tokens stay alive.
      if (now.getTime() - lastSignInKeepAlive < 3600_000) return;
      lastSignInKeepAlive = now.getTime();
      await ai.renewIdleSignIns(now, 3 * 86_400_000);
    },
  });
  // AI report emails (W9): written at send time, from what each user can see then.
  jobs.add({
    name: 'ai-reports',
    run: (now) =>
      delivery.reports(now, (user, kind, at) =>
        report(
          db,
          ai,
          user,
          kind,
          undefined,
          null,
          settings.get('instance.defaultTimezone'),
          undefined,
          at,
        ),
      ),
  });
  // User-configured endpoints are public-internet only, whatever the admin allow-list says.
  const webhooks = new Webhooks({
    db,
    settings,
    masterKey: deps.secrets.masterKey,
    fetch: createOutbound(PUBLIC_ONLY, deps.resolver),
  });
  // Todoist is on the public internet; the token goes nowhere else.
  const importer = new TodoistImporter({
    db,
    sync,
    fetch: deps.importFetch ?? createOutbound(PUBLIC_ONLY, deps.resolver),
    defaultTimeZone: () => settings.get('instance.defaultTimezone'),
    log: app.log,
    ...(deps.importNow ? { now: deps.importNow } : {}),
  });
  await importer.recover();
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
    backups,
    webhooks,
    importer,
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
  registerRestRoutes(app, db, sync, () => settings.get('instance.publicUrl') ?? null);
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
  registerRambleRoutes(app, { db, settings, sync, ai });
  registerAssistRoutes(app, { db, settings, ai, sync });
  registerWebhookRoutes(app, { db, settings, webhooks });
  registerCalendarRoutes(app, { db, settings, sessionKey: deps.secrets.sessionKey });
  registerProductivityRoutes(app, { db, settings });
  registerImportRoutes(app, importer);
  const attachmentStore = new AttachmentStore(deps.dataDir);
  services.purgeAttachments = await registerAttachmentRoutes(app, {
    db,
    settings,
    store: attachmentStore,
  });
  registerBackupRoutes(app, {
    db,
    settings,
    backups,
    onRestored: deps.onRestored ?? (() => setTimeout(() => process.exit(0), 200)),
  });
  registerAccountDataRoutes(app, {
    db,
    sync,
    events,
    settings,
    mailer,
    store: attachmentStore,
    tokens: apiTokens,
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
