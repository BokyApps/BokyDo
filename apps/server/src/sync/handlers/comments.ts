import type { CommandArgs } from '@bokydo/shared';
import { and, count, eq, isNull } from 'drizzle-orm';
import { logActivity } from '../../activity/log.js';
import { commentReactions, comments, tasks } from '../../db/schema.js';
import { fail, LIMITS, type CommandContext } from '../context.js';
import { can, projectAccess, requireProject } from '../policy.js';

/** Comments need the commenter role; authors edit their own; admins may delete any. */

async function commentTarget(ctx: CommandContext, args: CommandArgs<'comment_add'>) {
  if (args.taskId) {
    const [task] = await ctx.tx
      .select({ id: tasks.id, projectId: tasks.projectId, content: tasks.content })
      .from(tasks)
      .where(and(eq(tasks.id, args.taskId), isNull(tasks.deletedAt)));
    if (!task) return fail('not_found', 'task');
    const project = await requireProject(ctx.tx, ctx.userId, task.projectId, 'comment');
    return { project, task };
  }
  const project = await requireProject(ctx.tx, ctx.userId, args.projectId ?? '', 'comment');
  return { project, task: null };
}

export async function commentAdd(
  ctx: CommandContext,
  args: CommandArgs<'comment_add'>,
): Promise<void> {
  const { project, task } = await commentTarget(ctx, args);
  if (project.isArchived) fail('invalid', 'project is archived');
  const [n] = await ctx.tx
    .select({ n: count() })
    .from(comments)
    .where(
      and(
        eq(comments.projectId, project.id),
        task ? eq(comments.taskId, task.id) : isNull(comments.taskId),
        isNull(comments.deletedAt),
      ),
    );
  if ((n?.n ?? 0) >= LIMITS.commentsPerThread) fail('limit_exceeded', 'too many comments');
  await ctx.tx.insert(comments).values({
    id: args.id,
    projectId: project.id,
    taskId: task?.id ?? null,
    userId: ctx.userId,
    content: args.content,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  });
  ctx.changes.inProject('comments', args.id, project.id);
  await logActivity(ctx.tx, ctx.userId, {
    projectId: project.id,
    taskId: task?.id ?? null,
    type: 'comment_added',
    data: { title: task?.content ?? null, excerpt: args.content.slice(0, 140) },
  });
}

/** A live comment the user can still see (with their role in its project). */
async function requireComment(ctx: CommandContext, id: string) {
  const [comment] = await ctx.tx
    .select()
    .from(comments)
    .where(and(eq(comments.id, id), isNull(comments.deletedAt)));
  if (!comment) return fail('not_found', 'comment');
  const access = await projectAccess(ctx.tx, ctx.userId, comment.projectId);
  if (!access) return fail('not_found', 'comment');
  return { comment, role: access.role, archived: access.project.isArchived };
}

export async function commentUpdate(
  ctx: CommandContext,
  args: CommandArgs<'comment_update'>,
): Promise<void> {
  const { comment, role, archived } = await requireComment(ctx, args.id);
  if (comment.userId !== ctx.userId || !can(role, 'comment'))
    fail('forbidden', 'only the author can edit');
  if (archived) fail('invalid', 'project is archived');
  await ctx.tx
    .update(comments)
    .set({ content: args.content, updatedAt: ctx.now })
    .where(eq(comments.id, comment.id));
  ctx.changes.inProject('comments', comment.id, comment.projectId);
}

export async function commentDelete(
  ctx: CommandContext,
  args: CommandArgs<'comment_delete'>,
): Promise<void> {
  const { comment, role } = await requireComment(ctx, args.id);
  const own = comment.userId === ctx.userId && can(role, 'comment');
  if (!own && !can(role, 'manage')) fail('forbidden', 'only the author or an admin can delete');
  await ctx.tx
    .update(comments)
    .set({ deletedAt: ctx.now, updatedAt: ctx.now })
    .where(eq(comments.id, comment.id));
  ctx.changes.inProject('comments', comment.id, comment.projectId);
}

export async function reactionToggle(
  ctx: CommandContext,
  args: CommandArgs<'reaction_toggle'>,
): Promise<void> {
  const { comment, role } = await requireComment(ctx, args.commentId);
  if (!can(role, 'comment')) fail('forbidden', 'requires commenter');
  const key = and(
    eq(commentReactions.commentId, comment.id),
    eq(commentReactions.userId, ctx.userId),
    eq(commentReactions.emoji, args.emoji),
  );
  const removed = await ctx.tx.delete(commentReactions).where(key).returning();
  if (removed.length === 0)
    await ctx.tx
      .insert(commentReactions)
      .values({ commentId: comment.id, userId: ctx.userId, emoji: args.emoji });
  ctx.changes.inProject('comments', comment.id, comment.projectId);
}
