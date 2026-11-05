import { habitCheckInSchema, habitCreateRequestSchema, habitPatchSchema } from '@bokydo/shared';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { requireUser } from '../http/access.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { EventBus } from '../sync/events.js';
import { listHabits, createHabit, updateHabit, deleteHabit, setHabitCheckIn } from './service.js';

const idParams = z.object({ id: z.uuid() }).strict();
const checkInParams = z.object({ id: z.uuid(), date: z.string() }).strict();

export function registerHabitRoutes(
  app: FastifyInstance,
  deps: { db: Database; settings: SettingsService; events?: EventBus },
): void {
  const accountWide = (scope: 'habits:read' | 'habits:write') => ({
    config: { access: 'user' as const, scopes: [scope] },
    preHandler: async (req: FastifyRequest, reply: FastifyReply) => {
      if (req.token?.projectIds) return reply.status(403).send({ error: 'project_limited_token' });
    },
  });
  const publish = (userId: string) =>
    deps.events
      ?.publish({ projectIds: new Set(), userIds: new Set([userId]) })
      .catch((err: unknown) => app.log.warn({ err }, 'habit event publish failed'));
  app.get('/api/v1/habits', accountWide('habits:read'), async (req) =>
    listHabits(deps.db, requireUser(req).id, deps.settings.get('instance.defaultTimezone')),
  );

  app.post('/api/v1/habits', accountWide('habits:write'), async (req, reply) => {
    const parsed = habitCreateRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'validation_failed' });
    const result = await createHabit(
      deps.db,
      requireUser(req).id,
      parsed.data,
      deps.settings.get('instance.defaultTimezone'),
    );
    if (!result.ok)
      return reply.status(result.error === 'id_conflict' ? 409 : 404).send({ error: result.error });
    if (result.value.created) await publish(requireUser(req).id);
    return reply.status(result.value.created ? 201 : 200).send({ habit: result.value.habit });
  });

  app.patch('/api/v1/habits/:id', accountWide('habits:write'), async (req, reply) => {
    const params = idParams.safeParse(req.params);
    const patch = habitPatchSchema.safeParse(req.body);
    if (!params.success || !patch.success)
      return reply.status(400).send({ error: 'validation_failed' });
    const userId = requireUser(req).id;
    const result = await updateHabit(
      deps.db,
      userId,
      params.data.id,
      patch.data,
      deps.settings.get('instance.defaultTimezone'),
    );
    if (!result.ok)
      return reply.status(result.error === 'not_found' ? 404 : 400).send({ error: result.error });
    await publish(userId);
    return { habit: result.value };
  });

  app.delete('/api/v1/habits/:id', accountWide('habits:write'), async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const userId = requireUser(req).id;
    if (!(await deleteHabit(deps.db, userId, params.data.id)))
      return reply.status(404).send({ error: 'not_found' });
    await publish(userId);
    return reply.status(204).send();
  });

  app.put('/api/v1/habits/:id/check-ins/:date', accountWide('habits:write'), async (req, reply) => {
    const params = checkInParams.safeParse(req.params);
    const body = habitCheckInSchema.safeParse(req.body);
    if (!params.success || !body.success)
      return reply.status(400).send({ error: 'validation_failed' });
    const userId = requireUser(req).id;
    const result = await setHabitCheckIn(
      deps.db,
      userId,
      params.data.id,
      params.data.date,
      body.data,
      deps.settings.get('instance.defaultTimezone'),
    );
    if (!result.ok)
      return reply.status(result.error === 'not_found' ? 404 : 400).send({ error: result.error });
    await publish(userId);
    return { habit: result.value };
  });
}
