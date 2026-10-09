import { eq } from 'drizzle-orm';
import { readMigrationFiles } from 'drizzle-orm/migrator';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { connectDb, MIGRATIONS_DIR } from '../db/client.js';
import { newId } from '../db/ids.js';
import { projects, sessions, tasks, users } from '../db/schema.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { ArchiveWriter, readArchive } from './archive.js';
import { BackupService } from './backup.js';
import { BackupEncryptor, decryptBackup, readHeader } from './crypto-stream.js';

const PASSPHRASE = 'correct horse battery staple';

async function encrypt(plain: Buffer, passphrase = PASSPHRASE): Promise<Buffer> {
  const out = new PassThrough();
  const chunks: Buffer[] = [];
  out.on('data', (c: Buffer) => chunks.push(c));
  const enc = await BackupEncryptor.create(out, passphrase, 'test');
  await enc.write(plain);
  await enc.end();
  return Buffer.concat(chunks);
}

async function decrypt(file: Buffer, passphrase = PASSPHRASE): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of decryptBackup(Readable.from([file]), passphrase)) parts.push(c);
  return Buffer.concat(parts);
}

async function reason(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (err) {
    return (err as Error).constructor.name;
  }
}

describe('backup encryption', () => {
  const plain = Buffer.alloc(200 * 1024 + 123, 7); // several chunks, the last one short

  it('round-trips, and needs the right passphrase', async () => {
    const file = await encrypt(plain);
    expect((await decrypt(file)).equals(plain)).toBe(true);
    expect(await reason(decrypt(file, 'wrong passphrase!!'))).toBe('BackupAuthError');
    expect((await readHeader(Readable.from([file]))).format).toBe('bokydo-backup');
    expect(file.includes(Buffer.from([7, 7, 7, 7, 7, 7, 7, 7]))).toBe(false);
  });

  it('detects tampering, truncation, reordering and appended data', async () => {
    const file = await encrypt(plain);
    const flipped = Buffer.from(file);
    flipped.writeUInt8(flipped.readUInt8(flipped.length - 100) ^ 1, flipped.length - 100);
    expect(await reason(decrypt(flipped))).toBe('BackupAuthError');

    // The header is authenticated too (e.g. a forged date).
    const headerEdit = Buffer.from(
      file.toString('latin1').replace('"app":"test"', '"app":"tesT"'),
      'latin1',
    );
    expect(await reason(decrypt(headerEdit))).toBe('BackupAuthError');

    // Cut at a chunk boundary: every remaining chunk is valid, but the last one is missing.
    const headLen = 8 + 4 + file.readUInt32BE(8);
    const firstChunk = 4 + file.readUInt32BE(headLen);
    expect(await reason(decrypt(file.subarray(0, headLen + firstChunk)))).toBe('BackupFormatError');
    expect(await reason(decrypt(file.subarray(0, file.length - 10)))).toBe('BackupFormatError');

    // Swap the first two chunks.
    const second = 4 + file.readUInt32BE(headLen + firstChunk);
    const swapped = Buffer.concat([
      file.subarray(0, headLen),
      file.subarray(headLen + firstChunk, headLen + firstChunk + second),
      file.subarray(headLen, headLen + firstChunk),
      file.subarray(headLen + firstChunk + second),
    ]);
    expect(await reason(decrypt(swapped))).toBe('BackupAuthError');

    const appended = Buffer.concat([file, file.subarray(headLen, headLen + firstChunk)]);
    expect(await reason(decrypt(appended))).toBe('BackupAuthError');
  });

  it('refuses headers that would exhaust the server or are not backups', async () => {
    const file = await encrypt(Buffer.from('x'));
    const len = file.readUInt32BE(8);
    const header = JSON.parse(file.subarray(12, 12 + len).toString()) as {
      kdf: { memoryKiB: number };
    };
    header.kdf.memoryKiB = 9_999_999; // ~9.5 GB of argon2 memory
    const json = Buffer.from(JSON.stringify(header));
    const prefix = Buffer.alloc(4);
    prefix.writeUInt32BE(json.length);
    const greedy = Buffer.concat([file.subarray(0, 8), prefix, json, file.subarray(12 + len)]);
    expect(await reason(readHeader(Readable.from([greedy])))).toBe('BackupFormatError');
    expect(await reason(decrypt(Buffer.from('PK\u0003\u0004 not a backup')))).toBe(
      'BackupFormatError',
    );
  });

  it('archives entries and notices a cut-off archive', async () => {
    const parts: Buffer[] = [];
    const sink = { write: async (b: Buffer) => void parts.push(b) };
    const w = new ArchiveWriter(sink);
    await w.entry('a.txt', 'hello');
    await w.entry('big', Readable.from([Buffer.alloc(3 * 1024 * 1024, 1)]));
    await w.end();
    const all = Buffer.concat(parts);
    const seen: Record<string, number> = {};
    for await (const e of readArchive(Readable.from([all]))) {
      let n = 0;
      for await (const c of e.data) n += c.length;
      seen[e.name] = n;
    }
    expect(seen).toEqual({ 'a.txt': 5, big: 3 * 1024 * 1024 });
    const cut = async () => {
      for await (const e of readArchive(Readable.from([all.subarray(0, all.length - 1)])))
        for await (const _ of e.data) void _;
    };
    expect(await reason(cut())).toBe('BackupFormatError');
  });
});

