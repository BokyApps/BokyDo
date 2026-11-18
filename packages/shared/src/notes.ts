import { z } from 'zod';
import { idSchema } from './model.js';

/**
 * Notes (ADR 0025): a person's own Markdown notes, with tags, links to notes and tasks, and
 * files. This module holds everything the web app and the server must agree on: the wire
 * shapes, tag normalisation, and the pure Markdown helpers. It has no Node-only imports.
 */

export const NOTE_TITLE_MAX = 200;
/** 512 KiB of UTF-8. Also enforced by a database check on `octet_length`. */
export const NOTE_BODY_MAX_BYTES = 512 * 1024;
export const NOTE_TAG_MAX_LENGTH = 50;
export const NOTE_TAGS_MAX = 20;
/**
 * Most distinct note and task links stored from one body. More is rejected (`too_many_links`)
 * so a hostile body cannot fill the link tables; file references are not capped, because a
 * file can only ever be claimed for its own note and owner.
 */
export const NOTE_REF_LIMIT = 1000;
export const NOTE_SNIPPET_MAX = 200;
/** What coolers render in place of a censored span. */
export const CENSOR_PLACEHOLDER = '█████';
/** AES-GCM ciphertext plus tag; ADR 0025's ceiling for one censored span. */
export const CENSOR_CIPHERTEXT_MAX_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** UTF-8 length of a string, without Buffer (this module also runs in the browser). */
export function utf8Length(value: string): number {
  return encoder.encode(value).length;
}

/**
 * Trim and lower-case tags, drop duplicates, and reject anything the ADR forbids: 1–50
 * characters each, no `#`, `,` or whitespace, at most 20. Returns null when invalid.
 */
