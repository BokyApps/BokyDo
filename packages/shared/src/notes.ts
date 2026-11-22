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

/**
 * A canonical ISO-8601 instant: exactly what `Date#toISOString` writes, so it is the only way to
 * name an instant unambiguously on the wire. A lenient parse such as `Date.parse` would accept
 * several strings for one instant; a revision precondition must mean precisely the one the client
 * saw, so a value that does not round-trip is rejected.
 */
const canonicalInstant = z.string().refine((value) => {
  const date = new Date(value);
  return !Number.isNaN(date.getTime()) && date.toISOString() === value;
}, 'Must be a canonical ISO-8601 instant');

/** Whether a patch changes a stored field; the revision precondition on its own changes nothing. */
export function notePatchWrites(patch: object): boolean {
  return Object.keys(patch).some((key) => key !== 'expectedUpdatedAt');
}

export const notePatchSchema = z
  .object({
    title: z.string().max(NOTE_TITLE_MAX).optional(),
    body: bodySchema.optional(),
    tags: tagsSchema.optional(),
    pinned: z.boolean().optional(),
    state: noteStateSchema.optional(),
    /** true moves it to the trash, false restores it. */
    trashed: z.boolean().optional(),
    /**
     * Optimistic concurrency: the `updatedAt` the caller last saw. It is compared to the locked
     * row's `updated_at` in the same transaction as the write; a mismatch is `stale_revision` and
     * nothing is written. It is never stored. Omitting it keeps the pre-existing last-write-wins
     * behaviour, for clients that do not track revisions.
     */
    expectedUpdatedAt: canonicalInstant.optional(),
  })
  .strict()
  .refine(notePatchWrites, 'At least one field is required');
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
  /** The start of the body as plain text with line breaks, censored spans replaced, at most `NOTE_SNIPPET_MAX` characters. */
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

/** Why a note is linked to a task: derived from its Markdown body, or made explicitly. */
export type NoteTaskLinkSource = 'body' | 'manual';

export interface NoteLinkedTask {
  id: string;
  content: string;
  projectId: string;
  completed: boolean;
  /** Both values when a body link was also linked manually; order is `body`, `manual`. */
  sources: NoteTaskLinkSource[];
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

/** One note linked to a task, with the provenance of the link (GET /tasks/:id/notes). */
export interface NoteTaskSummary extends NoteSummary {
  sources: NoteTaskLinkSource[];
}

export interface NoteTaskNotesResponse {
  notes: NoteTaskSummary[];
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

const CENSOR_NAME = 'censored';
/** `\s` for one char: a non-global regex has no state and no backtracking. */
const CENSOR_WHITESPACE = /\s/;

/**
 * Replace anything that looks like the start of a censored span with the placeholder. This is
 * deliberately lenient: `{{` + optional whitespace + `censored` in any case, then everything up
 * to the next `}}`, however far away (or, when there is no `}}` at all, to the end of the text)
 * is removed. Over-redacting is the safe direction: a span with spaces in it must not leak its
 * words, whether its closer is far away or missing. A malformed or hand-edited token must never
 * leak ciphertext-looking text into a snippet, a search result or an MCP tool result.
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
    if (close !== -1) {
      end = close + 2;
      close = -1;
    } else {
      // No closer anywhere after it: the rest of the text may be the span.
      end = text.length;
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
  // Each field is redacted on its own (an unclosed span in the title must not swallow the body),
  // with the same lenient rules as snippets and MCP: malformed spans are never indexed either.
  return [title, ...tags, body]
    .map(redactCensored)
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

const SNIPPET_SCAN_CHARS = 16_384;
const SNIPPET_SCAN_LINES = 40;
const SNIPPET_LINE_CHARS = 1_000;
const SNIPPET_FENCE = /^\s{0,3}(?:`{3,}|~{3,})/;
/** A GFM table's alignment row (`| --- | :-: |`): only pipes, colons, dashes and spaces. */
const isTableRule = (line: string): boolean => line.includes('---') && /^[\s|:-]+$/.test(line);
const SNIPPET_BLOCK_PREFIX = /^\s{0,3}(?:#{1,6}\s+|>\s?|[-*+]\s+(?:\[[ xX]\]\s+)?|\d{1,9}[.)]\s+)/;
/** `[label](dest)` and `![alt](src)`, bounded so a hostile line cannot backtrack for long. */
const SNIPPET_LINK = /!?\[([^\]\n]{0,500})\]\([^)\n]{0,2100}\)/g;
const SNIPPET_ENTITIES: Record<string, string> = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
};
const SNIPPET_ENTITY = /&(?:nbsp|amp|lt|gt|quot|#39);/g;
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/;

/** One Markdown line as the text a reader sees: escapes resolved, emphasis markers dropped. */
function snippetLine(raw: string): string {
  let line = raw.slice(0, SNIPPET_LINE_CHARS).replace(/^::embed(?=\[)/, '');
  for (let i = 0; i < 4 && SNIPPET_BLOCK_PREFIX.test(line); i++)
    line = line.replace(SNIPPET_BLOCK_PREFIX, '');
  line = line.replace(SNIPPET_LINK, '$1').replace(APP_URL, ' ');
  let out = '';
  let inCode = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line.charAt(i);
    if (ch === '`') {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      out += ch;
      continue;
    }
    if (ch === '\\') {
      const next = line.charAt(i + 1);
      if (ASCII_PUNCTUATION.test(next)) {
        out += next;
        i++;
      }
      continue;
    }
    if (ch === '*' || ch === '_' || ch === '~') continue;
    out += ch === '|' ? ' ' : ch;
  }
  return out
    .replace(SNIPPET_ENTITY, (e) => SNIPPET_ENTITIES[e] ?? e)
    .replace(WHITESPACE, ' ')
    .trim();
}

/**
 * A short plain-text preview for lists: the first lines of the body as a reader sees them, with
 * line breaks and punctuation kept, runs of blank lines collapsed, and censored spans as █████.
 * Only the start of the body is read, so a hostile body costs a bounded amount of work.
 */
export function noteSnippet(body: string): string {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of redactCensored(body)
    .slice(0, SNIPPET_SCAN_CHARS)
    .split('\n', SNIPPET_SCAN_LINES)) {
    if (SNIPPET_FENCE.test(raw)) inFence = !inFence;
    else if (inFence) lines.push(raw.slice(0, SNIPPET_LINE_CHARS).replace(WHITESPACE, ' ').trim());
    else if (!isTableRule(raw)) lines.push(snippetLine(raw));
  }
  const kept: string[] = [];
  for (const line of lines) {
    if (line || (kept.length && kept[kept.length - 1])) kept.push(line);
  }
  while (kept.length && !kept[kept.length - 1]) kept.pop();
  const text = kept.join('\n');
  if (text.length <= NOTE_SNIPPET_MAX) return text;
  const cut = text.slice(0, NOTE_SNIPPET_MAX);
  // Never split a surrogate pair at the boundary.
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
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
