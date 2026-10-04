import { and, count, eq, isNull } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { recoveryCodes, users, webauthnCredentials } from '../db/schema.js';
import type { SettingsService } from '../settings/settings-service.js';

export interface Factors {
  totp: boolean;
  passkeys: number;
  recoveryCodesRemaining: number;
}

export async function userFactors(db: Pick<Database, 'select'>, userId: string): Promise<Factors> {
  const [[user], [passkeys], [codes]] = await Promise.all([
    db.select({ totpEnabledAt: users.totpEnabledAt }).from(users).where(eq(users.id, userId)),
    db
      .select({ n: count() })
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, userId)),
    db
      .select({ n: count() })
      .from(recoveryCodes)
      .where(and(eq(recoveryCodes.userId, userId), isNull(recoveryCodes.usedAt))),
  ]);
  return {
    totp: Boolean(user?.totpEnabledAt),
    passkeys: passkeys?.n ?? 0,
    recoveryCodesRemaining: codes?.n ?? 0,
  };
}

export const hasSecondFactor = (f: Factors) => f.totp || f.passkeys > 0;

/** Does instance policy require this user to use two-factor authentication? */
export function mfaRequiredFor(settings: SettingsService, user: { isAdmin: boolean }): boolean {
  const policy = settings.get('security.mfaEnforcement');
  return policy === 'everyone' || (policy === 'admins' && user.isAdmin);
}
