import type { FastifyReply } from 'fastify';
import type { z } from 'zod';

/** Parse a request body with zod; on failure sends 400 and returns undefined. */
export function parseBody<S extends z.ZodType>(
  schema: S,
  body: unknown,
  reply: FastifyReply,
): z.output<S> | undefined {
  const result = schema.safeParse(body);
  if (result.success) return result.data;
  void reply.status(400).send({
    error: 'validation_failed',
    issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  });
  return undefined;
}

export function clientMeta(req: { ip: string; headers: Record<string, unknown> }) {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua : null };
}
