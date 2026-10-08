import postgres from 'postgres';

/**
 * The integration tests share one database, and `freshDb()` starts every test file by dropping the
 * `public` schema. Two runs at the same time therefore destroy each other's tables — Postgres
 * answers `42P01 relation "users" does not exist` — which looks exactly like a real failure. In
 * this repository several agents run the tests at once against the same database.
 *
 * So a run holds a session-level advisory lock for its whole duration and concurrent runs
 * serialise. A session lock is released by Postgres when the connection goes away, so a crashed
 * run cannot leave it stuck, and CI (a single run) never waits.
 */
const LOCK = 'bokydo:test-database';

export default async function setup(): Promise<(() => Promise<void>) | undefined> {
  const url = process.env.BOKYDO_TEST_DATABASE_URL;
  if (!url) return undefined;
  // One connection that lives as long as the run: postgres.js otherwise recycles connections after
  // 30–60 minutes, which would silently drop the lock in the middle of a long run or wait.
  const sql = postgres(url, { max: 1, max_lifetime: null });
  const rows = (await sql`
    select pg_try_advisory_lock(hashtext(${LOCK})) as taken
  `) as unknown as { taken: boolean }[];
  if (!rows[0]?.taken) {
    // Say so: otherwise a wait looks like a hang.
    console.log('Waiting for the shared test database (another test run is using it)…');
    await sql`select pg_advisory_lock(hashtext(${LOCK}))`;
  }
  return async () => {
    await sql`select pg_advisory_unlock(hashtext(${LOCK}))`;
    await sql.end();
  };
}
