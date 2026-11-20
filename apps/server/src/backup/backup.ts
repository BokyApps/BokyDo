import { readMigrationFiles } from 'drizzle-orm/migrator';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Sql } from 'postgres';
import { MIGRATIONS_DIR } from '../db/client.js';
import { readSecretFile, writeSecretFile } from '../security/secret-files.js';
import { VERSION } from '../version.js';
import { ArchiveWriter, readArchive } from './archive.js';
import { BackupEncryptor, BackupFormatError, decryptBackup, readHeader } from './crypto-stream.js';

/**
 * Tables left out of backups: sign-in state. After a restore everyone signs in again and API
 * tokens and app authorizations must be made again; restoring can't resurrect a session or token
 * revoked since the backup, and clients start from a clean full sync.
 */
export const EXCLUDED_TABLES = new Set([
  'sessions',
  'auth_flows',
  'oauth_requests',
  'oauth_codes',
  'oauth_grants',
  'api_tokens',
  'push_subscriptions',
]);
const SECRET_FILES = ['master.key', 'session.key', 'vapid.key'];
const NAME = /^(bokydo|pre-restore|uploaded)-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ(-\d{1,3})?\.bkdo$/;

export interface BackupInfo {
  name: string;
  kind: 'backup' | 'pre-restore' | 'uploaded';
  size: number;
  createdAt: string | null;
  app: string | null;
}

interface Manifest {
  format: 'bokydo-backup-manifest';
  app: string;
  createdAt: string;
  migrations: string[];
  tables: string[];
}

export class BackupError extends Error {
  constructor(readonly code: 'not_found' | 'incompatible' | 'invalid' | 'busy') {
    super(code);
  }
}

export interface BackupServiceDeps {
  sql: Sql;
  dataDir: string;
  secretsDir: string;
  /**
   * Test seam: runs after the database snapshot (which fixed the set of files to archive) and
   * before those files are read, so a test can remove bytes the snapshot still expects.
   */
  afterSnapshot?: () => Promise<void>;
  /**
   * A file whose row still exists but whose bytes are gone: lost before this backup, so a retry
   * cannot help. The backup carries on without it (as restore would), and this reports it.
   */
  onMissingFile?: (kind: 'attachments' | 'note-files', id: string) => void;
}

/**
 * Encrypted, self-contained instance backups (ADR 0013): the database (consistent snapshot via
 * COPY), the instance keys and the attachment files, under a passphrase-derived key. Stored in
 * `<data>/backups` (0600) and downloadable for off-site copies. Restoring replaces everything in
 * one database transaction, after a full authenticated pass over the file and an automatic
 * backup of the current state.
 */
export class BackupService {
  readonly dir: string;
  private busy = false;

  constructor(private readonly deps: BackupServiceDeps) {
    this.dir = path.join(deps.dataDir, 'backups');
  }

  path(name: string): string {
    if (!NAME.test(name)) throw new BackupError('not_found');
    return path.join(this.dir, name);
  }

  private async fresh(prefix: 'bokydo' | 'pre-restore' | 'uploaded'): Promise<string> {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    const stamp = new Date()
      .toISOString()
      .replace(/\.\d{3}Z$/, 'Z')
      .replace(/:/g, '-');
    for (let i = 0; i < 100; i++) {
      const name = `${prefix}-${stamp}${i ? `-${i}` : ''}.bkdo`;
      try {
        await stat(path.join(this.dir, name));
      } catch {
        return name;
      }
    }
    throw new BackupError('busy');
  }

  async list(): Promise<BackupInfo[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const out: BackupInfo[] = [];
    for (const name of names
      .filter((n) => NAME.test(n))
      .sort()
      .reverse()) {
      const file = path.join(this.dir, name);
      const info = await stat(file);
      let header: { createdAt: string; app: string } | null = null;
      try {
        header = await readHeader(createReadStream(file, { end: 32 * 1024 }));
      } catch {
        // listed anyway, so a damaged file can be seen and deleted
      }
      out.push({
        name,
        kind: name.startsWith('pre-restore')
          ? 'pre-restore'
          : name.startsWith('uploaded')
            ? 'uploaded'
            : 'backup',
        size: info.size,
        createdAt: header?.createdAt ?? null,
        app: header?.app ?? null,
      });
    }
    return out;
  }

  async remove(name: string): Promise<void> {
    try {
      await unlink(this.path(name));
    } catch (err) {
      if (err instanceof BackupError) throw err;
      throw new BackupError('not_found');
    }
  }

