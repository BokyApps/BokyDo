import { z } from 'zod';

/** Upper bound keeps hashing cost predictable; passphrases rarely exceed ~100 chars. */
export const PASSWORD_MAX_LENGTH = 256;
export const CSRF_HEADER = 'x-csrf-token';

const password = z.string().min(1).max(PASSWORD_MAX_LENGTH);
/** Opaque 32-byte tokens (links in emails, invites), base64url. */
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/, 'Invalid or expired link');
export const usernameSchema = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/,
    '3–32 characters: letters, digits, dot, dash or underscore',
  );
export const emailSchema = z.email().max(254);

export const loginRequestSchema = z
  .object({ username: z.string().trim().min(1).max(254), password })
  .strict();
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z
  .object({ currentPassword: password, newPassword: password })
  .strict();
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const AUTH_METHODS = [
  'password',
  'password+totp',
  'password+passkey',
  'password+recovery',
  'passkey',
  'registration',
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const sessionUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  isAdmin: z.boolean(),
  mustChangePassword: z.boolean(),
  /** The instance requires two-factor and this user has none yet. */
  mustEnrollMfa: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const sessionInfoSchema = z.object({
  user: sessionUserSchema,
  authMethod: z.enum(AUTH_METHODS),
  /** Synchronizer token; send back as `X-CSRF-Token` on every state-changing request. */
  csrfToken: z.string(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export type MfaMethod = 'totp' | 'passkey' | 'recovery';
/** Password accepted but a second factor is needed; the flow continues via an HttpOnly cookie. */
export interface MfaChallenge {
  mfaRequired: true;
  methods: MfaMethod[];
}
export type LoginResponse = SessionInfo | MfaChallenge;

export const totpCodeSchema = z
  .object({
    code: z
      .string()
      .trim()
      .regex(/^\d{6}$/, 'Enter the 6-digit code'),
  })
  .strict();
export const recoveryCodeSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(8)
      .max(32)
      .regex(/^[A-Za-z0-9-\s]+$/, 'Invalid recovery code'),
  })
  .strict();

/** A WebAuthn response from the browser. The library validates its contents; we bound its shape. */
export const webauthnResponseSchema = z
  .object({
    id: z.string().max(1024),
    rawId: z.string().max(1024),
    type: z.literal('public-key'),
    response: z.record(z.string(), z.unknown()),
    clientExtensionResults: z.record(z.string(), z.unknown()).optional().default({}),
    authenticatorAttachment: z.enum(['platform', 'cross-platform']).nullable().optional(),
  })
  .strict();
export const passkeyVerifySchema = z.object({ response: webauthnResponseSchema }).strict();
export const passkeyRegisterSchema = z
  .object({ response: webauthnResponseSchema, name: z.string().trim().min(1).max(64) })
  .strict();
export const passkeyRenameSchema = z.object({ name: z.string().trim().min(1).max(64) }).strict();

export const reauthRequestSchema = z.object({ password }).strict();
export const passwordResetRequestSchema = z
  .object({ login: z.string().trim().min(1).max(254) })
  .strict();
export const passwordResetCompleteSchema = z
  .object({ token: tokenSchema, newPassword: password })
  .strict();
export const emailVerifySchema = z.object({ token: tokenSchema }).strict();
export const emailUpdateSchema = z.object({ email: emailSchema }).strict();

export const registerRequestSchema = z
  .object({
    username: usernameSchema,
    password,
    email: emailSchema.optional(),
    inviteToken: tokenSchema.optional(),
  })
  .strict();
export const inviteInspectSchema = z.object({ token: tokenSchema }).strict();
export interface InviteInfo {
  valid: boolean;
  email: string | null;
}

/** Account → Security overview. */
export interface AccountSecurity {
  email: string | null;
  emailVerified: boolean;
  totpEnabled: boolean;
  passkeys: {
    id: string;
    name: string;
    createdAt: string;
    lastUsedAt: string | null;
    backedUp: boolean;
  }[];
  recoveryCodesRemaining: number;
  mfaRequired: boolean;
  passkeysAvailable: boolean;
}

export interface TotpSetup {
  secret: string;
  otpauthUrl: string;
  /** data: URL of an SVG QR code. */
  qrCode: string;
}

export interface SessionListItem {
  id: string;
  current: boolean;
  authMethod: AuthMethod;
  createdAt: string;
  lastSeenAt: string;
  ip: string | null;
  userAgent: string | null;
}

// Admin --------------------------------------------------------------------------------------

export const adminCreateUserSchema = z
  .object({
    username: usernameSchema,
    email: emailSchema.optional(),
    isAdmin: z.boolean().optional(),
  })
  .strict();
export const adminUpdateUserSchema = z
  .object({ isAdmin: z.boolean().optional(), disabled: z.boolean().optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to change');
export const adminCreateInviteSchema = z
  .object({
    email: emailSchema.optional(),
    isAdmin: z.boolean().optional(),
    expiresInDays: z.number().int().min(1).max(30).optional(),
  })
  .strict();

export interface AdminUser {
  id: string;
  username: string;
  email: string | null;
  emailVerified: boolean;
  isAdmin: boolean;
  disabled: boolean;
  totpEnabled: boolean;
  passkeys: number;
  createdAt: string;
}

export interface AdminInvite {
  id: string;
  email: string | null;
  isAdmin: boolean;
  createdAt: string;
  expiresAt: string;
}
