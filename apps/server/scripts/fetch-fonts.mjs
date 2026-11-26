#!/usr/bin/env node
/**
 * Fetch the pinned Noto fonts that the PDF exporter embeds.
 *
 * `apps/server/fonts.lock.json` is the source of truth: one record per file with the official
 * Noto release URL, the release archive's SHA-256, the entry inside that archive and the
 * extracted file's SHA-256. Fonts are never committed, and nothing is installed until both the
 * archive and the extracted bytes match the lock. Downloads and extraction happen in a fresh
 * temporary directory; an existing file is reused only when its hash already matches.
 *
 *   pnpm --filter @bokydo/server fonts:fetch
 *   node apps/server/scripts/fetch-fonts.mjs --dir /app/fonts
 *
 * Only Node built-ins are used, so this also runs in the Docker build stage before `pnpm build`.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_DIR = path.dirname(HERE);

function usage(message) {
  if (message) console.error(message);
  console.error(
    'usage: node apps/server/scripts/fetch-fonts.mjs [--dir <font dir>] [--lock <lock file>]',
  );
  process.exit(2);
}

let fontDir = path.join(SERVER_DIR, 'fonts');
let lockFile = path.join(SERVER_DIR, 'fonts.lock.json');
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === '--dir') fontDir = path.resolve(args[++index] ?? usage('--dir needs a value'));
  else if (arg === '--lock')
    lockFile = path.resolve(args[++index] ?? usage('--lock needs a value'));
  else if (arg === '--help' || arg === '-h') usage();
  else usage(`unknown argument: ${arg}`);
}

const lock = JSON.parse(await readFile(lockFile, 'utf8'));
if (!Array.isArray(lock.fonts) || lock.fonts.length === 0)
  throw new Error(`${lockFile} has no fonts`);

const SHA256 = /^[0-9a-f]{64}$/u;
for (const entry of lock.fonts) {
  for (const field of ['file', 'url', 'archiveSha256', 'archiveEntry', 'sha256', 'licence']) {
    if (typeof entry[field] !== 'string' || entry[field] === '')
      throw new Error(`${lockFile}: ${entry.file ?? '(font)'} is missing ${field}`);
  }
  if (!SHA256.test(entry.sha256) || !SHA256.test(entry.archiveSha256))
    throw new Error(`${lockFile}: ${entry.file} has a malformed SHA-256`);
}

async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function matches(file, expected) {
  try {
    if ((await stat(file)).size === 0) return false;
    return (await sha256File(file)) === expected;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function download(url, target) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60 * 1000) });
      if (!response.ok || !response.body)
        throw new Error(`${response.status} ${response.statusText} for ${url}`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(target));
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

/** Read exactly `length` bytes at `position`; `FileHandle.read` may return short reads. */
async function readExactly(handle, length, position) {
  const buffer = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(buffer, read, length - read, position + read);
    if (bytesRead === 0) throw new Error('unexpected end of ZIP file');
    read += bytesRead;
  }
  return buffer;
}

/**
 * Minimal central-directory ZIP reader for the release archives: stored and deflated entries,
 * no ZIP64. Only the requested entries are read and inflated.
 */
