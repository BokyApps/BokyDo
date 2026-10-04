import { z } from 'zod';

/**
 * Normalise an instance public URL to its origin. Sub-path hosting is not supported (cookies,
 * passkeys and OAuth redirects are all origin-scoped). Returns null when invalid.
 */
export function normalizePublicUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  if (!url.hostname) return null;
  return url.origin;
}

export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127(\.\d{1,3}){3}$/.test(hostname)
  );
}

export const publicUrlSchema = z
  .string()
  .max(2048)
  .transform((v, ctx) => {
    const origin = normalizePublicUrl(v);
    if (!origin) {
      ctx.addIssue({
        code: 'custom',
        message: 'Must be an http(s) origin such as https://tasks.example.com',
      });
      return z.NEVER;
    }
    return origin;
  });

/** No CR/LF anywhere in values that end up in mail headers. */
const headerSafe = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\r\n]*$/, 'Must not contain line breaks');

const hostname = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .regex(/^[A-Za-z0-9.-]+$|^\[[0-9A-Fa-f:.]+\]$/, 'Must be a hostname or IP address');

/**
 * Every instance-wide setting, its schema and its default. Secret settings are stored encrypted
 * and are write-only through the API.
 */
export const settingDefinitions = {
  'instance.name': { schema: headerSafe(80).min(1), default: 'BokyDo', secret: false },
  'instance.publicUrl': { schema: publicUrlSchema.nullable(), default: null, secret: false },
  'instance.trustedProxyHops': {
    schema: z.number().int().min(0).max(5),
    default: 0,
    secret: false,
  },
  'instance.defaultTimezone': { schema: z.string().min(1).max(64), default: 'UTC', secret: false },
  'instance.weekStart': {
    schema: z.enum(['monday', 'sunday', 'saturday']),
    default: 'monday',
    secret: false,
  },

  'access.registrationMode': {
    schema: z.enum(['closed', 'invite', 'open']),
    default: 'invite',
    secret: false,
  },

  'security.passwordMinLength': {
    schema: z.number().int().min(10).max(128),
    default: 12,
    secret: false,
  },
  'security.mfaEnforcement': {
    schema: z.enum(['off', 'admins', 'everyone']),
    default: 'off',
    secret: false,
  },
  'security.sessionIdleDays': {
    schema: z.number().int().min(1).max(365),
    default: 30,
    secret: false,
  },
  'security.sessionMaxDays': {
    schema: z.number().int().min(1).max(365),
    default: 90,
    secret: false,
  },

  'email.smtpHost': { schema: hostname.nullable(), default: null, secret: false },
  'email.smtpPort': { schema: z.number().int().min(1).max(65535), default: 587, secret: false },
  'email.smtpSecurity': {
    schema: z.enum(['tls', 'starttls', 'none']),
    default: 'starttls',
    secret: false,
  },
  'email.smtpUsername': { schema: headerSafe(256).nullable(), default: null, secret: false },
  'email.smtpPassword': {
    schema: z.string().min(1).max(1024).nullable(),
    default: null,
    secret: true,
  },
  'email.fromAddress': { schema: z.email().max(254).nullable(), default: null, secret: false },
  'email.fromName': { schema: headerSafe(80), default: 'BokyDo', secret: false },
} as const satisfies Record<string, { schema: z.ZodType; default: unknown; secret: boolean }>;

export type SettingKey = keyof typeof settingDefinitions;
export type SettingValue<K extends SettingKey> = z.output<(typeof settingDefinitions)[K]['schema']>;
export type Settings = { [K in SettingKey]: SettingValue<K> };

export const settingKeys = Object.keys(settingDefinitions) as SettingKey[];

/** What the admin API returns: secrets are reported only as set / not set. */
export type PublicSettings = {
  [K in SettingKey]: (typeof settingDefinitions)[K]['secret'] extends true
    ? { isSet: boolean }
    : SettingValue<K>;
};

/** PATCH body: any subset of keys. For secrets, a string sets it and null clears it. */
export const settingsPatchSchema = z
  .object(
    Object.fromEntries(settingKeys.map((k) => [k, settingDefinitions[k].schema.optional()])) as {
      [K in SettingKey]: z.ZodOptional<(typeof settingDefinitions)[K]['schema']>;
    },
  )
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'No settings given');
export type SettingsPatch = z.input<typeof settingsPatchSchema>;

export const setPublicUrlRequestSchema = z.object({ publicUrl: publicUrlSchema }).strict();

export const testEmailRequestSchema = z.object({ to: z.email().max(254) }).strict();

export const setupStatusSchema = z.object({
  passwordChanged: z.boolean(),
  publicUrl: z.string().nullable(),
  publicUrlWarning: z.enum(['insecure_http']).nullable(),
  canComplete: z.boolean(),
});
export type SetupStatus = z.infer<typeof setupStatusSchema>;
