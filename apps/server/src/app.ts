import { type Health, type InstanceStatus } from '@bokydo/shared';
import { STATUS_CODES } from 'node:http';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import type { Database, DbHandle } from './db/client.js';
import { registerSecurityHeaders } from './http/security-headers.js';
import { registerWebApp } from './http/static.js';
import { isSetupComplete } from './setup/instance-settings.js';
import { VERSION } from './version.js';

export interface AppDeps {
  db: Pick<DbHandle, 'sql'> & { db: Pick<Database, 'select'> };
  webRoot: string | null;
  logger?: FastifyServerOptions['logger'];
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: deps.logger ?? false,
    // Reverse-proxy trust is configured in Admin → Settings (F3); never trust X-Forwarded-* by default.
    trustProxy: false,
    bodyLimit: 1024 * 1024,
    requestTimeout: 30_000,
    connectionTimeout: 60_000,
    return503OnClosing: true,
    routerOptions: { maxParamLength: 200 },
  });

  app.setErrorHandler((err: { statusCode?: number; message?: string }, req, reply) => {
    const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    if (statusCode >= 500) {
      req.log.error({ err }, 'request failed');
      return reply.status(statusCode).send({ error: 'internal_error' });
    }
    return reply.status(statusCode).send({ error: errorSlug(statusCode), message: err.message });
  });

  await registerSecurityHeaders(app);

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

  app.get('/api/v1/instance', async (): Promise<InstanceStatus> => ({
    name: 'BokyDo',
    version: VERSION,
    setupComplete: await isSetupComplete(deps.db.db),
  }));

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