async function readZipEntries(file, wanted) {
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    const tailSize = Math.min(size, 22 + 0xffff);
    const tail = await readExactly(handle, tailSize, size - tailSize);
    let eocd = -1;
    for (let offset = tail.length - 22; offset >= 0; offset--) {
      if (tail.readUInt32LE(offset) === 0x06054b50) {
        eocd = offset;
        break;
      }
    }
    if (eocd === -1) throw new Error(`${file}: not a ZIP file`);
    const count = tail.readUInt16LE(eocd + 10);
    const directorySize = tail.readUInt32LE(eocd + 12);
    const directoryOffset = tail.readUInt32LE(eocd + 16);
    if (directoryOffset + directorySize > size)
      throw new Error(`${file}: corrupt central directory`);
    const directory = await readExactly(handle, directorySize, directoryOffset);
    const found = new Map();
    let at = 0;
    for (let index = 0; index < count; index++) {
      if (directory.readUInt32LE(at) !== 0x02014b50)
        throw new Error(`${file}: corrupt central directory entry`);
      const method = directory.readUInt16LE(at + 10);
      const compressedSize = directory.readUInt32LE(at + 20);
      const uncompressedSize = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      const localOffset = directory.readUInt32LE(at + 42);
      const name = directory.toString('utf8', at + 46, at + 46 + nameLength);
      if (wanted.has(name))
        found.set(name, { method, compressedSize, uncompressedSize, localOffset });
      at += 46 + nameLength + extraLength + commentLength;
    }
    const entries = new Map();
    for (const name of wanted) {
      const entry = found.get(name);
      if (!entry) throw new Error(`${file}: no entry named ${name}`);
      if (entry.localOffset === 0xffffffff || entry.compressedSize === 0xffffffff)
        throw new Error(`${file}: ZIP64 entries are not supported`);
      const header = await readExactly(handle, 30, entry.localOffset);
      if (header.readUInt32LE(0) !== 0x04034b50)
        throw new Error(`${file}: corrupt local header for ${name}`);
      const nameLength = header.readUInt16LE(26);
      const extraLength = header.readUInt16LE(28);
      const dataOffset = entry.localOffset + 30 + nameLength + extraLength;
      const compressed = await readExactly(handle, entry.compressedSize, dataOffset);
      const data =
        entry.method === 0
          ? compressed
          : entry.method === 8
            ? inflateRawSync(compressed)
            : undefined;
      if (data === undefined) throw new Error(`${file}: unsupported compression for ${name}`);
      if (data.length !== entry.uncompressedSize)
        throw new Error(`${file}: ${name} did not inflate to its declared size`);
      entries.set(name, data);
    }
    return entries;
  } finally {
    await handle.close();
  }
}

const missing = [];
for (const entry of lock.fonts) {
  if (await matches(path.join(fontDir, entry.file), entry.sha256)) continue;
  missing.push(entry);
}

if (missing.length === 0) {
  console.log(`fonts: ${lock.fonts.length} files already present and verified in ${fontDir}`);
  process.exit(0);
}

await mkdir(fontDir, { recursive: true });
const temporary = await mkdtemp(path.join(tmpdir(), 'bokydo-fonts-'));
try {
  const byUrl = new Map();
  for (const entry of missing) {
    const group = byUrl.get(entry.url) ?? [];
    group.push(entry);
    byUrl.set(entry.url, group);
  }
  let archiveIndex = 0;
  for (const [url, group] of byUrl) {
    const archive = path.join(temporary, `archive-${archiveIndex++}.zip`);
    console.log(`fonts: downloading ${url}`);
    await download(url, archive);
    const archiveHash = await sha256File(archive);
    if (archiveHash !== group[0].archiveSha256)
      throw new Error(
        `${url}: archive SHA-256 ${archiveHash} does not match ${group[0].archiveSha256}`,
      );
    const wanted = new Set(group.map((entry) => entry.archiveEntry));
    const extracted = await readZipEntries(archive, wanted);
    for (const entry of group) {
      const data = extracted.get(entry.archiveEntry);
      const hash = createHash('sha256').update(data).digest('hex');
      if (hash !== entry.sha256)
        throw new Error(`${entry.archiveEntry}: SHA-256 ${hash} does not match ${entry.sha256}`);
      const target = path.join(fontDir, entry.file);
      const partial = `${target}.partial-${process.pid}`;
      await writeFile(partial, data, { mode: 0o644 });
      await rename(partial, target);
      console.log(`fonts: installed ${entry.file}`);
    }
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

console.log(`fonts: ${missing.length} file(s) installed in ${fontDir}`);
