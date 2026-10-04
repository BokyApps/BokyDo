import { lstat, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { bootstrap } from '../bootstrap.js';
import { ensureAppSecrets } from './app-secrets.js';
import { ensureSecretDir, ensureSecretFile, writeSecretFile } from './secret-files.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'bokydo-secrets-'));
});

const mode = async (p: string) => (await lstat(p)).mode & 0o777;

describe('secret files', () => {
  it('writes 0400 files inside 0700 dirs', async () => {
    const secrets = path.join(dir, 'secrets');
    await ensureAppSecrets(secrets);
    expect(await mode(secrets)).toBe(0o700);
    expect(await mode(path.join(secrets, 'master.key'))).toBe(0o400);
    expect(await mode(path.join(secrets, 'session.key'))).toBe(0o400);
  });

  it('is idempotent and never regenerates keys', async () => {
    const secrets = path.join(dir, 'secrets');
    const a = await ensureAppSecrets(secrets);
    const b = await ensureAppSecrets(secrets);
    expect(a.masterKey.equals(b.masterKey)).toBe(true);
    expect(a.masterKey).toHaveLength(32);
  });

  it('refuses to overwrite an existing secret', async () => {
    const file = path.join(dir, 's');
    await writeSecretFile(file, 'one');
    await expect(writeSecretFile(file, 'two')).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(file, 'utf8')).toBe('one');
  });

  it('does not follow a planted symlink', async () => {
    const victim = path.join(dir, 'victim');
    await writeFile(victim, 'original');
    const file = path.join(dir, 'secret');
    await symlink(victim, file);
    await expect(writeSecretFile(file, 'attacker-controlled')).rejects.toMatchObject({
      code: 'EEXIST',
    });
    expect(await readFile(victim, 'utf8')).toBe('original');
  });

  it('survives concurrent first-boot generation', async () => {
    const file = path.join(dir, 'race');
    let n = 0;
    const values = await Promise.all(
      Array.from({ length: 10 }, () => ensureSecretFile(file, () => `v${n++}`)),
    );
    expect(new Set(values).size).toBe(1);
  });

  it('rejects a corrupt master key', async () => {
    const secrets = path.join(dir, 'secrets');
    await ensureSecretDir(secrets);
    await writeSecretFile(path.join(secrets, 'master.key'), 'short');
    await expect(ensureAppSecrets(secrets)).rejects.toThrow(/corrupt/);
  });
});

describe('bootstrap', () => {
  const opts = () => ({
    dataDir: path.join(dir, 'data'),
    pgSecretDir: path.join(dir, 'pg'),
    appUid: 65532,
    pgUid: 999,
  });

  it('gives app and postgres matching copies of a strong DB password', async () => {
    await bootstrap(opts());
    const app = await readFile(path.join(dir, 'data/secrets/db_password'), 'utf8');
    const pg = await readFile(path.join(dir, 'pg/password'), 'utf8');
    expect(app).toBe(pg);
    expect(Buffer.from(app, 'base64url')).toHaveLength(32);
    expect(await mode(path.join(dir, 'pg/password'))).toBe(0o400);
  });

  it('is idempotent', async () => {
    await bootstrap(opts());
    const before = await readFile(path.join(dir, 'pg/password'), 'utf8');
    await bootstrap(opts());
    expect(await readFile(path.join(dir, 'pg/password'), 'utf8')).toBe(before);
  });

  it('re-adopts the postgres password when the app volume is recreated', async () => {
    await bootstrap(opts());
    const pg = await readFile(path.join(dir, 'pg/password'), 'utf8');
    await bootstrap({ ...opts(), dataDir: path.join(dir, 'fresh-data') });
    expect(await readFile(path.join(dir, 'fresh-data/secrets/db_password'), 'utf8')).toBe(pg);
  });
});
