import { connectDb, runMigrations, type DbHandle } from '../db/client.js';

export const TEST_DATABASE_URL = process.env.BOKYDO_TEST_DATABASE_URL;

/** Fresh, migrated database. Integration tests are skipped when no test database is configured. */
export async function freshDb(): Promise<DbHandle> {
  if (!TEST_DATABASE_URL) throw new Error('BOKYDO_TEST_DATABASE_URL not set');
  const handle = connectDb(TEST_DATABASE_URL);
  await handle.sql.unsafe(
    'drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;',
  );
  await runMigrations(handle.db);
  return handle;
}
