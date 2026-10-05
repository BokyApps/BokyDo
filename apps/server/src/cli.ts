#!/usr/bin/env node
import { dbPasswordFile, loadConfig } from './config.js';

const USAGE = `Usage:
  bokydo admin reset-password <username>   Issue a new one-time passphrase (forces change at login)
  bokydo admin reset-mfa <username>        Remove a user's two-factor methods (lost phone and codes)
  bokydo admin clear-public-url            Unset the public URL if a wrong value locks browsers out
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

  if (cmd === 'admin' && sub === 'reset-mfa' && arg) {
    const { connectDb } = await import('./db/client.js');
    const { readSecretFile } = await import('./security/secret-files.js');
    const { resetMfaFromCli } = await import('./setup/reset-password.js');
    const config = loadConfig();
    const handle = connectDb({
      ...config.db,
      password: await readSecretFile(dbPasswordFile(config)),
    });
    try {
      if (!(await resetMfaFromCli(handle.db, arg))) {
        console.error(`No user named "${arg}".`);
        return 1;
      }
    } finally {
      await handle.close();
    }
    console.log(
      `Two-factor authentication removed for "${arg}". They can sign in with their password and set it up again.`,
    );
    return 0;
  }

  if (cmd === 'admin' && sub === 'clear-public-url') {
    const { connectDb } = await import('./db/client.js');
    const { readSecretFile } = await import('./security/secret-files.js');
    const { clearPublicUrl } = await import('./setup/clear-public-url.js');
    const config = loadConfig();
    const handle = connectDb({
      ...config.db,
      password: await readSecretFile(dbPasswordFile(config)),
    });
    try {
      await clearPublicUrl(handle.db);
    } finally {
      await handle.close();
    }
    console.log('Public URL cleared. Restart the app to apply: docker compose restart app');
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
      password: await readSecretFile(dbPasswordFile(config)),
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
