import websocket from '@fastify/websocket';
import { RAMBLE_LIVE } from '@bokydo/shared';
import type { FastifyInstance } from 'fastify';
import { registerAiRoutes } from '../ai/routes.js';
import { AiCredentialStore } from '../ai/credentials.js';
import { AiService } from '../ai/service.js';
import { report } from '../assist/report.js';
import { registerAssistRoutes } from '../assist/routes.js';
import type { AppServices } from '../app.js';
import type { OutboundFetch } from '../net/outbound.js';
import { createLiveConnector, type LiveConnector } from '../net/outbound-ws.js';
import { registerRambleRoutes } from '../ramble/routes.js';
import { testApp as coreTestApp, type TestApp as CoreTestApp } from './app.js';

type LegacyAiApp = FastifyInstance & { services: AppServices & { ai: AiService } };
export type TestApp = Omit<CoreTestApp, 'app'> & { app: LegacyAiApp };

type Options = Parameters<typeof coreTestApp>[0] & {
  aiUserFetch?: OutboundFetch;
  liveConnect?: LiveConnector;
};

/** Explicit legacy fixture for tests of dormant built-in AI code. Production uses coreTestApp. */
export async function testApp(opts: Options = {}): Promise<TestApp> {
  const { aiUserFetch, liveConnect, ...coreOpts } = opts;
  const t = await coreTestApp({
    ...coreOpts,
    configurePluginsForTest: async (app) => {
      await app.register(websocket, { options: { maxPayload: RAMBLE_LIVE.maxMessageChars } });
    },
    configureForTest: async (app, deps) => {
      const db = deps.db.db;
      const settings = app.services.settings;
      const credentials = new AiCredentialStore(db, deps.secrets.masterKey);
      const ai = new AiService({
        db,
        settings,
        credentials,
        ...(deps.resolver ? { resolver: deps.resolver } : {}),
        ...(aiUserFetch ? { userFetch: aiUserFetch } : {}),
      });
      Object.assign(app.services, { ai });

      registerAiRoutes(app, { db, settings, credentials, ai });
      registerRambleRoutes(app, {
        db,
        settings,
        sync: app.services.sync,
        ai,
        sessions: app.services.sessions,
        tokens: app.services.apiTokens,
        connect: liveConnect ?? createLiveConnector(deps.resolver),
      });
      registerAssistRoutes(app, { db, settings, ai, sync: app.services.sync });

      let lastSignInKeepAlive = 0;
      app.services.jobs.add({
        name: 'test-ai-sign-in-keepalive',
        run: async (now) => {
          if (now.getTime() - lastSignInKeepAlive < 3_600_000) return;
          lastSignInKeepAlive = now.getTime();
          await ai.renewIdleSignIns(now, 3 * 86_400_000);
        },
      });
      app.services.jobs.add({
        name: 'test-ai-reports',
        run: (now) =>
          app.services.delivery.reports(now, (user, kind, at) =>
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
    },
  });
  return { ...t, app: t.app as LegacyAiApp };
}

export { testApp as testAiApp };
export * from './app.js';