  /** Keep the newest `keep` regular backups; drop pre-restore and uploaded files after 30 days. */
  async prune(keep: number, now = Date.now()): Promise<void> {
    const all = await this.list();
    const regular = all.filter((b) => b.kind === 'backup');
    for (const b of regular.slice(keep)) await this.remove(b.name);
    for (const b of all.filter((x) => x.kind !== 'backup')) {
      const at = b.createdAt ? Date.parse(b.createdAt) : 0;
      if (now - at > 30 * 86_400_000) await this.remove(b.name);
    }
  }

  async create(passphrase: string, kind: 'backup' | 'pre-restore' = 'backup'): Promise<BackupInfo> {
    const name = await this.fresh(kind === 'backup' ? 'bokydo' : 'pre-restore');
    const final = path.join(this.dir, name);
    const part = `${final}.part`;
    const out = createWriteStream(part, { mode: 0o600, flags: 'wx' });
    try {
      const enc = await BackupEncryptor.create(out, passphrase, VERSION);
      const archive = new ArchiveWriter(enc);
      /**
       * The files to archive, taken from the same snapshot as the tables they belong to. Walking
       * the directories instead would silently drop a file whose row the snapshot holds but whose
       * bytes a purge removed in the meantime — and add bytes no row ever claimed.
       */
      let attachmentIds: string[] = [];
      let noteFileIds: string[] = [];
      // One read-only snapshot: every table as of the same moment.
      await this.deps.sql.begin('isolation level repeatable read read only', async (tx) => {
        const migrations = await tx<{ hash: string }[]>`
          select hash from drizzle.__drizzle_migrations order by created_at, id`;
        const tables = (
          await tx<{ name: string }[]>`
            select table_name as name from information_schema.tables
            where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`
        )
          .map((t) => t.name)
          .filter((t) => !EXCLUDED_TABLES.has(t));
        // Older schemas may predate either table; then their directory has nothing to archive.
        if (tables.includes('attachments'))
          attachmentIds = (
            await tx<{ id: string }[]>`
              select id from attachments where deleted_at is null order by id`
          ).map((row) => row.id);
        if (tables.includes('note_files'))
          noteFileIds = (
            await tx<{ id: string }[]>`
              select id from note_files where status = 'ready' order by id`
          ).map((row) => row.id);
        const manifest: Manifest = {
          format: 'bokydo-backup-manifest',
          app: VERSION,
          createdAt: new Date().toISOString(),
          migrations: migrations.map((m) => m.hash),
          tables,
        };
        await archive.entry('manifest.json', JSON.stringify(manifest));
        for (const t of tables) {
          const readable = await tx`copy ${tx(t)} to stdout`.readable();
          await archive.entry(`db/${t}`, readable as AsyncIterable<Buffer>);
        }
      });
      await this.deps.afterSnapshot?.();
      for (const f of SECRET_FILES) {
        await archive.entry(
          `secrets/${f}`,
          await readSecretFile(path.join(this.deps.secretsDir, f)),
        );
      }
      // Note files live beside attachments but in their own directory; restore puts each back
      // into its own staging directory.
      await this.archiveFiles(
        archive,
        path.join(this.deps.dataDir, 'attachments'),
        'attachments',
        attachmentIds,
      );
      await this.archiveFiles(
        archive,
        path.join(this.deps.dataDir, 'note-files'),
        'note-files',
        noteFileIds,
      );
      await archive.end();
      await enc.end();
      await rename(part, final);
    } catch (err) {
      out.destroy();
      await rm(part, { force: true });
      throw err;
    }
    const info = (await this.list()).find((b) => b.name === name);
    if (!info) throw new Error('backup vanished');
    return info;
  }

  /**
   * Archive exactly `ids` from `dir` as `<prefix>/<id>`; the list comes from the database
   * snapshot. Each file is opened before its entry starts. A missing file whose row is gone now
   * was purged after the snapshot, so the backup fails as `busy` and a retry sees a consistent
   * state. A missing file whose row still exists was lost earlier: nothing a retry fixes, so it
   * is reported and skipped rather than blocking every future backup (and every restore, which
   * takes one first). Any other read error fails the backup.
   */
  private async archiveFiles(
    archive: ArchiveWriter,
    dir: string,
    prefix: 'attachments' | 'note-files',
    ids: readonly string[],
  ): Promise<void> {
    for (const id of ids) {
      if (!/^[0-9a-f-]{36}$/.test(id)) throw new BackupError('invalid');
      let handle;
      try {
        handle = await open(path.join(dir, id), 'r');
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw new BackupError('busy');
        if (!(await this.rowStillLive(prefix, id))) throw new BackupError('busy');
        this.deps.onMissingFile?.(prefix, id);
        continue;
      }
      const stream = handle.createReadStream();
      // Only read errors become `busy`; a failure of the archive or encryption layer is not
      // disguised as a transient one.
      const guarded = (async function* (): AsyncGenerator<Buffer> {
        try {
          for await (const chunk of stream) yield chunk as Buffer;
        } catch {
          throw new BackupError('busy');
        }
      })();
      try {
        await archive.entry(`${prefix}/${id}`, guarded);
      } finally {
        await handle.close().catch(() => undefined);
      }
    }
  }

