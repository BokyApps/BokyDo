import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DbHandle } from '../db/client.js';
import { auditLog, users } from '../db/schema.js';
import { verifyPassword } from '../security/password.js';
import { freshDb, TEST_DATABASE_URL } from '../test/db.js';
import { ensureInitialAdmin } from './initial-admin.js';
import { isSetupComplete } from './instance-settings.js';
import { resetPasswordFromCli } from './reset-password.js';

describe.skipIf(!TEST_DATABASE_URL)('initial admin (Postgres)', () => {
  let h: DbHandle;
  beforeAll(async () => {
    h = await freshDb();
  });
  afterAll(async () => h?.close());

  it('creates exactly one admin even when several instances start at once', async () => {
    const results = await Promise.all(Array.from({ length: 5 }, () => ensureInitialAdmin(h.db)));
    const created = results.filter((r): r is string => r !== null);
    expect(created).toHaveLength(1);

    const all = await h.db.select().from(users);
    expect(all).toHaveLength(1);
    const admin = all[0]!;
    expect(admin.username).toBe('admin');
    expect(admin.isAdmin).toBe(true);
    expect(admin.mustChangePassword).toBe(true);
    expect(admin.passwordHash).not.toContain(created[0]!);
    expect(await verifyPassword(admin.passwordHash, created[0]!)).toBe(true);
    expect(await isSetupComplete(h.db)).toBe(false);
  });

  it('does nothing on later boots', async () => {
    expect(await ensureInitialAdmin(h.db)).toBeNull();
  });

  it('CLI reset issues a new passphrase, forces a change and audits it', async () => {
    const [before] = await h.db.select().from(users);
    const passphrase = await resetPasswordFromCli(h.db, 'ADMIN');
    expect(passphrase).toBeTruthy();
    const [after] = await h.db.select().from(users);
    expect(after!.passwordHash).not.toBe(before!.passwordHash);
    expect(await verifyPassword(after!.passwordHash, passphrase!)).toBe(true);
    expect(after!.mustChangePassword).toBe(true);
    const audits = await h.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'user.password_reset_cli'));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(passphrase!);
  });

  it('CLI reset reports unknown users', async () => {
    expect(await resetPasswordFromCli(h.db, 'nobody')).toBeNull();
  });
});
