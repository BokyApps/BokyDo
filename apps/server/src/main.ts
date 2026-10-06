import { loadConfig } from './config.js';
import { connectDb, runMigrations, waitForDb } from './db/client.js';
import { buildApp } from './app.js';
import { ensureAppSecrets } from './security/app-secrets.js';
import { ensureDbPassword } from './security/db-password.js';
import { readSecretFile } from './security/secret-files.js';
import {
  credentialBanner,
  ensureInitialAdmin,
  INITIAL_ADMIN_USERNAME,
} from './setup/initial-admin.js';
import { VERSION } from './version.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const secrets = await ensureAppSecrets(config.secretsDir);

  const password = config.db.passwordFile
    ? await readSecretFile(config.db.passwordFile)
    : await ensureDbPassword(config.secretsDir, config.db.sharedSecretDir);
  const dbHandle = connectDb({ ...config.db, password });
  // On first boot Postgres starts only once the password above exists, then initialises.
  await waitForDb(dbHandle.sql, 120);
  await runMigrations(dbHandle.db);

  const app = await buildApp({
    db: dbHandle,
    secrets,
    dataDir: config.dataDir,
    webRoot: config.webRoot,
    logger: {
      level: config.logLevel,
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
  });

  const passphrase = await ensureInitialAdmin(dbHandle.db);
  if (passphrase) {
    app.log.info('initial admin account created; one-time passphrase printed to stdout');
    // Printed directly (not via the JSON logger) so it is readable in `docker compose logs`.
    process.stdout.write(
      credentialBanner({
        heading: 'BokyDo initial admin account',
        username: INITIAL_ADMIN_USERNAME,
        passphrase,
      }) + '\n',
    );
  }

  const purge = setInterval(
    () =>
      void Promise.all([
        app.services.sessions.purgeExpired(),
        app.services.flows.purgeExpired(),
      ]).catch((err: unknown) => app.log.warn({ err }, 'expired session/flow purge failed')),
    60 * 60 * 1000,
  );
  purge.unref();
  app.services.jobs.start();

  const shutdown = async (signal: string) => {
    app.log.info({ signal }, 'shutting down');
    await app.close();
    await dbHandle.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
  app.log.info({ version: VERSION }, 'BokyDo started');
}

main().catch((err: unknown) => {
  console.error('BokyDo failed to start:', err);
  process.exit(1);
});
