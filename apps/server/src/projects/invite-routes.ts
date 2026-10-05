import { createInviteSchema, type GrantableRole, type ProjectInvite } from '@bokydo/shared';
import { and, count, eq, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { logActivity } from '../activity/log.js';
import { audit } from '../audit.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { newToken, tokenId } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { projectInvitations, projectMembers, projects, users } from '../db/schema.js';
import type { Notifier } from '../email/notifier.js';
import { requireSession } from '../http/access.js';
import { CommandFailure, LIMITS, type Tx } from '../sync/context.js';
import { addMember } from '../sync/handlers/members.js';
import { requireProject } from '../sync/policy.js';
import type { SyncService } from '../sync/sync-service.js';
import { openInvite, pendingInvites } from './invites.js';

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const RANK: Record<GrantableRole, number> = { viewer: 0, commenter: 1, editor: 2, admin: 3 };

const idParams = z.object({ id: z.uuid() }).strict();
const inviteParams = z.object({ id: z.uuid(), inviteId: z.uuid() }).strict();
const tokenBody = z.object({ token: z.string().min(20).max(100) }).strict();

interface Deps {
  db: Database;
  sync: SyncService;
  notifier: Notifier;
  sessionKey: Buffer;
}

const open = openInvite;

/** A response decided inside a transaction, sent only after it commits. */
type Out = { status: number; body?: unknown };
const out = (status: number, body?: unknown): Out => ({ status, body });
const send = (reply: FastifyReply, o: Out) =>
  o.body === undefined ? reply.status(o.status).send() : reply.status(o.status).send(o.body);

function failureReply(reply: FastifyReply, err: unknown) {
  if (err instanceof CommandFailure) {
    const status = {
      not_found: 404,
      forbidden: 403,
      invalid: 400,
      conflict: 409,
      limit_exceeded: 429,
    }[err.code];
    return reply.status(status).send({ error: err.code, message: err.message });
  }
  throw err;
}

/**
 * Project invitations. Two kinds:
 * - direct: name a username or email; the person accepts from their inbox. The response is the
 *   same whether or not that account exists, so this can't be used to discover users;
 * - link: a one-time link (token shown once, stored as an HMAC, expires in 7 days).
 * The role is fixed when the invite is made, and admins can only invite below admin.
 */
export function registerInviteRoutes(app: FastifyInstance, deps: Deps): void {
  const user = { config: { access: 'user' } } as const;
  const hash = (token: string) => tokenId(deps.sessionKey, 'project-invite', token);
  const limiter = new RateLimiter({
    windowMs: 3600_000,
    maxPerWindow: 50,
    freeFailures: 5,
    maxBackoffMs: 15 * 60_000,
  });

  /** Caller may manage members of the project, and may grant this role. */
  async function managed(tx: Tx, userId: string, projectId: string, role?: GrantableRole) {
    const project = await requireProject(tx, userId, projectId, 'manage');
    if (project.isInbox) throw new CommandFailure('invalid', 'the inbox cannot be shared');
    if (role && RANK[role] >= RANK.admin && project.role !== 'owner')
      throw new CommandFailure('forbidden', 'only the owner can invite admins');
    return project;
  }

  app.post('/api/v1/projects/:id/invites', user, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    const body = createInviteSchema.safeParse(req.body);
    if (!params.success || !body.success)
      return reply.status(400).send({ error: 'validation_failed' });
    const me = requireSession(req).user;
    const limit = limiter.attempt(me.id);
    if (!limit.allowed) {
      reply.header('retry-after', String(limit.retryAfterSeconds));
      return reply.status(429).send({ error: 'rate_limited' });
    }
    const { identifier, role } = body.data;
    try {
      return send(
        reply,
        await deps.sync.write(async (tx, changes): Promise<Out> => {
          const project = await managed(tx, me.id, params.data.id, role);
          const [pending] = await tx
            .select({ n: count() })
            .from(projectInvitations)
            .where(and(eq(projectInvitations.projectId, project.id), open()));
          if ((pending?.n ?? 0) >= LIMITS.pendingInvitesPerProject)
            throw new CommandFailure('limit_exceeded', 'too many open invitations');
          const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

          if (identifier === undefined) {
            const token = newToken();
            const id = newId();
            await tx.insert(projectInvitations).values({
              id,
              projectId: project.id,
              role,
              tokenHash: hash(token),
              createdById: me.id,
              expiresAt,
            });
            await audit(tx, {
              action: 'project.invite_link',
              actorType: 'user',
              actorUserId: me.id,
              targetType: 'project',
              targetId: project.id,
              ip: req.ip,
              meta: { role },
            });
            return out(201, { id, token, expiresAt: expiresAt.toISOString() });
          }

          // Direct invite. Only verified emails count, so an address can't be claimed to intercept.
          const needle = identifier.toLowerCase();
          const [target] = await tx
            .select({ id: users.id })
            .from(users)
            .where(
              and(
                isNull(users.disabledAt),
                or(
                  sql`lower(${users.username}) = ${needle}`,
                  and(
                    sql`lower(${users.email}) = ${needle}`,
                    sql`${users.emailVerifiedAt} is not null`,
                  ),
                ),
              ),
            );
          if (target && target.id !== me.id) {
            const [member] = await tx
              .select({ role: projectMembers.role })
              .from(projectMembers)
              .where(
                and(eq(projectMembers.projectId, project.id), eq(projectMembers.userId, target.id)),
              );
            const [existing] = await tx
              .select({ id: projectInvitations.id })
              .from(projectInvitations)
              .where(
                and(
                  eq(projectInvitations.projectId, project.id),
                  eq(projectInvitations.inviteeId, target.id),
                  open(),
                ),
              );
            if (!member && !existing) {
              await tx.insert(projectInvitations).values({
                id: newId(),
                projectId: project.id,
                role,
                inviteeId: target.id,
                createdById: me.id,
                expiresAt,
              });
              // Pokes the invitee's open clients so the invitation shows up straight away.
              changes.forUser('invitations', project.id, target.id);
              deps.notifier.projectInvite(target.id, me.username, project.name);
            }
          }
          return out(202, { sent: true });
        }),
      );
    } catch (err) {
      return failureReply(reply, err);
    }
  });

  app.get('/api/v1/projects/:id/invites', user, async (req, reply) => {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const me = requireSession(req).user;
    try {
      return await deps.db.transaction(async (tx) => {
        const project = await managed(tx, me.id, params.data.id);
        const invitee = sql<
          string | null
        >`(select username from users u where u.id = ${projectInvitations.inviteeId})`;
        const creator = sql<
          string | null
        >`(select username from users u where u.id = ${projectInvitations.createdById})`;
        const rows = await tx
          .select({ invite: projectInvitations, invitee, creator })
          .from(projectInvitations)
          .where(and(eq(projectInvitations.projectId, project.id), open()));
        const invites: ProjectInvite[] = rows.map(({ invite, invitee, creator }) => ({
          id: invite.id,
          projectId: invite.projectId,
          role: invite.role,
          kind: invite.inviteeId ? 'user' : 'link',
          invitee,
          createdBy: creator,
          createdAt: invite.createdAt.toISOString(),
          expiresAt: invite.expiresAt.toISOString(),
        }));
        return { invites };
      });
    } catch (err) {
      return failureReply(reply, err);
    }
  });

  app.delete('/api/v1/projects/:id/invites/:inviteId', user, async (req, reply) => {
    const params = inviteParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const me = requireSession(req).user;
    try {
      return send(
        reply,
        await deps.db.transaction(async (tx): Promise<Out> => {
          await managed(tx, me.id, params.data.id);
          const closed = await tx
            .update(projectInvitations)
            .set({ closedAt: new Date() })
            .where(
              and(
                eq(projectInvitations.id, params.data.inviteId),
                eq(projectInvitations.projectId, params.data.id),
                open(),
              ),
            )
            .returning({ id: projectInvitations.id });
          if (closed.length === 0) return out(404, { error: 'not_found' });
          return out(204);
        }),
      );
    } catch (err) {
      return failureReply(reply, err);
    }
  });

  /** Invitations waiting for me. */
  app.get('/api/v1/invites', user, async (req) => ({
    invites: await pendingInvites(deps.db, requireSession(req).user.id),
  }));

  /** Accept or decline a direct invitation addressed to me. */
  for (const action of ['accept', 'decline'] as const) {
    app.post(`/api/v1/invites/:id/${action}`, user, async (req, reply) => {
      const params = idParams.safeParse(req.params);
      if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
      const me = requireSession(req).user;
      try {
        return send(
          reply,
          await deps.sync.write(async (tx, changes): Promise<Out> => {
            // Claiming the row atomically means a double click can't join twice.
            const [invite] = await tx
              .update(projectInvitations)
              .set(
                action === 'accept'
                  ? { acceptedAt: new Date(), acceptedById: me.id }
                  : { closedAt: new Date() },
              )
              .where(
                and(
                  eq(projectInvitations.id, params.data.id),
                  eq(projectInvitations.inviteeId, me.id),
                  open(),
                ),
              )
              .returning();
            if (!invite) return out(404, { error: 'not_found' });
            changes.forUser('invitations', invite.projectId, me.id);
            if (action === 'decline') return out(204);
            await joinProject(tx, changes, invite.projectId, me.id, invite.role);
            await audit(tx, {
              action: 'project.invite_accepted',
              actorType: 'user',
              actorUserId: me.id,
              targetType: 'project',
              targetId: invite.projectId,
              ip: req.ip,
              meta: { role: invite.role, kind: 'user' },
            });
            return out(200, { projectId: invite.projectId });
          }),
        );
      } catch (err) {
        return failureReply(reply, err);
      }
    });
  }

  /** What a link invites to, before joining (token in the body: never in URLs or logs). */
  app.post('/api/v1/invites/link/preview', user, async (req, reply) => {
    const body = tokenBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'validation_failed' });
    const me = requireSession(req).user;
    const key = `link:${req.ip}`;
    if (!limiter.attempt(key).allowed) return reply.status(429).send({ error: 'rate_limited' });
    const creator = sql<
      string | null
    >`(select username from users u where u.id = ${projectInvitations.createdById})`;
    const [row] = await deps.db
      .select({ invite: projectInvitations, projectName: projects.name, creator })
      .from(projectInvitations)
      .innerJoin(projects, eq(projects.id, projectInvitations.projectId))
      .where(
        and(
          eq(projectInvitations.tokenHash, hash(body.data.token)),
          open(),
          isNull(projects.deletedAt),
        ),
      );
    if (!row) {
      limiter.failure(key);
      return reply.status(404).send({ error: 'not_found' });
    }
    const [member] = await deps.db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(eq(projectMembers.projectId, row.invite.projectId), eq(projectMembers.userId, me.id)),
      );
    return {
      projectName: row.projectName,
      role: row.invite.role,
      invitedBy: row.creator,
      alreadyMember: Boolean(member),
    };
  });

  app.post('/api/v1/invites/link/accept', user, async (req, reply) => {
    const body = tokenBody.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'validation_failed' });
    const me = requireSession(req).user;
    const key = `link:${req.ip}`;
    if (!limiter.attempt(key).allowed) return reply.status(429).send({ error: 'rate_limited' });
    try {
      return send(
        reply,
        await deps.sync.write(async (tx, changes): Promise<Out> => {
          const [invite] = await tx
            .update(projectInvitations)
            .set({ acceptedAt: new Date(), acceptedById: me.id })
            .where(and(eq(projectInvitations.tokenHash, hash(body.data.token)), open()))
            .returning();
          if (!invite) {
            limiter.failure(key);
            return out(404, { error: 'not_found' });
          }
          await joinProject(tx, changes, invite.projectId, me.id, invite.role);
          await audit(tx, {
            action: 'project.invite_accepted',
            actorType: 'user',
            actorUserId: me.id,
            targetType: 'project',
            targetId: invite.projectId,
            ip: req.ip,
            meta: { role: invite.role, kind: 'link' },
          });
          return out(200, { projectId: invite.projectId });
        }),
      );
    } catch (err) {
      return failureReply(reply, err);
    }
  });
}

/** Join with the invite's role, never lowering a role the user already has. */
async function joinProject(
  tx: Tx,
  changes: Parameters<typeof addMember>[1],
  projectId: string,
  userId: string,
  role: GrantableRole,
) {
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
  if (!project) throw new CommandFailure('not_found', 'project');
  const [member] = await tx
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  if (member && (member.role === 'owner' || RANK[member.role] >= RANK[role])) return;
  await addMember(tx, changes, projectId, userId, role);
  await logActivity(tx, userId, { projectId, type: 'member_joined', data: { userId, role } });
}
