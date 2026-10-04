import { z } from 'zod';

/** Upper bound keeps hashing cost predictable; passphrases rarely exceed ~100 chars. */
export const PASSWORD_MAX_LENGTH = 256;

export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
  newPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

export const sessionUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  isAdmin: z.boolean(),
  mustChangePassword: z.boolean(),
});
export type SessionUser = z.infer<typeof sessionUserSchema>;

export const sessionInfoSchema = z.object({
  user: sessionUserSchema,
  /** Synchronizer token; send back as `X-CSRF-Token` on every state-changing request. */
  csrfToken: z.string(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export const CSRF_HEADER = 'x-csrf-token';
