import { z } from 'zod';
import { aiRoutingSchema, privateAllowlistEntrySchema } from './ai.js';
import { timeZoneSchema } from './preferences.js';
import { pushHostEntrySchema } from './push.js';

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
  'instance.defaultTimezone': { schema: timeZoneSchema, default: 'UTC', secret: false },
  'instance.weekStart': {
    schema: z.enum(['monday', 'sunday', 'saturday']),
    default: 'monday',
    secret: false,
  },

  /** Largest file that can be attached to a comment (0 turns uploads off). */
  'attachments.maxSizeMb': { schema: z.number().int().min(0).max(100), default: 25, secret: false },

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
  /** Opt-in: checks new passwords against Have I Been Pwned (k-anonymity; only a 5-char hash prefix leaves). */
  'security.breachedPasswordCheck': { schema: z.boolean(), default: false, secret: false },
  'security.newLoginAlerts': { schema: z.boolean(), default: true, secret: false },

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

  /** Personal access tokens and OAuth apps may call the API (off = bearer tokens refused). */
  'api.enabled': { schema: z.boolean(), default: true, secret: false },
  /**
   * Anyone may register an OAuth client (RFC 7591), as MCP connectors such as Claude and ChatGPT
   * expect. Registration grants nothing: every client still needs a user's consent.
   */
  'api.dynamicClientRegistration': { schema: z.boolean(), default: true, secret: false },
  /**
   * SHA-256 signing-certificate fingerprints of the Android app builds this instance trusts,
   * published in /.well-known/assetlinks.json (passkeys and app links). Empty: none.
   */
  'android.certFingerprints': {
    schema: z
      .array(
        z
          .string()
          .trim()
          .toUpperCase()
          .regex(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/, 'Expected a SHA-256 fingerprint (AA:BB:…)'),
      )
      .max(10),
    default: [],
    secret: false,
  },
  /** The MCP endpoint (`/mcp`) for AI assistants such as Claude and ChatGPT. */
  'api.mcpEnabled': { schema: z.boolean(), default: true, secret: false },

  /** Automatic encrypted backups (Admin → Backups). Off until a passphrase is set and this is on. */
  'backups.schedule': { schema: z.enum(['off', 'daily', 'weekly']), default: 'off', secret: false },
  /** Hour of the day (instance time zone) scheduled backups run after. */
  'backups.hour': { schema: z.number().int().min(0).max(23), default: 3, secret: false },
  /** How many scheduled/manual backups to keep. */
  'backups.retention': { schema: z.number().int().min(1).max(90), default: 7, secret: false },
  /**
   * Encrypts every backup (argon2id → AES-256-GCM). Without it a backup can't be restored, and
   * it is not stored in backups: keep it somewhere safe, apart from the server.
   */
  'backups.passphrase': {
    schema: z.string().min(12, 'Use at least 12 characters').max(1024).nullable(),
    default: null,
    secret: true,
  },

  /** Users may add their own provider keys (their usage is metered but not budgeted). */
  'ai.userKeys': { schema: z.boolean(), default: true, secret: false },
  /**
   * Experimental: users may sign in to their own AI subscriptions (SuperGrok) instead of adding
   * a key. Off by default: these flows aren't official APIs and may change (ADR 0017).
   */
  'ai.subscriptionSignIn': { schema: z.boolean(), default: false, secret: false },
  /** Who may use the instance's routing and keys, which count against the budgets below. */
  'ai.instanceAccess': {
    schema: z.enum(['off', 'admins', 'everyone']),
    default: 'admins',
    secret: false,
  },
  /** Per-user monthly (UTC) token budget on instance keys; null = unlimited. */
  'ai.monthlyTokenBudget': {
    schema: z.number().int().min(0).max(10_000_000_000).nullable(),
    default: 1_000_000,
    secret: false,
  },
  /** Per-user monthly (UTC) speech-to-text minutes on instance keys; null = unlimited. */
  'ai.monthlyAudioMinutes': {
    schema: z.number().int().min(0).max(1_000_000).nullable(),
    default: 300,
    secret: false,
  },
  /** Feature → instance credential + model. */
  'ai.routing': { schema: aiRoutingSchema, default: {}, secret: false },
  /**
   * Private networks that instance AI credentials (e.g. a local Ollama) may reach. Users' own
   * credentials only ever reach the public internet.
   */
  'network.privateAllowlist': {
    schema: z.array(privateAllowlistEntrySchema).max(20),
    default: [],
    secret: false,
  },
  /**
   * Push services besides the browser vendors' (FCM, Mozilla, Apple, Windows) that devices may
   * register with: UnifiedPush distributors such as ntfy, or a self-hosted push server. Only
   * list servers you trust to relay notifications; their private addresses become reachable.
   */
  'push.allowedHosts': {
    schema: z.array(pushHostEntrySchema).max(20),
    default: [],
    secret: false,
  },
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
