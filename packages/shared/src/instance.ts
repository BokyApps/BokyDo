import { z } from 'zod';

/** Public, unauthenticated instance status. Must never contain secrets or user data. */
export const instanceStatusSchema = z.object({
  name: z.literal('BokyDo'),
  version: z.string(),
  /** False until the initial admin has completed the setup wizard. */
  setupComplete: z.boolean(),
  /** Shown on password forms; not sensitive. */
  passwordMinLength: z.number().int(),
  /** Whether a "Create account" link should be shown (open registration). */
  registrationOpen: z.boolean(),
  /** Whether "Forgot password?" can send email. */
  emailEnabled: z.boolean(),
  /** Passkeys need the public URL to be set and HTTPS (or localhost). */
  passkeysAvailable: z.boolean(),
});
export type InstanceStatus = z.infer<typeof instanceStatusSchema>;

export const healthSchema = z.object({
  status: z.enum(['ok', 'unavailable']),
});
export type Health = z.infer<typeof healthSchema>;