  /** Whether the row that named a file in the snapshot still names it now. */
  private async rowStillLive(prefix: 'attachments' | 'note-files', id: string): Promise<boolean> {
    const sql = this.deps.sql;
    const rows =
      prefix === 'attachments'
        ? await sql`select 1 from attachments where id = ${id} and deleted_at is null`
        : await sql`select 1 from note_files where id = ${id} and status = 'ready'`;
    return rows.length > 0;
  }

  /** Store an uploaded backup file (checked to look like one) so it can be restored by name. */
  async saveUpload(body: Readable): Promise<BackupInfo> {
    const name = await this.fresh('uploaded');
    const final = path.join(this.dir, name);
    const part = `${final}.part`;
    try {
      await pipeline(body, createWriteStream(part, { mode: 0o600, flags: 'wx' }));
      await readHeader(createReadStream(part, { end: 32 * 1024 }));
      await rename(part, final);
    } catch (err) {
      await rm(part, { force: true });
      throw err instanceof BackupFormatError ? new BackupError('invalid') : err;
    }
    const info = (await this.list()).find((b) => b.name === name);
    if (!info) throw new Error('upload vanished');
    return info;
  }

  /**
   * Replace this instance's data with a backup. Order matters:
   *  1. decrypt and parse the whole file once, discarding the data: wrong passphrase, tampering,
   *     truncation and an incompatible schema are all caught before anything changes;
   *  2. back up the current state (same passphrase) to `pre-restore-…`;
   *  3. in one database transaction: recreate the schema at the backup's version, load every
   *     table, check all foreign keys, then apply the newer migrations of this server; the
   *     attachments go to a staging directory meanwhile;
   *  4. after commit, swap in the attachments and the instance keys (old ones kept aside).
   * The caller then restarts the process so every cache and key is reloaded.
   */
  async restore(name: string, passphrase: string): Promise<{ preRestore: string }> {
    if (this.busy) throw new BackupError('busy');
    this.busy = true;
    try {
      const file = this.path(name);
      try {
        await stat(file);
      } catch {
        throw new BackupError('not_found');
      }
      const local = readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR });

      // 1. Verify.
      let manifest: Manifest | null = null;
      for await (const entry of readArchive(decryptBackup(createReadStream(file), passphrase))) {
        if (!manifest) {
          if (entry.name !== 'manifest.json') throw new BackupError('invalid');
          manifest = await this.readManifest(entry.data);
          this.checkCompatible(manifest, local);
        }
      }
      if (!manifest) throw new BackupError('invalid');
      const backupVersion = manifest.migrations.length;

      // 2. Safety copy of what is about to be replaced.
      const pre = await this.create(passphrase, 'pre-restore');

