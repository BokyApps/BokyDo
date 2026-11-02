import { eq, sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { instanceSettings } from '../db/schema.js';

export const SETUP_COMPLETE_KEY = 'setup.complete';
/** Shared by first-admin signup and ordinary registration to protect the first-user slot. */
export const INITIAL_ADMIN_LOCK = sql`select pg_advisory_xact_lock(hashtext('bokydo:initial-admin'))`;

export async function isSetupComplete(db: Pick<Database, 'select'>): Promise<boolean> {
  const rows = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, SETUP_COMPLETE_KEY));
  return rows[0]?.value === true;
}
