import type { FastifyRequest } from 'fastify';

/**
 * Request paths that carry a secret (the calendar feed link is the credential) are logged with
 * the secret removed, so access logs and log shippers never hold a usable link.
 */
const SECRET_PATHS: [RegExp, string][] = [[/^(\/api\/v1\/calendar\/)[^/?#]*/, '$1[redacted]']];

export function redactUrl(url: string): string {
  for (const [pattern, replacement] of SECRET_PATHS) {
    if (pattern.test(url)) return url.replace(pattern, replacement);
  }
  return url;
}

/** Fastify's default request log fields, with the URL redacted. */
function serializeRequest(req: FastifyRequest) {
  return {
    method: req.method,
    url: redactUrl(req.url),
    host: req.host,
    remoteAddress: req.ip,
    remotePort: req.socket?.remotePort ?? 0,
  };
}

/** What the server logs about requests: no credentials in headers, no secrets in URLs. */
export const REQUEST_LOG_OPTIONS = {
  redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
  serializers: { req: serializeRequest },
};
