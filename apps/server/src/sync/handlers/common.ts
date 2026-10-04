import { generateKeyBetween } from '@bokydo/shared';
import { and, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import type { Tx } from '../context.js';

/** Order key after the current last sibling. Keys compare in byte order, hence COLLATE "C". */
export async function nextOrderKey(
  tx: Tx,
  table: PgTable,
  column: AnyPgColumn,
  where: SQL,
): Promise<string> {
  const [row] = await tx
    .select({ last: sql<string | null>`max(${column} collate "C")` })
    .from(table)
    .where(where);
  return generateKeyBetween(row?.last ?? null, null);
}

/** Postgres error code of a driver error (Drizzle wraps it in `cause`), if any. */
export function pgCode(err: unknown): string | undefined {
  for (
    let e: unknown = err, depth = 0;
    e && typeof e === 'object' && depth < 3;
    e = (e as { cause?: unknown }).cause, depth++
  ) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

/** `and(...)` for conditions that are always present (drizzle types `and` as possibly undefined). */
export function allOf(...conditions: SQL[]): SQL {
  const combined = and(...conditions);
  if (!combined) throw new Error('allOf() needs at least one condition');
  return combined;
}
