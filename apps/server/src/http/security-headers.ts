import helmet from '@fastify/helmet';
import type { FastifyInstance } from 'fastify';

/**
 * Strict defaults. The web app is built with no inline scripts or styles, so CSP needs no
 * 'unsafe-inline'. HSTS and upgrade-insecure-requests stay off until the admin confirms an HTTPS
 * public URL (F3): many self-hosters start on plain HTTP on a LAN, and sending them would break
 * the instance or pin HSTS onto unrelated subdomains.
 */
export async function registerSecurityHeaders(app: FastifyInstance): Promise<void> {
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
    crossOriginEmbedderPolicy: false,
    referrerPolicy: { policy: 'no-referrer' },
  });
  app.addHook('onSend', async (req, reply) => {
    reply.header(
      'Permissions-Policy',
      'camera=(), geolocation=(), microphone=(), payment=(), usb=()',
    );
    // API responses carry user data: never let browsers or proxies store them.
    if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
}
