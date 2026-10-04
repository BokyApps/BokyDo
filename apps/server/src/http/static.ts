import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';

/** Serve the built web app, with SPA fallback for client-side routes. */
export async function registerWebApp(
  app: FastifyInstance,
  webRoot: string | null,
): Promise<boolean> {
  if (!webRoot || !existsSync(path.join(webRoot, 'index.html'))) {
    app.log.warn({ webRoot }, 'web app build not found; serving API only');
    return false;
  }
  await app.register(fastifyStatic, {
    root: webRoot,
    wildcard: false,
    dotfiles: 'deny',
    index: false,
    setHeaders(reply, filePath) {
      // Vite emits content-hashed files under /assets; everything else must revalidate.
      const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
      reply.header('Cache-Control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  // nosemgrep: javascript.express.security.audit.express-res-sendfile.express-res-sendfile -- constant path
  app.get('/', (_req, reply) => reply.header('Cache-Control', 'no-cache').sendFile('index.html'));
  return true;
}
