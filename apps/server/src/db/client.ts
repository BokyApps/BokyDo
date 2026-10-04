import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres, { type Sql } from 'postgres';
import * as schema from './schema.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DbHandle {
  db: Database;
  sql: Sql;
  close(): Promise<void>;
}

export interface DbConnectionOptions {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

export function connectDb(opts: DbConnectionOptions | string): DbHandle {
  const sql =
    typeof opts === 'string'
      ? postgres(opts, { max: 10, onnotice: () => undefined })
      : postgres({
          host: opts.host,
          port: opts.port,
          database: opts.database,
          username: opts.user,
          password: opts.password,
          max: 10,
          connect_timeout: 10,
          onnotice: () => undefined,
        });
  return { db: drizzle(sql, { schema }), sql, close: () => sql.end({ timeout: 5 }) };
}

/** Wait for Postgres to accept connections (it may still be starting on first boot). */
export async function waitForDb(sql: Sql, attempts = 30, delayMs = 1000): Promise<void> {
  for (let i = 1; ; i++) {
    try {
      await sql`select 1`;
      return;
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../drizzle');

export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
}
