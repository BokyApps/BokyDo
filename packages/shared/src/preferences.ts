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
};

/** Stored preferences merged over defaults (tolerates older/partial rows). */
export function resolvePreferences(stored: unknown): Preferences {
  const base = structuredClone(DEFAULT_PREFERENCES);
  if (!stored || typeof stored !== 'object') return base;
  const s = stored as Partial<Preferences>;
  const merged = { ...base, ...s, appearance: { ...base.appearance, ...(s.appearance ?? {}) } };
  const parsed = preferencesSchema.safeParse(merged);
  return parsed.success ? parsed.data : base;
}

/** Patch sent by clients: any subset; appearance may be partial too. */
export const preferencesPatchSchema = preferencesSchema
  .omit({ appearance: true })
  .partial()
  .extend({ appearance: appearanceSchema.partial().strict().optional() })
  .strict();
export type PreferencesPatch = z.infer<typeof preferencesPatchSchema>;
