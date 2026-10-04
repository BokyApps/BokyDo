import path from 'node:path';
import {
  ensureSecretDir,
  ensureSecretFile,
  exists,
  randomSecret,
  readSecretFile,
  writeSecretFile,
} from './security/secret-files.js';

export interface BootstrapOptions {
  /** App data volume (mounted only into the app). */
  dataDir: string;
  /** Volume shared only with the Postgres container. */
  pgSecretDir: string;
  appUid: number;
  pgUid: number;
}

/**
 * First-boot secret generation, run by the one-shot `bootstrap` service before Postgres starts.
 * Generates the database password and hands each container its own copy, owned by that
 * container's user, so Postgres never sees the app's master key and nothing is hard-coded.
 * Idempotent: existing secrets are never replaced.
 */
export async function bootstrap(opts: BootstrapOptions): Promise<void> {
  const app = { uid: opts.appUid };
  const pg = { uid: opts.pgUid };
  const secretsDir = path.join(opts.dataDir, 'secrets');
  await ensureSecretDir(opts.dataDir, app);
  await ensureSecretDir(secretsDir, app);
  await ensureSecretDir(opts.pgSecretDir, pg);

  const appCopy = path.join(secretsDir, 'db_password');
  const pgCopy = path.join(opts.pgSecretDir, 'password');

  // If only the Postgres volume survived (app volume recreated), adopt its password.
  if (!(await exists(appCopy)) && (await exists(pgCopy))) {
    await writeSecretFile(appCopy, await readSecretFile(pgCopy), app);
  }
  const password = await ensureSecretFile(appCopy, () => randomSecret(32), app);
  if (!(await exists(pgCopy))) {
    await writeSecretFile(pgCopy, password, pg);
  } else if ((await readSecretFile(pgCopy)) !== password) {
    throw new Error(
      'Database password copies disagree. Restore the matching volume or remove one copy to resync.',
    );
  }
}
