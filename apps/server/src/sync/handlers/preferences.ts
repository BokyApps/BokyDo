import { resolvePreferences, type CommandArgs } from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import type { CommandContext } from '../context.js';

/**
 * Merge a preferences patch. The user row is always included in sync responses, so the change
 * marker only exists to poke the user's other devices.
 */
export async function userUpdatePreferences(
  ctx: CommandContext,
  args: CommandArgs<'user_update_preferences'>,
): Promise<void> {
  const [row] = await ctx.tx
    .select({ preferences: users.preferences })
    .from(users)
    .where(eq(users.id, ctx.userId));
  const current = resolvePreferences(row?.preferences);
  const { appearance, ...rest } = args;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const next = resolvePreferences({
    ...current,
    ...defined,
    appearance: {
      ...current.appearance,
      ...Object.fromEntries(Object.entries(appearance ?? {}).filter(([, v]) => v !== undefined)),
    },
  });
  await ctx.tx
    .update(users)
    .set({ preferences: next, updatedAt: ctx.now })
    .where(eq(users.id, ctx.userId));
  ctx.changes.forUser('user', ctx.userId, ctx.userId);
}
