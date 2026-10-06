import { FONT_IDS, THEME_IDS, TEXT_SIZES, type TextSize } from '@bokydo/themes';
import { z } from 'zod';
import { isKnownTimeZone } from './timezones.js';

export const timeZoneSchema = z.string().max(64).refine(isKnownTimeZone, 'Unknown time zone');

export const appearanceSchema = z
  .object({
    mode: z.enum(['system', 'light', 'dark']),
    lightTheme: z.enum(THEME_IDS as [string, ...string[]]),
    darkTheme: z.enum(THEME_IDS as [string, ...string[]]),
    font: z.enum(FONT_IDS),
    textSize: z.enum(Object.keys(TEXT_SIZES) as [TextSize, ...TextSize[]]),
    density: z.enum(['comfortable', 'compact']),
  })
  .strict();
export type Appearance = z.infer<typeof appearanceSchema>;

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:MM');

/** What a user can be notified about, each with its own channel choices. */
export const NOTIFICATION_EVENTS = [
  'reminder',
  'assigned',
  'mentioned',
  'commented',
  'invited',
  'sharing',
  'completed',
  'security',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

const channelsSchema = z.object({ email: z.boolean(), push: z.boolean() }).strict();
export type Channels = z.infer<typeof channelsSchema>;

export const notificationPrefsSchema = z
  .object({
    /** Minutes before a timed task's due time to remind its assignee (or creator); null: off. */
    autoReminder: z
      .number()
      .int()
      .min(0)
      .max(7 * 1440)
      .nullable(),
    /** In-app notifications are always kept; these choose email and push per event. */
    channels: z.object(
      Object.fromEntries(NOTIFICATION_EVENTS.map((e) => [e, channelsSchema])) as Record<
        NotificationEvent,
        typeof channelsSchema
      >,
    ),
    /** No email or push (except reminders) between these local times. */
    quietHours: z.object({ enabled: z.boolean(), start: clock, end: clock }).strict(),
    /** A morning email of today's and overdue tasks. */
    digest: z.object({ enabled: z.boolean(), time: clock }).strict(),
  })
  .strict();
export type NotificationPrefs = z.infer<typeof notificationPrefsSchema>;

/** Per-user preferences, synced to every client (web, Android, widgets). */
export const preferencesSchema = z
  .object({
    /** null until the user picks one (clients offer the detected zone). */
    timezone: timeZoneSchema.nullable(),
    weekStart: z.enum(['monday', 'sunday', 'saturday']),
    timeFormat: z.enum(['24h', '12h']),
    dateFormat: z.enum(['dmy', 'mdy', 'ymd']),
    startPage: z.enum(['inbox', 'today', 'upcoming']),
    smartDateRecognition: z.boolean(),
    appearance: appearanceSchema,
    notifications: notificationPrefsSchema,
  })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;

export const DEFAULT_PREFERENCES: Preferences = {
  timezone: null,
  weekStart: 'monday',
  timeFormat: '24h',
  dateFormat: 'dmy',
  startPage: 'today',
  smartDateRecognition: true,
  appearance: {
    mode: 'system',
    lightTheme: 'bokydo-light',
    darkTheme: 'bokydo-dark',
    font: 'system',
    textSize: 'default',
    density: 'comfortable',
  },
  notifications: {
    autoReminder: 0,
    channels: {
      reminder: { email: false, push: true },
      assigned: { email: true, push: true },
      mentioned: { email: true, push: true },
      commented: { email: false, push: true },
      invited: { email: true, push: true },
      sharing: { email: true, push: false },
      completed: { email: false, push: false },
      // Security alerts always go by email; push is optional.
      security: { email: true, push: true },
    },
    quietHours: { enabled: false, start: '22:00', end: '07:00' },
    digest: { enabled: false, time: '07:00' },
  },
};

/** Stored preferences merged over defaults (tolerates older/partial rows). */
export function resolvePreferences(stored: unknown): Preferences {
  const base = structuredClone(DEFAULT_PREFERENCES);
  if (!stored || typeof stored !== 'object') return base;
  const s = stored as Partial<Preferences>;
  const merged = {
    ...base,
    ...s,
    appearance: { ...base.appearance, ...(s.appearance ?? {}) },
    notifications: mergeNotifications(base.notifications, s.notifications ?? {}),
  };
  const parsed = preferencesSchema.safeParse(merged);
  if (parsed.success) return parsed.data;
  // Keep what's valid rather than resetting everything for one bad field.
  const parts = {
    ...base,
    ...Object.fromEntries(
      Object.entries(merged).filter(
        ([k, v]) =>
          k in preferencesSchema.shape &&
          preferencesSchema.shape[k as keyof Preferences].safeParse(v).success,
      ),
    ),
  };
  const retry = preferencesSchema.safeParse(parts);
  return retry.success ? retry.data : base;
}

/** Deep-merge a (possibly partial) notifications object over `base`. */
export function mergeNotifications(
  base: NotificationPrefs,
  patch: NotificationPrefsPatch | Partial<NotificationPrefs>,
): NotificationPrefs {
  const p = patch as NotificationPrefsPatch;
  const defined = <T extends object>(o: T | undefined) =>
    Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined));
  const channels = { ...base.channels };
  for (const e of NOTIFICATION_EVENTS)
    if (p.channels?.[e]) channels[e] = { ...base.channels[e], ...defined(p.channels[e]) };
  // Security alerts can't be turned off by email.
  channels.security = { ...channels.security, email: true };
  return {
    autoReminder: p.autoReminder === undefined ? base.autoReminder : p.autoReminder,
    channels,
    quietHours: { ...base.quietHours, ...defined(p.quietHours) },
    digest: { ...base.digest, ...defined(p.digest) },
  };
}

const notificationPrefsPatchSchema = z
  .object({
    autoReminder: notificationPrefsSchema.shape.autoReminder.optional(),
    channels: z
      .object(
        Object.fromEntries(
          NOTIFICATION_EVENTS.map((e) => [e, channelsSchema.partial().strict().optional()]),
        ) as Record<
          NotificationEvent,
          z.ZodOptional<
            z.ZodObject<{ email: z.ZodOptional<z.ZodBoolean>; push: z.ZodOptional<z.ZodBoolean> }>
          >
        >,
      )
      .strict()
      .optional(),
    quietHours: notificationPrefsSchema.shape.quietHours.partial().strict().optional(),
    digest: notificationPrefsSchema.shape.digest.partial().strict().optional(),
  })
  .strict();
export type NotificationPrefsPatch = z.infer<typeof notificationPrefsPatchSchema>;

/** Patch sent by clients: any subset; appearance and notifications may be partial too. */
export const preferencesPatchSchema = preferencesSchema
  .omit({ appearance: true, notifications: true })
  .partial()
  .extend({
    appearance: appearanceSchema.partial().strict().optional(),
    notifications: notificationPrefsPatchSchema.optional(),
  })
  .strict();
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;
