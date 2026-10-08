import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';
import type { SettingsService } from '../settings/settings-service.js';

/**
 * Strict defaults. The web app is built with no inline scripts or styles, so CSP needs no
 * 'unsafe-inline'. HSTS is sent only once the admin confirms an HTTPS public URL: many
 * self-hosters start on plain HTTP on a LAN, where HSTS would break the instance.
 */
export async function registerSecurityHeaders(
  app: FastifyInstance,
  settings: SettingsService,
): Promise<void> {
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    frameguard: { action: 'deny' },
    strictTransportSecurity: false,
    // Cross-origin isolation (F-008). Free here: the CSP below pins every subresource to
    // 'self'/data:, and helmet's default Cross-Origin-Resource-Policy: same-origin keeps
    // same-origin loads working, so no legitimate embed regresses.
    crossOriginEmbedderPolicy: { policy: 'require-corp' },
    referrerPolicy: { policy: 'no-referrer' },
  });
  app.addHook('onSend', async (req, reply) => {
    // The microphone is for Ramble (voice to tasks). It is a dialog in the single-page app, so a
    // per-route policy can't work (the document's policy covers every route): this origin may
    // ask (the browser still prompts), frames and other origins never.
    reply.header(
      'Permissions-Policy',
      'camera=(), geolocation=(), microphone=(self), payment=(), usb=()',
    );
    // API responses carry user data: never let browsers or proxies store them.
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
    // HSTS only once the admin has confirmed an HTTPS public URL. No includeSubDomains: the
    // instance may share a parent domain with sites we know nothing about.
    if (settings.get('instance.publicUrl')?.startsWith('https:')) {
      reply.header('Strict-Transport-Security', 'max-age=31536000');
    }
  });
}
