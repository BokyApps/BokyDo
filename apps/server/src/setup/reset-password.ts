import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { audit } from '../audit.js';
import { recoveryCodes, sessions, users, webauthnCredentials } from '../db/schema.js';
import { generatePassphrase } from '../security/passphrase.js';
import { hashPassword } from '../security/password.js';

/**
 * Break-glass reset from the host shell (`bokydo admin reset-password <user>`). Shell access to the
 * container already implies full control of the instance, so this needs no further authentication.
 * Returns the new one-time passphrase, or null when the user does not exist.
 */
export async function resetPasswordFromCli(db: Database, username: string): Promise<string | null> {
  const passphrase = generatePassphrase();
  const passwordHash = await hashPassword(passphrase);
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: true, updatedAt: new Date() })
      .where(eq(sql`lower(${users.username})`, username.toLowerCase()))
      .returning({ id: users.id });
    const user = updated[0];
    if (!user) return null;
    // Whoever might be holding the old credentials loses their sessions too.
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await audit(tx, {
      actorType: 'cli',
      action: 'user.password_reset_cli',
      targetType: 'user',
      targetId: user.id,
    });
    return passphrase;
  });
}

/**
 * Break-glass for a user who lost every second factor (e.g. the only admin). Clears TOTP,
 * passkeys and recovery codes and signs them out; the password is unchanged.
 */
export async function resetMfaFromCli(db: Database, username: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(users)
      .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, updatedAt: new Date() })
      .where(eq(sql`lower(${users.username})`, username.toLowerCase()))
      .returning({ id: users.id });
    const user = updated[0];
    if (!user) return false;
    await tx.delete(webauthnCredentials).where(eq(webauthnCredentials.userId, user.id));
    await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, user.id));
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
    await audit(tx, {
      actorType: 'cli',
      action: 'user.mfa_reset_cli',
      targetType: 'user',
      targetId: user.id,
    });
    return true;
  });
}