export function normaliseNoteTags(input: readonly string[]): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    // eslint-disable-next-line no-control-regex -- control characters make a tag invalid
    if (/[\s#,\u0000-\u001f\u007f]/.test(raw.trim())) return null;
    const tag = raw.trim().toLowerCase();
    if (tag === '') continue;
    if (tag.length > NOTE_TAG_MAX_LENGTH) return null;
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out.length > NOTE_TAGS_MAX ? null : out;
}

const tagsSchema = z
  .array(z.string())
  .max(NOTE_TAGS_MAX * 10)
  .refine((tags) => normaliseNoteTags(tags) !== null, 'Invalid tag');

const bodySchema = z
  .string()
  .refine((body) => utf8Length(body) <= NOTE_BODY_MAX_BYTES, 'Note body is too large');

export const noteStateSchema = z.enum(['active', 'archived']);
export type NoteStoredState = z.infer<typeof noteStateSchema>;
/** What the API shows: the stored state, or `trashed` while `trashed_at` is set. */
export const noteDisplayStateSchema = z.enum(['active', 'archived', 'trashed']);
export type NoteState = z.infer<typeof noteDisplayStateSchema>;

export const noteCreateRequestSchema = z
  .object({
    /** Stable client-generated ID, so retrying a create is safe. */
    id: idSchema.optional(),
    title: z.string().max(NOTE_TITLE_MAX).default(''),
    body: bodySchema.default(''),
    tags: tagsSchema.default([]),
    pinned: z.boolean().default(false),
  })
  .strict();
export type NoteCreateRequest = z.infer<typeof noteCreateRequestSchema>;

export const notePatchSchema = z
  .object({
    title: z.string().max(NOTE_TITLE_MAX).optional(),
    body: bodySchema.optional(),
    tags: tagsSchema.optional(),
    pinned: z.boolean().optional(),
    state: noteStateSchema.optional(),
    /** true moves it to the trash, false restores it. */
    trashed: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export type NotePatch = z.infer<typeof notePatchSchema>;

export const noteListQuerySchema = z
  .object({
    q: z.string().max(200).optional(),
    tag: z.string().max(NOTE_TAG_MAX_LENGTH).optional(),
    state: noteDisplayStateSchema.default('active'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    /** Opaque `nextCursor` from the previous page. */
    cursor: z.string().max(1000).optional(),
  })
  .strict();
export type NoteListQuery = z.infer<typeof noteListQuerySchema>;

export interface NoteSummary {
  id: string;
  title: string;
  /** Plain text from the body, censored spans replaced, at most `NOTE_SNIPPET_MAX` characters. */
  snippet: string;
  tags: string[];
  state: NoteState;
  pinned: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface NoteBacklink {
  id: string;
  title: string;
}

export interface NoteLinkedTask {
  id: string;
  content: string;
  projectId: string;
  completed: boolean;
}

export interface NoteFileSummary {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export interface Note extends NoteSummary {
  body: string;
  trashedAt: string | null;
  /** Other of the caller's notes that link here. */
  backlinks: NoteBacklink[];
  /** Tasks in projects the caller can still see; leaving a project hides its tasks. */
  linkedTasks: NoteLinkedTask[];
  files: NoteFileSummary[];
}

export interface NoteListResponse {
  notes: NoteSummary[];
  nextCursor: string | null;
}

export interface NoteTagsResponse {
  tags: { tag: string; count: number }[];
}

// ---------------------------------------------------------------------------------------------
// Censored spans: {{censored:v1:<salt>:<iv>:<ciphertext>}}, unpadded base64url
// ---------------------------------------------------------------------------------------------

/** The v1 token shape. Bounded quantifiers keep a hostile body linear to scan. */
const B64URL = '[A-Za-z0-9_-]';
export const CENSOR_TOKEN = new RegExp(
  `\\{\\{censored:v1:${B64URL}{22}:${B64URL}{16}:${B64URL}{1,87382}\\}\\}`,
  'g',
);

const B64URL_PART = /^[A-Za-z0-9_-]+$/;
const CENSOR_PREFIX = '{{censored:';
const CENSOR_SALT_LENGTH = 22; // 16 bytes
const CENSOR_IV_LENGTH = 16; // 12 bytes
/** Salt + IV are fixed-length base64url; the ciphertext is bounded by the ADR. */
const CENSOR_CIPHERTEXT_MAX_CHARS = 87_382; // 64 KiB, unpadded base64url
const CENSOR_TOKEN_MAX =
  CENSOR_PREFIX.length +
  2 + // "v1"
  3 + // separators
  CENSOR_SALT_LENGTH +
  CENSOR_IV_LENGTH +
  CENSOR_CIPHERTEXT_MAX_CHARS +
  2; // "}}"

export interface CensoredToken {
  /** Unpadded base64url (16 random bytes). */
  salt: string;
  /** Unpadded base64url (12 random bytes). */
  iv: string;
  /** Unpadded base64url (AES-256-GCM ciphertext, at most 64 KiB decoded). */
  ciphertext: string;
}

/**
 * Parse a complete `{{censored:v1:…}}` token. Only the shape and sizes are checked: the server
 * never has the key, so it cannot (and must not) look inside.
 */
export function parseCensorToken(token: string): CensoredToken | null {
  if (token.length > CENSOR_TOKEN_MAX) return null;
  if (!token.startsWith(CENSOR_PREFIX) || !token.endsWith('}}')) return null;
  const parts = token.slice(CENSOR_PREFIX.length, -2).split(':');
  if (parts.length !== 4) return null;
  const [version, salt, iv, ciphertext] = parts as [string, string, string, string];
  if (version !== 'v1') return null;
  if (!B64URL_PART.test(salt) || !B64URL_PART.test(iv) || !B64URL_PART.test(ciphertext))
    return null;
  if (salt.length !== CENSOR_SALT_LENGTH || iv.length !== CENSOR_IV_LENGTH) return null;
  const bytes = Math.floor((ciphertext.length * 3) / 4);
  if (ciphertext.length % 4 === 1 || bytes < 1 || bytes > CENSOR_CIPHERTEXT_MAX_BYTES) return null;
  return { salt, iv, ciphertext };
}

/**
 * How far after a `{{` a closing `}}` is still looked for. Beyond that the span is assumed to run
 * to the end of its whitespace-free run, which keeps a hostile body from hiding text behind an
 * unbalanced opener at the far end of a megabyte.
 */
const CENSOR_REDACT_SCAN = 100_000;
const CENSOR_NAME = 'censored';
/** `\s` for one char: a non-global regex has no state and no backtracking. */
const CENSOR_WHITESPACE = /\s/;

/**
 * Replace anything that looks like the start of a censored span with the placeholder. This is
 * deliberately lenient: `{{` + optional whitespace + `censored` in any case, then everything up
 * to the next `}}` (or, when there is none within 100,000 characters, to the end of the
 * following whitespace-free run) is removed. A malformed or hand-edited token must never leak
 * ciphertext-looking text into a snippet, a search result or an MCP tool result.
 *
 * Linear time on purpose: an indexOf scan with one forward pass and no regex backtracking, since
 * note bodies are attacker-controlled up to 512 KiB.
 */
export function redactCensored(text: string): string {
  if (!text.includes('{{')) return text;
  const parts: string[] = [];
  /** End of the text already copied into `parts`. */
  let copied = 0;
  let search = 0;
  /** The next `}}` at or after `search`, cached while it is still too far to be a closer. */
  let close = -1;
  let noMoreCloses = false;
  while (search < text.length) {
    const open = text.indexOf('{{', search);
    if (open === -1) break;
    let name = open + 2;
    while (name < text.length && CENSOR_WHITESPACE.test(text.charAt(name))) name++;
    if (text.slice(name, name + CENSOR_NAME.length).toLowerCase() !== CENSOR_NAME) {
      // Only one brace is consumed: a span may start at the second `{` of this pair.
      search = open + 1;
      continue;
    }
    const after = name + CENSOR_NAME.length;
    if (!noMoreCloses && (close === -1 || close < after)) {
      close = text.indexOf('}}', after);
      if (close === -1) noMoreCloses = true;
    }
    let end: number;
    if (close !== -1 && close - open <= CENSOR_REDACT_SCAN) {
      end = close + 2;
      close = -1;
    } else {
      end = after;
      while (end < text.length && !CENSOR_WHITESPACE.test(text.charAt(end))) end++;
    }
    parts.push(text.slice(copied, open), CENSOR_PLACEHOLDER);
    copied = end;
    search = end;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(copied));
  return parts.join('');
}

// ---------------------------------------------------------------------------------------------
// Markdown helpers shared by the editor and the server
// ---------------------------------------------------------------------------------------------

const HTTP_URL = /https?:\/\/[^\s<>"'`]+/gi;
const MAILTO_URL = /mailto:[^\s<>"'`]+/gi;
const WWW_URL = /\bwww\.[^\s<>"'`]+/gi;
/** In-app links and note-file URLs: their IDs are meaningless as words. */
const APP_URL = /(?:bokydo:(?:note|task)\/|\/api\/v1\/note-files\/)[0-9a-fA-F-]{0,64}/g;
// eslint-disable-next-line no-useless-escape -- `]`, `[` and `-` are clearer escaped in a class
const MARKDOWN_PUNCTUATION = /[\\`*_{}\[\]()#+.!|~<>:;-]+/g;
const WHITESPACE = /\s+/g;

/**
 * The text a note is indexed by: title, tags and body with censor tokens, URLs and Markdown
 * punctuation removed. Censored plaintext is never part of this, because the server never has
 * it. Linear passes only, so a hostile body costs time proportional to its length.
 */
export function toSearchText(title: string, tags: readonly string[], body: string): string {
  return [title, ...tags, body]
    .join(' ')
    .replace(CENSOR_TOKEN, ' ')
    .replace(HTTP_URL, ' ')
    .replace(MAILTO_URL, ' ')
    .replace(WWW_URL, ' ')
    .replace(APP_URL, ' ')
    .replace(MARKDOWN_PUNCTUATION, ' ')
    .replace(WHITESPACE, ' ')
    .trim();
}

/** A short plain-text preview for lists; censored spans show as █████. */
export function noteSnippet(body: string): string {
  const text = toSearchText('', [], redactCensored(body));
  if (text.length <= NOTE_SNIPPET_MAX) return text;
  const cut = text.slice(0, NOTE_SNIPPET_MAX);
  // Never split a surrogate pair at the boundary.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidAt(text: string, start: number): string | null {
  if (start + 36 > text.length) return null;
  const candidate = text.slice(start, start + 36);
  return UUID_PATTERN.test(candidate) ? candidate.toLowerCase() : null;
}

export interface NoteRefs {
  noteIds: string[];
  taskIds: string[];
  fileIds: string[];
}

const NOTE_PREFIX = 'bokydo:note/';
const TASK_PREFIX = 'bokydo:task/';
const FILE_PREFIX = '/api/v1/note-files/';
const FILE_INLINE = '?inline=1';
const NOTE_LENGTH = NOTE_PREFIX.length + 36;
const FILE_LENGTH = FILE_PREFIX.length + 36;
const BACKTICK = 96;
const TILDE = 126;

/**
 * The in-app links and note-file references in a Markdown body. Only real link and image
 * destinations count: the text after `](`, read up to the first whitespace or `)`. Fenced code
 * blocks, inline code spans and plain text (including bare UUIDs and look-alike URLs) are
 * skipped. Destinations must match exactly `bokydo:note/<uuid>`, `bokydo:task/<uuid>` or
 * `/api/v1/note-files/<uuid>` (with an optional `?inline=1`).
 *
 * One forward pass: fences and code spans are consumed with fixed look-ahead, never backtracking,
 * so a hostile body stays linear.
 */
export function extractNoteRefs(body: string): NoteRefs {
  const noteIds = new Set<string>();
  const taskIds = new Set<string>();
  const fileIds = new Set<string>();
  const n = body.length;
  let i = 0;
  let lineStart = true;
  /** Where the current `[...]` label opened, so a bare `](` in prose is not a link. */
  let labelStart = -1;
  while (i < n) {
    if (lineStart) {
      lineStart = false;
      let j = i;
      let spaces = 0;
      while (spaces < 3 && body.charCodeAt(j) === 32) {
        j++;
        spaces++;
      }
      const fence = body.charCodeAt(j);
      if (fence === BACKTICK || fence === TILDE) {
        let k = j;
        while (body.charCodeAt(k) === fence) k++;
        const run = k - j;
        if (run >= 3) {
          const nl = body.indexOf('\n', k);
          i = skipFence(body, nl === -1 ? n : nl + 1, fence, run);
          labelStart = -1;
          lineStart = true;
          continue;
        }
      }
    }
    const c = body.charCodeAt(i);
    if (c === 10) {
      i++;
      lineStart = true;
      continue;
    }
    if (c === BACKTICK) {
      let k = i;
      while (body.charCodeAt(k) === BACKTICK) k++;
      const close = backtickClose(body, k, k - i);
      if (close === -1) {
        // An unmatched run is literal text in CommonMark; skip the rest of its line so a
        // hostile body full of unclosed backticks cannot make us rescan it per run.
        const nl = body.indexOf('\n', k);
        i = nl === -1 ? n : nl;
      } else i = close + (k - i);
      continue;
    }
    if (c === 91) {
      labelStart = i;
      i++;
      continue;
    }
    if (c === 93) {
      const hadLabel = labelStart !== -1;
      labelStart = -1;
      if (hadLabel && body.charCodeAt(i + 1) === 40) {
        // A `](` after a label is a link or image destination: the URL runs to whitespace or
        // `)`, and any `"title"` after that whitespace is ignored.
        let end = i + 2;
        while (end < n) {
          const d = body.charCodeAt(end);
          if (d === 41 || d === 32 || d === 9 || d === 10 || d === 13) break;
          end++;
        }
        collectDestination(body, i + 2, end, noteIds, taskIds, fileIds);
        i = end;
        continue;
      }
      i++;
      continue;
    }
    i++;
  }
  return { noteIds: [...noteIds], taskIds: [...taskIds], fileIds: [...fileIds] };
}

/** Classify one destination by exact shape; no substring search, so look-alikes never match. */
function collectDestination(
  body: string,
  start: number,
  end: number,
  noteIds: Set<string>,
  taskIds: Set<string>,
  fileIds: Set<string>,
): void {
  const length = end - start;
  if (length === NOTE_LENGTH) {
    if (body.startsWith(NOTE_PREFIX, start)) {
      const id = uuidAt(body, start + NOTE_PREFIX.length);
      if (id) noteIds.add(id);
    } else if (body.startsWith(TASK_PREFIX, start)) {
      const id = uuidAt(body, start + TASK_PREFIX.length);
      if (id) taskIds.add(id);
    }
  } else if (length === FILE_LENGTH || length === FILE_LENGTH + FILE_INLINE.length) {
    if (!body.startsWith(FILE_PREFIX, start)) return;
    if (length !== FILE_LENGTH && !body.startsWith(FILE_INLINE, start + FILE_LENGTH)) return;
    const id = uuidAt(body, start + FILE_PREFIX.length);
    if (id) fileIds.add(id);
  }
}

/** Index just past the closing fence line, or the end when the fence is never closed. */
function skipFence(body: string, from: number, fence: number, run: number): number {
  const n = body.length;
  let line = from;
  while (line < n) {
    let q = line;
    let spaces = 0;
    while (spaces < 3 && body.charCodeAt(q) === 32) {
      q++;
      spaces++;
    }
    if (body.charCodeAt(q) === fence) {
      let r = q;
      while (body.charCodeAt(r) === fence) r++;
      if (r - q >= run) {
        let t = r;
        while (t < n && (body.charCodeAt(t) === 32 || body.charCodeAt(t) === 9)) t++;
        if (t === n || body.charCodeAt(t) === 10) return t === n ? n : t + 1;
      }
    }
    const nl = body.indexOf('\n', line);
    if (nl === -1) return n;
    line = nl + 1;
  }
  return n;
}

/** Start of the next run of exactly `run` backticks on this line, or -1. */
function backtickClose(body: string, from: number, run: number): number {
  const n = body.length;
  let p = from;
  while (p < n) {
    const c = body.charCodeAt(p);
    if (c === 10) return -1;
    if (c === BACKTICK) {
      let q = p;
      while (body.charCodeAt(q) === BACKTICK) q++;
      if (q - p === run) return p;
      p = q;
      continue;
    }
    p++;
  }
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Embeds (YouTube and Google Drive only)
// ---------------------------------------------------------------------------------------------

export interface Embed {
  provider: 'youtube' | 'drive';
  id: string;
  /** Canonical embed URL; YouTube uses the no-cookie host. */
  embedUrl: string;
  /** Canonical watch URL for the "open in a new tab" fallback. */
  openUrl: string;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);

/**
 * Recognise exactly the allow-listed embeddable URLs (ADR 0025): https only, strict hostnames,
 * IDs by regex. `null` means "show a plain link instead".
 */
export function parseEmbedUrl(raw: string): Embed | null {
  if (raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();

  if (host === 'youtu.be') {
    const id = /^\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1];
    return id ? youtube(id) : null;
  }
  if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v');
      return id && YOUTUBE_ID.test(id) ? youtube(id) : null;
    }
    const id = /^\/shorts\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1];
    return id ? youtube(id) : null;
  }
  if (host === 'drive.google.com') {
    const id = /^\/file\/d\/([A-Za-z0-9_-]{10,100})(?:\/|$)/.exec(url.pathname)?.[1];
    if (!id || !DRIVE_ID.test(id)) return null;
    return {
      provider: 'drive',
      id,
      embedUrl: `https://drive.google.com/file/d/${id}/preview`,
      openUrl: `https://drive.google.com/file/d/${id}/view`,
    };
  }
  return null;
}

function youtube(id: string): Embed {
  return {
    provider: 'youtube',
    id,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
    openUrl: `https://www.youtube.com/watch?v=${id}`,
  };
}
