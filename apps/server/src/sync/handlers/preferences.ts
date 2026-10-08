import {
  mergeNotifications,
  productivityPrefsSchema,
  resolvePreferences,
  type CommandArgs,
} from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';
import { refreshUserReminders } from '../../reminders/reminders.js';
import { fail, type CommandContext } from '../context.js';

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
  const { appearance, notifications, productivity, ...rest } = args;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  // `null` is meaningful here (clearing a vacation date), so only `undefined` is dropped.
  const nextProductivity = {
    ...current.productivity,
    ...Object.fromEntries(Object.entries(productivity ?? {}).filter(([, v]) => v !== undefined)),
  };
  // Checked as a whole: a patch can set one end of the vacation past the other. Rejected rather
  // than letting the merge below quietly fall back to the default goals.
  const checked = productivityPrefsSchema.safeParse(nextProductivity);
  if (!checked.success) fail('invalid', checked.error.issues[0]?.message);
  const next = resolvePreferences({
    ...current,
    ...defined,
    appearance: {
      ...current.appearance,
      ...Object.fromEntries(Object.entries(appearance ?? {}).filter(([, v]) => v !== undefined)),
    },
    notifications: mergeNotifications(current.notifications, notifications ?? {}),
    productivity: nextProductivity,
  });
  await ctx.tx
    .update(users)
    .set({ preferences: next, updatedAt: ctx.now })
    .where(eq(users.id, ctx.userId));
  ctx.changes.forUser('user', ctx.userId, ctx.userId);
  // Floating due times and automatic reminders depend on these.
  if (
    next.timezone !== current.timezone ||
    next.notifications.autoReminder !== current.notifications.autoReminder
  )
    await refreshUserReminders(ctx.tx, ctx.changes, ctx.userId, ctx.defaultTimeZone);
}
