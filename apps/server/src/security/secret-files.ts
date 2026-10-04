import { randomBytes } from 'node:crypto';
import { chmod, chown, link, mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

export interface SecretFileOptions {
  /** Numeric owner to chown to. Only applied when running as root. */
  uid?: number;
  gid?: number;
}

/** Create a directory for secrets with 0700 permissions. */
export async function ensureSecretDir(dir: string, opts: SecretFileOptions = {}): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await maybeChown(dir, opts);
}

/**
 * Atomically write a secret file with 0400 permissions. Never overwrites an existing file and never
 * follows symlinks (O_EXCL), so a pre-planted link cannot redirect the write.
 */
export async function writeSecretFile(
  file: string,
  contents: string | Buffer,
  opts: SecretFileOptions = {},
): Promise<void> {
  const tmp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const handle = await open(tmp, 'wx', 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(tmp, 0o400);
    await maybeChown(tmp, opts);
    // link() fails with EEXIST instead of replacing, so an existing secret is never clobbered.
    await link(tmp, file);
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}

export async function readSecretFile(file: string): Promise<string> {
  return (await readFile(file, 'utf8')).trim();
}

/** Read a secret, generating it with `generate()` first if it does not exist. */
export async function ensureSecretFile(
  file: string,
  generate: () => string,
  opts: SecretFileOptions = {},
): Promise<string> {
  if (!(await exists(file))) {
    try {
      await writeSecretFile(file, generate(), opts);
    } catch (err) {
      // Another process created it concurrently; use theirs.
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
  }
  return readSecretFile(file);
}

export function randomSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function maybeChown(target: string, { uid, gid }: SecretFileOptions): Promise<void> {
  if (uid === undefined || process.getuid?.() !== 0) return;
  await chown(target, uid, gid ?? uid);
}
