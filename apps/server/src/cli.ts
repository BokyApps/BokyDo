#!/usr/bin/env node
import { loadConfig } from './config.js';

const USAGE = `Usage:
  bokydo admin reset-password <username>   Issue a new one-time passphrase (forces change at login)
  bokydo bootstrap                         Generate first-boot secrets (run by the compose init service)
  bokydo healthcheck                       Exit 0 if the local server is healthy`;

async function run(args: string[]): Promise<number> {
  const [cmd, sub, arg] = args;

  if (cmd === 'healthcheck') {
    const { port } = loadConfig();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(3000),
      });
      return res.ok ? 0 : 1;
    } catch {
      return 1;
    }
  }

  if (cmd === 'bootstrap') {
    const { bootstrap } = await import('./bootstrap.js');
    const config = loadConfig();
    await bootstrap({
      dataDir: config.dataDir,
      pgSecretDir: process.env.BOKYDO_PG_SECRET_DIR ?? '/run/bokydo-pg',
      appUid: Number(process.env.BOKYDO_APP_UID ?? 65532),
      pgUid: Number(process.env.BOKYDO_PG_UID ?? 999),
    });
    console.log('bootstrap: secrets ready');
    return 0;
  }

  if (cmd === 'admin' && sub === 'reset-password' && arg) {
    const { connectDb } = await import('./db/client.js');
    const { readSecretFile } = await import('./security/secret-files.js');
    const { resetPasswordFromCli } = await import('./setup/reset-password.js');
    const { credentialBanner } = await import('./setup/initial-admin.js');
    const config = loadConfig();
    const handle = connectDb({
      ...config.db,
      password: await readSecretFile(config.db.passwordFile),
    });
    try {
      const passphrase = await resetPasswordFromCli(handle.db, arg);
      if (!passphrase) {
        console.error(`No user named "${arg}".`);
        return 1;
      }
      console.log(
        credentialBanner({ heading: `Password reset for "${arg}"`, username: arg, passphrase }),
      );
      return 0;
    } finally {
      await handle.close();
    }
  }

  console.error(USAGE);
  return 2;
}

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
