import type { CommandArgs } from '@bokydo/shared';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { notifications } from '../../db/schema.js';
import type { CommandContext } from '../context.js';

/** Only ever touches the caller's own notifications. */
export async function notificationsMarkRead(
  ctx: CommandContext,
  args: CommandArgs<'notifications_mark_read'>,
): Promise<void> {
  const marked = await ctx.tx
    .update(notifications)
    .set({ readAt: ctx.now })
    .where(
      and(
        eq(notifications.userId, ctx.userId),
        isNull(notifications.readAt),
        args.ids ? inArray(notifications.id, args.ids) : undefined,
      ),
    )
    .returning({ id: notifications.id });
  const first = marked[0];
  if (first) ctx.changes.forUser('notifications', first.id, ctx.userId);
}
