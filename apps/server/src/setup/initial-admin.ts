import { count, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { auditLog, instanceSettings, users } from '../db/schema.js';
import { generatePassphrase } from '../security/passphrase.js';
import { hashPassword } from '../security/password.js';
import { SETUP_COMPLETE_KEY } from './instance-settings.js';

export const INITIAL_ADMIN_USERNAME = 'admin';

/**
 * On a fresh install, create the `admin` account with a random one-time passphrase that must be
 * changed at first login. Returns the passphrase only when the account was created by this call;
 * it is never stored anywhere except as an Argon2id hash.
 */
export async function ensureInitialAdmin(db: Database): Promise<string | null> {
  return db.transaction(async (tx) => {
    // Serialise concurrent starts (e.g. several replicas) so exactly one admin is created.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('bokydo:initial-admin'))`);
    const [row] = await tx.select({ n: count() }).from(users);
    if ((row?.n ?? 0) > 0) return null;

    const passphrase = generatePassphrase();
    const id = newId();
    await tx.insert(users).values({
      id,
      username: INITIAL_ADMIN_USERNAME,
      passwordHash: await hashPassword(passphrase),
      isAdmin: true,
      mustChangePassword: true,
    });
    await tx
      .insert(instanceSettings)
      .values({ key: SETUP_COMPLETE_KEY, value: false })
      .onConflictDoNothing();
    await tx.insert(auditLog).values({
      id: newId(),
      actorType: 'system',
      action: 'user.initial_admin_created',
      targetType: 'user',
      targetId: id,
    });
    return passphrase;
  });
}

export function credentialBanner(opts: {
  heading: string;
  username: string;
  passphrase: string;
}): string {
  const lines = [
    opts.heading,
    '',
    `  Username:   ${opts.username}`,
    `  Passphrase: ${opts.passphrase}`,
    '',
    'This passphrase is shown only once and must be changed at first login.',
    `Lost it? Run: docker compose exec app bokydo admin reset-password ${opts.username}`,
  ];
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = '='.repeat(width);
  return ['', bar, ...lines.map((l) => `  ${l}`), bar, ''].join('\n');
}