      // 3. Restore.
      const staging = path.join(this.deps.dataDir, `attachments.restore-${Date.now()}`);
      const noteStaging = path.join(this.deps.dataDir, `note-files.restore-${Date.now()}`);
      await mkdir(staging, { recursive: true, mode: 0o700 });
      await mkdir(noteStaging, { recursive: true, mode: 0o700 });
      const secrets = new Map<string, string>();
      try {
        await this.deps.sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(hashtext('bokydo:sync-write'))`;
          await tx.unsafe('drop schema if exists drizzle cascade');
          await tx.unsafe('drop schema public cascade');
          await tx.unsafe('create schema public');
          await tx.unsafe('create schema drizzle');
          await tx.unsafe(
            'create table drizzle.__drizzle_migrations (id serial primary key, hash text not null, created_at bigint)',
          );
          const apply = async (from: number, to: number) => {
            for (const m of local.slice(from, to)) {
              // nosemgrep: semgrep.bokydo-no-dynamic-raw-sql -- this server's own migration files, as drizzle's migrator runs them
              for (const stmt of m.sql) if (stmt.trim()) await tx.unsafe(stmt);
              await tx`insert into drizzle.__drizzle_migrations (hash, created_at) values (${m.hash}, ${m.folderMillis})`;
            }
          };
          await apply(0, backupVersion);
          // Rows are loaded table by table, in file order: check foreign keys at the end.
          const fks = await tx<{ t: string; c: string }[]>`
            select cl.relname as t, con.conname as c from pg_constraint con
            join pg_class cl on cl.oid = con.conrelid
            where con.contype = 'f' and con.connamespace = 'public'::regnamespace`;
          for (const fk of fks)
            await tx`alter table ${tx(fk.t)} alter constraint ${tx(fk.c)} deferrable initially deferred`;
          const known = new Set(
            (
              await tx<{ name: string }[]>`
                select table_name as name from information_schema.tables
                where table_schema = 'public' and table_type = 'BASE TABLE'`
            ).map((r) => r.name),
          );
          let first = true;
          for await (const entry of readArchive(
            decryptBackup(createReadStream(file), passphrase),
          )) {
            if (first) {
              first = false;
              const again = await this.readManifest(entry.data);
              if (JSON.stringify(again) !== JSON.stringify(manifest))
                throw new BackupError('invalid');
              continue;
            }
            if (entry.name.startsWith('db/')) {
              const table = entry.name.slice(3);
              if (!known.has(table) || EXCLUDED_TABLES.has(table)) throw new BackupError('invalid');
              const writable = await tx`copy ${tx(table)} from stdin`.writable();
              await pipeline(entry.data, writable);
            } else if (entry.name.startsWith('secrets/')) {
              const f = entry.name.slice(8);
              if (!SECRET_FILES.includes(f)) throw new BackupError('invalid');
              const chunks: Buffer[] = [];
              for await (const c of entry.data) chunks.push(c);
              secrets.set(f, Buffer.concat(chunks).toString('utf8').trim());
            } else if (entry.name.startsWith('attachments/')) {
              const f = entry.name.slice(12);
              if (!/^[0-9a-f-]{36}$/.test(f)) throw new BackupError('invalid');
              await pipeline(
                entry.data,
                createWriteStream(path.join(staging, f), { mode: 0o600, flags: 'wx' }),
              );
            } else if (entry.name.startsWith('note-files/')) {
              const f = entry.name.slice(11);
              if (!/^[0-9a-f-]{36}$/.test(f)) throw new BackupError('invalid');
              await pipeline(
                entry.data,
                createWriteStream(path.join(noteStaging, f), { mode: 0o600, flags: 'wx' }),
              );
            } else {
              throw new BackupError('invalid');
            }
          }
          if (SECRET_FILES.some((f) => !/^[A-Za-z0-9_-]{43}$/.test(secrets.get(f) ?? '')))
            throw new BackupError('invalid');
          await tx.unsafe('set constraints all immediate');
          for (const fk of fks)
            await tx`alter table ${tx(fk.t)} alter constraint ${tx(fk.c)} not deferrable`;
          // Serial columns continue after the restored rows.
          const serials = await tx<{ t: string; c: string; s: string }[]>`
            select table_name as t, column_name as c, pg_get_serial_sequence(quote_ident(table_name), column_name) as s
            from information_schema.columns
            where table_schema = 'public' and column_default like 'nextval(%'`;
          for (const s of serials)
            await tx`select setval(${s.s}::regclass, coalesce((select max(${tx(s.c)}) from ${tx(s.t)}), 0) + 1, false)`;
          // Bring the data up to this server's schema.
          await apply(backupVersion, local.length);
        });
      } catch (err) {
        await rm(staging, { recursive: true, force: true });
        await rm(noteStaging, { recursive: true, force: true });
        throw err;
      }

      // 4. Files and keys (the database already matches them).
      const stamp = Date.now();
      const attachments = path.join(this.deps.dataDir, 'attachments');
      const noteFiles = path.join(this.deps.dataDir, 'note-files');
      await rename(attachments, `${attachments}.pre-restore-${stamp}`).catch(() => undefined);
      await rename(staging, attachments);
      await rename(noteFiles, `${noteFiles}.pre-restore-${stamp}`).catch(() => undefined);
      await rename(noteStaging, noteFiles);
      for (const [f, value] of secrets) {
        const target = path.join(this.deps.secretsDir, f);
        await rename(target, `${target}.pre-restore-${stamp}`).catch(() => undefined);
        await writeSecretFile(target, value);
      }
      return { preRestore: pre.name };
    } finally {
      this.busy = false;
    }
  }

  private async readManifest(data: AsyncIterable<Buffer>): Promise<Manifest> {
    const chunks: Buffer[] = [];
    for await (const c of data) chunks.push(c);
    let m: Manifest;
    try {
      m = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Manifest;
    } catch {
      throw new BackupError('invalid');
    }
    if (
      m.format !== 'bokydo-backup-manifest' ||
      !Array.isArray(m.migrations) ||
      !Array.isArray(m.tables)
    )
      throw new BackupError('invalid');
    return m;
  }

  /** The backup's migrations must be exactly the first N of this server's (same lineage, not newer). */
  private checkCompatible(m: Manifest, local: { hash: string }[]): void {
    if (m.migrations.length === 0 || m.migrations.length > local.length)
      throw new BackupError('incompatible');
    m.migrations.forEach((h, i) => {
      if (local[i]?.hash !== h) throw new BackupError('incompatible');
    });
  }
}
