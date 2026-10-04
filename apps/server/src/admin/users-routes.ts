import {
  adminCreateInviteSchema,
  adminCreateUserSchema,
  adminUpdateUserSchema,
  type AdminInvite,
  type AdminUser,
} from '@bokydo/shared';
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { audit } from '../audit.js';
import type { AuthDeps } from '../auth/deps.js';
import { newId } from '../db/ids.js';
import { recoveryCodes, users, webauthnCredentials } from '../db/schema.js';
import { requireRecentAuth, requireSession } from '../http/access.js';
import { clientMeta, parseBody } from '../http/validation.js';
import { generatePassphrase } from '../security/passphrase.js';
import { hashPassword } from '../security/password.js';
import { pgCode } from '../sync/handlers/common.js';

const DAY_MS = 86_400_000;
const idParam = z.object({ id: z.uuid() });

/** Admin → Users and invitations. */
export function registerAdminUserRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db, sessions, events, tokens, notifier } = deps;
  const admin = { config: { access: 'admin' } } as const;

  const userId = (req: FastifyRequest, reply: FastifyReply) => {
    const parsed = idParam.safeParse(req.params);
    if (!parsed.success) void reply.status(404).send({ error: 'not_found' });
    return parsed.success ? parsed.data.id : undefined;
  };
  const actor = (req: FastifyRequest) => ({
    actorType: 'user' as const,
    actorUserId: requireSession(req).user.id,
    ip: req.ip,
  });

  app.get('/api/v1/admin/users', admin, async (): Promise<AdminUser[]> => {
    const rows = await db
      .select({
        user: users,
        // Fully qualified on purpose: drizzle may render unqualified column names inside sql``.
        passkeys: sql<number>`(select count(*)::int from webauthn_credentials wc where wc.user_id = "users"."id")`,
      })
      .from(users)
      .orderBy(users.username);
    return rows.map(({ user: u, passkeys }) => ({
      id: u.id,
      username: u.username,
      email: u.email,
      emailVerified: Boolean(u.emailVerifiedAt),
      isAdmin: u.isAdmin,
      disabled: Boolean(u.disabledAt),
      totpEnabled: Boolean(u.totpEnabledAt),
      passkeys,
      createdAt: u.createdAt.toISOString(),
    }));
  });

  /** Create an account with a one-time passphrase the admin hands over (shown once). */
  app.post('/api/v1/admin/users', admin, async (req, reply) => {
    const body = parseBody(adminCreateUserSchema, req.body, reply);
    if (!body) return;
    if (body.isAdmin && !requireRecentAuth(req, reply)) return;
    const passphrase = generatePassphrase();
    const id = newId();
    try {
      await db.insert(users).values({
        id,
        username: body.username,
        email: body.email ?? null,
        passwordHash: await hashPassword(passphrase),
        isAdmin: body.isAdmin ?? false,
        mustChangePassword: true,
      });
    } catch (err) {
      if (pgCode(err) === '23505')
        return reply.status(409).send({ error: 'conflict', message: 'username_or_email_taken' });
      throw err;
    }
    await audit(db, {
      ...actor(req),
      action: 'admin.user_created',
      targetType: 'user',
      targetId: id,
      meta: { isAdmin: body.isAdmin ?? false },
    });
    return { id, passphrase };
  });

  app.patch('/api/v1/admin/users/:id', admin, async (req, reply) => {
    const id = userId(req, reply);
    const body = parseBody(adminUpdateUserSchema, req.body, reply);
    if (!id || !body) return;
    const me = requireSession(req).user.id;
    if (id === me)
      return reply.status(409).send({ error: 'conflict', message: 'cannot_change_self' });
    if (body.isAdmin !== undefined && !requireRecentAuth(req, reply)) return;
    const [target] = await db.select().from(users).where(eq(users.id, id));
    if (!target) return reply.status(404).send({ error: 'not_found' });

    const result = await db.transaction(async (tx) => {
      // Serialise admin changes so two admins can't demote each other into zero admins.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bokydo:admins'))`);
      const removesAdmin = target.isAdmin && (body.isAdmin === false || body.disabled === true);
      if (removesAdmin) {
        const [others] = await tx
          .select({ n: count() })
          .from(users)
          .where(and(eq(users.isAdmin, true), isNull(users.disabledAt), ne(users.id, id)));
        if ((others?.n ?? 0) === 0) return 'last_admin' as const;
      }
      await tx
        .update(users)
        .set({
          ...(body.isAdmin !== undefined ? { isAdmin: body.isAdmin } : {}),
          ...(body.disabled !== undefined ? { disabledAt: body.disabled ? new Date() : null } : {}),
          updatedAt: new Date(),
        })
        .where(eq(users.id, id));
      await audit(tx, {
        ...actor(req),
        action: 'admin.user_updated',
        targetType: 'user',
        targetId: id,
        meta: body,
      });
      return 'ok' as const;
    });
    if (result === 'last_admin')
      return reply.status(409).send({ error: 'conflict', message: 'last_admin' });
    if (body.disabled || body.isAdmin === false) {
      await sessions.revokeAllForUser(id);
      events.closeUser(id);
    }
    return reply.status(204).send();
  });

  /** For a user who lost every second factor. They must enrol again if policy requires. */
  app.post('/api/v1/admin/users/:id/reset-mfa', admin, async (req, reply) => {
    const id = userId(req, reply);
    if (!id || !requireRecentAuth(req, reply)) return;
    const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
    if (!target) return reply.status(404).send({ error: 'not_found' });
    await db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, updatedAt: new Date() })
        .where(eq(users.id, id));
      await tx.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, id));
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, id));
      await audit(tx, {
        ...actor(req),
        action: 'admin.mfa_reset',
        targetType: 'user',
        targetId: id,
      });
    });
    await sessions.revokeAllForUser(id);
    events.closeUser(id);
    notifier.security(id, 'mfa_reset_by_admin', clientMeta(req));
    return reply.status(204).send();
  });

  /** A password reset link the admin can pass on (works without SMTP). */
  app.post('/api/v1/admin/users/:id/password-reset-link', admin, async (req, reply) => {
    const id = userId(req, reply);
    if (!id || !requireRecentAuth(req, reply)) return;
    const [target] = await db.select({ id: users.id }).from(users).where(eq(users.id, id));
    if (!target) return reply.status(404).send({ error: 'not_found' });
    const { token } = await tokens.create({
      kind: 'password_reset',
      userId: id,
      createdById: requireSession(req).user.id,
      ttlMs: DAY_MS,
    });
    await audit(db, {
      ...actor(req),
      action: 'admin.password_reset_link',
      targetType: 'user',
      targetId: id,
    });
    return { url: notifier.link('/reset-password', token), expiresInHours: 24 };
  });

  // ---- Invitations ---------------------------------------------------------------------------

  app.get('/api/v1/admin/invites', admin, async (): Promise<AdminInvite[]> =>
    (await tokens.listInvites()).map((t) => ({
      id: t.ref,
      email: t.email,
      isAdmin: Boolean((t.data as { isAdmin?: boolean }).isAdmin),
      createdAt: t.createdAt.toISOString(),
      expiresAt: t.expiresAt.toISOString(),
    })),
  );

  app.post('/api/v1/admin/invites', admin, async (req, reply) => {
    const body = parseBody(adminCreateInviteSchema, req.body, reply);
    if (!body) return;
    if (body.isAdmin && !requireRecentAuth(req, reply)) return;
    const emailed = Boolean(body.email && notifier.canEmail);
    const { token, ref } = await tokens.create({
      kind: 'invite',
      email: body.email ?? null,
      data: { isAdmin: body.isAdmin ?? false, emailed },
      createdById: requireSession(req).user.id,
      ttlMs: (body.expiresInDays ?? 7) * DAY_MS,
    });
    const url = notifier.link('/invite', token);
    if (emailed && body.email) {
      void notifier
        .sendLink(body.email, 'invite', url, requireSession(req).user.username)
        .catch((err: unknown) => req.log.warn({ err }, 'invite email failed'));
    }
    await audit(db, {
      ...actor(req),
      action: 'admin.invite_created',
      targetType: 'invite',
      targetId: ref,
      meta: { isAdmin: body.isAdmin ?? false, emailed },
    });
    return { id: ref, url, emailed };
  });

  app.delete('/api/v1/admin/invites/:id', admin, async (req, reply) => {
    const id = userId(req, reply);
    if (!id) return;
    if (!(await tokens.revokeInvite(id))) return reply.status(404).send({ error: 'not_found' });
    await audit(db, {
      ...actor(req),
      action: 'admin.invite_revoked',
      targetType: 'invite',
      targetId: id,
    });
    return reply.status(204).send();
  });
}
