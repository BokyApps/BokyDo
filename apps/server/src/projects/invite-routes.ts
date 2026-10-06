import {
  createInviteSchema,
  createWorkspaceInviteSchema,
  type GrantableRole,
  type GrantableWorkspaceRole,
  type ProjectInvite,
} from '@bokydo/shared';
import { and, count, eq, isNull, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { logActivity } from '../activity/log.js';
import { audit } from '../audit.js';
import { RateLimiter } from '../auth/rate-limiter.js';
import { newToken, tokenId } from '../auth/tokens.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { projectInvitations, projectMembers, projects, users, workspaces } from '../db/schema.js';
import type { Notifier } from '../email/notifier.js';
import { requireSession } from '../http/access.js';
import { CommandFailure, LIMITS, type ChangeRecorder, type Tx } from '../sync/context.js';
import { addMember } from '../sync/handlers/members.js';
import { joinWorkspace } from '../sync/handlers/workspaces.js';
import { requireProject } from '../sync/policy.js';
import type { SyncService } from '../sync/sync-service.js';
import { requireWorkspace, workspaceRole } from '../workspaces/access.js';
import { creatorName, openInvite, pendingInvites, targetName } from './invites.js';

export const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const PROJECT_RANK: Record<GrantableRole, number> = {
  viewer: 0,
  commenter: 1,
  editor: 2,
  admin: 3,
};

const idParams = z.object({ id: z.uuid() }).strict();
const inviteParams = z.object({ id: z.uuid(), inviteId: z.uuid() }).strict();
const tokenBody = z.object({ token: z.string().min(20).max(100) }).strict();

interface Deps {
  db: Database;
  sync: SyncService;
  notifier: Notifier;
  sessionKey: Buffer;
}

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

/** What an invitation is for, once the caller is known to manage it. */
type Target = { kind: 'project' | 'workspace'; id: string; name: string };

const targetColumn = (kind: Target['kind']) =>
  kind === 'project' ? projectInvitations.projectId : projectInvitations.workspaceId;

/**
 * Invitations to projects and workspaces. Two kinds:
 * - direct: name a username or verified email; the person accepts from their inbox. The
 *   response is the same whether or not that account exists, so this can't discover users;
 * - link: a one-time link (token shown once, stored as an HMAC, expires in 7 days).
 * The role is fixed when the invite is made; only owners can invite admins.
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

  /** The project the caller may manage members of (and may grant `role` in). */
  async function managedProject(
    tx: Tx,
    userId: string,
    id: string,
    role?: GrantableRole,
  ): Promise<Target> {
    const project = await requireProject(tx, userId, id, 'manage');
    if (project.isInbox) throw new CommandFailure('invalid', 'the inbox cannot be shared');
    if (role && PROJECT_RANK[role] >= PROJECT_RANK.admin && project.role !== 'owner')
      throw new CommandFailure('forbidden', 'only the owner can invite admins');
    return { kind: 'project', id: project.id, name: project.name };
  }

  /** The workspace the caller administers (and may grant `role` in). */
  async function managedWorkspace(
    tx: Tx,
    userId: string,
    id: string,
    role?: GrantableWorkspaceRole,
  ): Promise<Target> {
    const ws = await requireWorkspace(tx, userId, id, 'admin');
    if (role === 'admin' && ws.role !== 'owner')
      throw new CommandFailure('forbidden', 'only the owner can invite admins');
    return { kind: 'workspace', id: ws.id, name: ws.name };
  }

  async function isMember(tx: Pick<Tx, 'select'>, target: Target, userId: string) {
    if (target.kind === 'workspace') return (await workspaceRole(tx, target.id, userId)) !== null;
    const [row] = await tx
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, target.id), eq(projectMembers.userId, userId)));
    return Boolean(row);
  }

  async function createInvite(req: FastifyRequest, reply: FastifyReply, kind: Target['kind']) {
    const params = idParams.safeParse(req.params);
    const body = (kind === 'project' ? createInviteSchema : createWorkspaceInviteSchema).safeParse(
      req.body,
    );
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
          const target =
            kind === 'project'
              ? await managedProject(tx, me.id, params.data.id, role as GrantableRole)
              : await managedWorkspace(tx, me.id, params.data.id, role as GrantableWorkspaceRole);
          const column = targetColumn(kind);
          const [pending] = await tx
            .select({ n: count() })
            .from(projectInvitations)
            .where(and(eq(column, target.id), openInvite()));
          if ((pending?.n ?? 0) >= LIMITS.pendingInvitesPerProject)
            throw new CommandFailure('limit_exceeded', 'too many open invitations');
          const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
          const where = kind === 'project' ? { projectId: target.id } : { workspaceId: target.id };

          if (identifier === undefined) {
            const token = newToken();
            const id = newId();
            await tx.insert(projectInvitations).values({
              id,
              ...where,
              role,
              tokenHash: hash(token),
              createdById: me.id,
              expiresAt,
            });
            await audit(tx, {
              action: `${kind}.invite_link`,
              actorType: 'user',
              actorUserId: me.id,
              targetType: kind,
              targetId: target.id,
              ip: req.ip,
              meta: { role },
            });
            return out(201, { id, token, expiresAt: expiresAt.toISOString() });
          }

          // Direct invite. Only verified emails count, so an address can't be claimed to intercept.
          const needle = identifier.toLowerCase();
          const [invitee] = await tx
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
          if (invitee && invitee.id !== me.id && !(await isMember(tx, target, invitee.id))) {
            const [existing] = await tx
              .select({ id: projectInvitations.id })
              .from(projectInvitations)
              .where(
                and(
                  eq(column, target.id),
                  eq(projectInvitations.inviteeId, invitee.id),
                  openInvite(),
                ),
              );
            if (!existing) {
              await tx.insert(projectInvitations).values({
                id: newId(),
                ...where,
                role,
                inviteeId: invitee.id,
                createdById: me.id,
                expiresAt,
              });
              // Pokes the invitee's open clients so the invitation shows up straight away.
              changes.forUser('invitations', target.id, invitee.id);
              deps.notifier.projectInvite(invitee.id, me.username, target.name);
            }
          }
          return out(202, { sent: true });
        }),
      );
    } catch (err) {
      return failureReply(reply, err);
    }
  }

  async function listInvites(req: FastifyRequest, reply: FastifyReply, kind: Target['kind']) {
    const params = idParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const me = requireSession(req).user;
    try {
      return await deps.db.transaction(async (tx) => {
        const target =
          kind === 'project'
            ? await managedProject(tx, me.id, params.data.id)
            : await managedWorkspace(tx, me.id, params.data.id);
        const invitee = sql<
          string | null
        >`(select u.username from users u where u.id = "project_invitations"."invitee_id")`;
        const rows = await tx
          .select({ invite: projectInvitations, invitee, creator: creatorName })
          .from(projectInvitations)
          .where(and(eq(targetColumn(kind), target.id), openInvite()));
        const invites: ProjectInvite[] = rows.map(({ invite, invitee, creator }) => ({
          id: invite.id,
          targetId: target.id,
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
  }

  async function revokeInvite(req: FastifyRequest, reply: FastifyReply, kind: Target['kind']) {
    const params = inviteParams.safeParse(req.params);
    if (!params.success) return reply.status(400).send({ error: 'validation_failed' });
    const me = requireSession(req).user;
    try {
      return send(
        reply,
        await deps.db.transaction(async (tx): Promise<Out> => {
          const target =
            kind === 'project'
              ? await managedProject(tx, me.id, params.data.id)
              : await managedWorkspace(tx, me.id, params.data.id);
          const closed = await tx
            .update(projectInvitations)
            .set({ closedAt: new Date() })
            .where(
              and(
                eq(projectInvitations.id, params.data.inviteId),
                eq(targetColumn(kind), target.id),
                openInvite(),
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
  }

  for (const kind of ['project', 'workspace'] as const) {
    const base =
      kind === 'project' ? '/api/v1/projects/:id/invites' : '/api/v1/workspaces/:id/invites';
    app.post(base, user, (req, reply) => createInvite(req, reply, kind));
    app.get(base, user, (req, reply) => listInvites(req, reply, kind));
    app.delete(`${base}/:inviteId`, user, (req, reply) => revokeInvite(req, reply, kind));
  }

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
                  openInvite(),
                ),
              )
              .returning();
            if (!invite) return out(404, { error: 'not_found' });
            changes.forUser('invitations', invite.id, me.id);
            if (action === 'decline') return out(204);
            const joined = await join(tx, changes, invite, me.id);
            await audit(tx, {
              action: 'invite_accepted',
              actorType: 'user',
              actorUserId: me.id,
              targetType: invite.workspaceId ? 'workspace' : 'project',
              targetId: invite.workspaceId ?? invite.projectId ?? invite.id,
              ip: req.ip,
              meta: { role: invite.role, kind: 'user' },
            });
            return out(200, joined);
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
    const [row] = await deps.db
      .select({ invite: projectInvitations, name: targetName, creator: creatorName })
      .from(projectInvitations)
      .where(and(eq(projectInvitations.tokenHash, hash(body.data.token)), openInvite()));
    if (!row || row.name === null) {
      limiter.failure(key);
      return reply.status(404).send({ error: 'not_found' });
    }
    const target: Target = row.invite.workspaceId
      ? { kind: 'workspace', id: row.invite.workspaceId, name: row.name }
      : { kind: 'project', id: row.invite.projectId as string, name: row.name };
    return {
      kind: target.kind,
      name: row.name,
      role: row.invite.role,
      invitedBy: row.creator,
      alreadyMember: await isMember(deps.db, target, me.id),
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
            .where(and(eq(projectInvitations.tokenHash, hash(body.data.token)), openInvite()))
            .returning();
          if (!invite) {
            limiter.failure(key);
            return out(404, { error: 'not_found' });
          }
          const joined = await join(tx, changes, invite, me.id);
          await audit(tx, {
            action: 'invite_accepted',
            actorType: 'user',
            actorUserId: me.id,
            targetType: invite.workspaceId ? 'workspace' : 'project',
            targetId: invite.workspaceId ?? invite.projectId ?? invite.id,
            ip: req.ip,
            meta: { role: invite.role, kind: 'link' },
          });
          return out(200, joined);
        }),
      );
    } catch (err) {
      return failureReply(reply, err);
    }
  });
}

/** Join the invite's project or workspace with its role, never lowering an existing role. */
async function join(
  tx: Tx,
  changes: ChangeRecorder,
  invite: typeof projectInvitations.$inferSelect,
  userId: string,
): Promise<{ projectId?: string; workspaceId?: string }> {
  if (invite.workspaceId) {
    const [ws] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, invite.workspaceId), isNull(workspaces.deletedAt)));
    if (!ws) throw new CommandFailure('not_found', 'workspace');
    await joinWorkspace(tx, changes, ws.id, userId, invite.role as GrantableWorkspaceRole);
    return { workspaceId: ws.id };
  }
  const projectId = invite.projectId as string;
  const [project] = await tx
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, projectId), isNull(projects.deletedAt)));
  if (!project) throw new CommandFailure('not_found', 'project');
  const role = invite.role as GrantableRole;
  const [member] = await tx
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId)));
  if (
    member &&
    (member.role === 'owner' || PROJECT_RANK[member.role as GrantableRole] >= PROJECT_RANK[role])
  )
    return { projectId };
  await addMember(tx, changes, projectId, userId, role);
  await logActivity(tx, userId, { projectId, type: 'member_joined', data: { userId, role } });
  return { projectId };
}