// Argon2 key derivation and whole-schema restores take a few seconds each.
describe.skipIf(!TEST_DATABASE_URL)('backups and restore', { timeout: 60_000 }, () => {
  let t: TestApp;
  let admin: { id: string; http: Client; sync: SyncUser };

  beforeEach(async () => {
    t = await testApp();
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    const userId = await createUser(t.db, {
      username: 'root',
      password: 'violin-pancake-orbit-meadow',
      isAdmin: true,
    });
    const http = new Client(t.app);
    await http.login('root', 'violin-pancake-orbit-meadow');
    admin = { id: userId, http, sync: new SyncUser(t.app.services.sync, userId) };
  });
  afterEach(async () => t.close());

  it('needs a passphrase before backing up', async () => {
    expect((await admin.http.post('/api/v1/admin/backups')).json().message).toBe(
      'passphrase_not_set',
    );
  });

  it('restores data, files and keys exactly as they were, and signs everyone out', async () => {
    await t.app.services.settings.update(
      { 'backups.passphrase': PASSPHRASE },
      { userId: null, ip: null },
    );
    const project = id();
    await admin.sync.ok(
      cmd('project_add', { id: project, name: 'Before' }),
      cmd('task_add', { id: id(), projectId: project, content: 'kept task' }),
    );
    const attachment = newId();
    await writeFile(path.join(t.dataDir, 'attachments', attachment), 'file body').catch(
      async () => {
        await import('node:fs/promises').then((fs) =>
          fs.mkdir(path.join(t.dataDir, 'attachments'), { recursive: true }),
        );
        await writeFile(path.join(t.dataDir, 'attachments', attachment), 'file body');
      },
    );
    const masterBefore = await readFile(path.join(t.dataDir, 'master.key'), 'utf8');

    const created = await admin.http.post('/api/v1/admin/backups');
    expect(created.statusCode).toBe(201);
    const name = created.json().name as string;
    expect(name).toMatch(/^bokydo-.*\.bkdo$/);
    const raw = await readFile(path.join(t.dataDir, 'backups', name));
    for (const leak of ['kept task', masterBefore.trim(), 'file body'])
      expect(raw.includes(Buffer.from(leak)), leak).toBe(false);

    // Things change after the backup.
    await admin.sync.ok(
      cmd('project_delete', { id: project }),
      cmd('project_add', { id: id(), name: 'After' }),
    );
    await import('node:fs/promises').then((fs) =>
      fs.rm(path.join(t.dataDir, 'attachments', attachment)),
    );
    await chmod(path.join(t.dataDir, 'master.key'), 0o600);
    await writeFile(path.join(t.dataDir, 'master.key'), 'changed-after-backup');

    // Wrong passphrase: refused, nothing touched.
    const wrong = await admin.http.post(`/api/v1/admin/backups/${name}/restore`, {
      passphrase: 'not the passphrase',
      confirm: 'RESTORE',
    });
    expect(wrong.json().error).toBe('backup_passphrase_or_damaged');
    expect((await t.db.db.select().from(projects).where(eq(projects.name, 'After'))).length).toBe(
      1,
    );

    const res = await admin.http.post(`/api/v1/admin/backups/${name}/restore`, {
      passphrase: PASSPHRASE,
      confirm: 'RESTORE',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().preRestore).toMatch(/^pre-restore-/);

    const names = (await t.db.db.select({ name: projects.name }).from(projects)).map((p) => p.name);
    expect(names).toContain('Before');
    expect(names).not.toContain('After');
    expect((await t.db.db.select().from(tasks).where(eq(tasks.content, 'kept task'))).length).toBe(
      1,
    );
    expect(await t.db.db.select().from(sessions)).toEqual([]);
    expect((await t.db.db.select().from(users)).map((u) => u.username)).toEqual(['root']);
    expect(await readFile(path.join(t.dataDir, 'attachments', attachment), 'utf8')).toBe(
      'file body',
    );
    expect(await readFile(path.join(t.dataDir, 'master.key'), 'utf8')).toBe(masterBefore.trim());
    expect((await readdir(t.dataDir)).some((f) => f.startsWith('master.key.pre-restore-'))).toBe(
      true,
    );
    // The restored database still accepts writes (sequences continued) and is at this version.
    await t.app.services.sync.sync(admin.id, { cursor: null, commands: [] });
    const [{ n }] = (await t.db
      .sql`select count(*)::int as n from drizzle.__drizzle_migrations`) as unknown as [
      { n: number },
    ];
    expect(n).toBe(readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR }).length);
  });

  it('refuses a backup from a different schema lineage, without touching anything', async () => {
    const service = t.app.services.backups;
    const name = await (async () => {
      // A backup whose manifest claims a migration this server never had.
      const file = path.join(service.dir, 'uploaded-2026-01-01T00-00-00Z.bkdo');
      await import('node:fs/promises').then((fs) => fs.mkdir(service.dir, { recursive: true }));
      const out = createWriteStream(file);
      const enc = await BackupEncryptor.create(out, PASSPHRASE, 'other');
      const w = new ArchiveWriter(enc);
      await w.entry(
        'manifest.json',
        JSON.stringify({
          format: 'bokydo-backup-manifest',
          app: 'x',
          createdAt: 'x',
          migrations: ['deadbeef'],
          tables: [],
        }),
      );
      await w.end();
      await enc.end();
      return path.basename(file);
    })();
    const res = await admin.http.post(`/api/v1/admin/backups/${name}/restore`, {
      passphrase: PASSPHRASE,
      confirm: 'RESTORE',
    });
    expect(res.json().error).toBe('backup_incompatible');
    expect((await t.db.db.select().from(users)).length).toBe(1);
  });

  it('restores a backup from an older schema and upgrades it', async () => {
    // A database one migration behind, with some data, backed up by its own server.
    const oldDb = 'bokydo_backup_old';
    const admin2 = postgres(TEST_DATABASE_URL ?? '', { max: 1, onnotice: () => undefined });
    await admin2.unsafe(`drop database if exists ${oldDb}`);
    await admin2.unsafe(`create database ${oldDb}`);
    const url = new URL(TEST_DATABASE_URL ?? '');
    url.pathname = `/${oldDb}`;
    const old = connectDb(url.toString());
    try {
      const all = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });
      await old.sql.unsafe(
        'create schema drizzle; create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)',
      );
      for (const m of all.slice(0, -1)) {
        // nosemgrep: semgrep.bokydo-no-dynamic-raw-sql -- the repository's own migration files
        for (const s of m.sql) if (s.trim()) await old.sql.unsafe(s);
        await old.sql`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`;
      }
      const uid = newId();
      // Raw SQL: the current schema may have columns the older one doesn't.
      await old.sql`insert into users (id, username, password_hash) values (${uid}, 'oldtimer', 'x')`;
      const oldService = new BackupService({
        sql: old.sql,
        dataDir: t.dataDir,
        secretsDir: t.dataDir,
      });
      const info = await oldService.create(PASSPHRASE);
      const res = await admin.http.post(`/api/v1/admin/backups/${info.name}/restore`, {
        passphrase: PASSPHRASE,
        confirm: 'RESTORE',
      });
      expect(res.statusCode).toBe(200);
      expect((await t.db.db.select({ u: users.username }).from(users)).map((r) => r.u)).toEqual([
        'oldtimer',
      ]);
      const [{ n }] = (await t.db
        .sql`select count(*)::int as n from drizzle.__drizzle_migrations`) as unknown as [
        { n: number },
      ];
      expect(n).toBe(all.length);
    } finally {
      await old.close();
      await admin2.unsafe(`drop database if exists ${oldDb} with (force)`);
      await admin2.end();
    }
  });

  it('downloads, uploads and deletes with a recent sign-in, and prunes old backups', async () => {
    await t.app.services.settings.update(
      { 'backups.passphrase': PASSPHRASE },
      { userId: null, ip: null },
    );
    const name = (await admin.http.post('/api/v1/admin/backups')).json().name as string;
    const download = await admin.http.request({
      method: 'GET',
      url: `/api/v1/admin/backups/${name}`,
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-disposition']).toBe(`attachment; filename="${name}"`);
    const upload = await admin.http.request({
      method: 'POST',
      url: '/api/v1/admin/backups/upload',
      headers: { 'content-type': 'application/octet-stream' },
      payload: download.rawPayload,
    });
    expect(upload.statusCode).toBe(201);
    expect(upload.json().name).toMatch(/^uploaded-/);
    const junk = await admin.http.request({
      method: 'POST',
      url: '/api/v1/admin/backups/upload',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.from('not a backup at all'),
    });
    expect(junk.json().error).toBe('backup_invalid');
    expect(
      (await admin.http.request({ method: 'GET', url: '/api/v1/admin/backups/..%2Fmaster.key' }))
        .statusCode,
    ).toBe(404);

    await t.db.db.execute(`update sessions set reauthenticated_at = now() - interval '1 hour'`);
    expect(
      (await admin.http.request({ method: 'GET', url: `/api/v1/admin/backups/${name}` })).json()
        .error,
    ).toBe('reauth_required');
    expect(
      (
        await admin.http.post(`/api/v1/admin/backups/${name}/restore`, {
          passphrase: PASSPHRASE,
          confirm: 'RESTORE',
        })
      ).json().error,
    ).toBe('reauth_required');

    for (let i = 0; i < 3; i++) await t.app.services.backups.create(PASSPHRASE);
    await t.app.services.backups.prune(2);
    const left = await t.app.services.backups.list();
    expect(left.filter((b) => b.kind === 'backup')).toHaveLength(2);
    expect(left.filter((b) => b.kind === 'uploaded')).toHaveLength(1);
    void createReadStream;
  });
});
