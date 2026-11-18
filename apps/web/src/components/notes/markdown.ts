/* eslint-disable @typescript-eslint/no-non-null-assertion --
   Index access below is bounds-checked by the surrounding loop/length conditions. */
import { safeHref } from '@bokydo/shared';
import type { JSONContent } from '@tiptap/core';
import MarkdownIt, { type Token } from 'markdown-it';
import { parseToken } from '../../lib/censor.js';
import { formatEmbedLine, parseEmbedLine, parseEmbedUrl } from './embed.js';

/**
 * Markdown <-> ProseMirror conversion for the notes editor (ADR 0025).
 *
 * Why not @tiptap/markdown / prosemirror-markdown? The ADR defines four *custom* constructs that
 * stock Markdown parsers know nothing about: `{{censored:v1:…}}` inline atoms, `::embed[…](…)`
 * block atoms, note-file URLs (`/api/v1/note-files/<uuid>`) that become image/file chips, and
 * `bokydo:note|task/<uuid>` internal chips. On top of that, every link must pass `safeHref`, raw
 * HTML must stay text, and output must be a *canonical* string that re-parses to the same document.
 * Owning the conversion with markdown-it (html:false) + a deterministic serializer is the only way
 * to guarantee all of that and to unit-test it headlessly; the TipTap editor only ever sees JSON.
 *
 * Review fix (silent rewrite / data loss): every *top-level* block carries `attrs.src`, the exact
 * slice of the source Markdown it came from (plus `attrs.sep`/`attrs.lead` for the surrounding
 * whitespace). On serialise an unchanged block is emitted verbatim from `src`, so an edit in one
 * block can never rewrite or discard the Markdown of any other block. "Unchanged" is exact
 * recursive equality of the block's JSON with the JSON its own source parses to (only the
 * bookkeeping attributes are ignored), never a hash: a lossy serialiser can then never make an
 * edit look like a no-op.
 *
 * Separators are only reused for the neighbour they were measured against (`attrs.prevId`,
 * `attrs.nextId`, `attrs.blockId`): a block inserted or deleted between two preserved blocks
 * gets a fresh `\n\n`, so blocks can never merge.
 *
 * Custom syntax is recognised from RAW SOURCE (an odd number of preceding backslashes escapes it),
 * never by matching decoded text, so `\{\{censored…` and `\::embed` stay literal. Every line
 * ending is normalised to LF before parsing so markdown-it's line offsets always match the string
 * we slice.
 */

// ---------------------------------------------------------------------------------------------
// Constants / classification
// ---------------------------------------------------------------------------------------------

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const UUID_RE = new RegExp(`^${UUID}$`);
/** Note-file URLs may carry `?inline=1` for images. Anchored so nothing else is ever an <img>. */
export const NOTE_FILE_SRC_RE = new RegExp(`^/api/v1/note-files/(${UUID})(\\?inline=1)?$`);
const INTERNAL_NOTE = new RegExp(`^bokydo:note/(${UUID})$`);
const INTERNAL_TASK = new RegExp(`^bokydo:task/(${UUID})$`);

export const NOTE_FILE_PREFIX = '/api/v1/note-files/';
export const CENSORED_PLACEHOLDER = '█████';

/** `{{censored:v1:<salt>:<iv>:<ct>}}` — shape only; validity is checked with strict parseToken. */
const CENSOR_BODY = '\\{\\{censored:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+\\}\\}';
export const CENSOR_TOKEN_EXACT = new RegExp(`^${CENSOR_BODY}$`);
const CENSOR_GLOBAL = new RegExp(CENSOR_BODY, 'g');

export type HrefKind =
  | { kind: 'link'; href: string }
  | { kind: 'file'; id: string }
  | { kind: 'note'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'unsafe' };

/** Classify a link/image destination. Anything not explicitly allowed becomes plain text. */
export function classifyHref(raw: string): HrefKind {
  const value = raw.trim();
  const file = NOTE_FILE_SRC_RE.exec(value);
  if (file?.[1]) return { kind: 'file', id: file[1] };
  const note = INTERNAL_NOTE.exec(value);
  if (note?.[1]) return { kind: 'note', id: note[1] };
  const task = INTERNAL_TASK.exec(value);
  if (task?.[1]) return { kind: 'task', id: task[1] };
  const href = safeHref(value);
  if (href) return { kind: 'link', href };
  return { kind: 'unsafe' };
}

// --- strict validators shared with the paste/drop parseHTML rules and renderHTML --------------

export function isValidNoteFileId(id: unknown): id is string {
  return typeof id === 'string' && UUID_RE.test(id);
}
/** The only validation for censor tokens: the crypto module's strict parseToken (ADR 0025). */
export function isValidCensorToken(token: unknown): token is string {
  return typeof token === 'string' && parseToken(token) !== null;
}
export function isValidInternalChip(kind: unknown, id: unknown): boolean {
  return (kind === 'note' || kind === 'task') && isValidNoteFileId(id);
}
export function isValidEmbedUrl(url: unknown): boolean {
  return typeof url === 'string' && parseEmbedUrl(url) !== null;
}
export function isCensorToken(value: string): boolean {
  return isValidCensorToken(value);
}

// ---------------------------------------------------------------------------------------------
// Escaping (produces readable, canonical Markdown that re-parses to the same doc)
// ---------------------------------------------------------------------------------------------

// Always escape characters that could start inline constructs, autolinks, table cells, entity
// decoding, or our own custom syntax (`{`/`}` so a literal `{{censored…` can never re-read as an
// atom, and `|` so it can never split a table cell).
const ESCAPE_ALWAYS = /[\\`*_[\]<>~|&{}]/g;

function escapeText(text: string, atLineStart: boolean): string {
  let out = text.replace(ESCAPE_ALWAYS, '\\$&');
  if (atLineStart) {
    // Block markers at the start of a line. Digits themselves can't be backslash-escaped, so an
    // ordered-list marker is defused by escaping its `.`/`)` punctuation instead.
    out = out.replace(/^([#>+-])/, '\\$1').replace(/^(\d+)([.)])/, '$1\\$2');
  }
  return out;
}

function escapeLabel(text: string): string {
  return escapeText(text, false).replace(/\r?\n/g, ' ');
}

function serializeHref(href: string): string {
  // safeHref destinations have no whitespace/quotes; parens and backslashes must be escaped so
  // the destination is not truncated.
  return href.replace(/[()\\]/g, '\\$&');
}

function serializeTitle(title: string): string {
  // A link title is rendered as `"…"`; quotes/backslashes inside it must be escaped.
  return title.replace(/[\\"]/g, '\\$&');
}

function longestRun(text: string, char: string): number {
  let max = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === char) {
      run++;
      if (run > max) max = run;
    } else run = 0;
  }
  return max;
}

/** A fence longer than any run of the same character inside the code (~~~ if backticks clash). */
function codeFence(text: string): string {
  const ticks = longestRun(text, '`');
  if (ticks < 3) return '```';
  const tildes = longestRun(text, '~');
  return '~'.repeat(Math.max(3, tildes + 1));
}

function serializeCode(text: string): string {
  const body = text.replace(/\r?\n/g, ' ');
  const ticks = longestRun(body, '`');
  const delim = '`'.repeat(ticks + 1);
  const pad = delim.length > 1 || body.startsWith('`') || body.endsWith('`') ? ' ' : '';
  return `${delim}${pad}${body}${pad}${delim}`;
}

type Mark = { type: string; attrs?: Record<string, unknown> };

function addMark(marks: Mark[], type: string): Mark[] {
  return marks.some((m) => m.type === type) ? marks : [...marks, { type }];
}

function removeMark(marks: Mark[], type: string): Mark[] {
  const idx = marks.findIndex((m) => m.type === type);
  if (idx === -1) return marks;
  const next = [...marks];
  next.splice(idx, 1);
  return next;
}

const INLINE_TYPES = new Set([
  'text',
  'hardBreak',
  'censored',
  'noteImage',
  'fileChip',
  'internalChip',
  'noteUpload',
]);

/**
 * Attributes written by `markdownToDoc` for source preservation. They are bookkeeping, never
 * document content, so block equality ignores them.
 */
const SOURCE_META_ATTRS = new Set(['src', 'sep', 'lead', 'blockId', 'prevId', 'nextId']);
/** Editor-only attributes (e.g. Remove-censor's transient id); never persisted, never compared. */
const TRANSIENT_ATTRS = new Set(['removeId']);

/** Older/other CR forms become LF: offsets are computed on the string markdown-it parses. */
export function normaliseLineEndings(src: string): string {
  return src.replace(/\r\n?/g, '\n');
}

// ---------------------------------------------------------------------------------------------
// Markdown -> ProseMirror JSON
// ---------------------------------------------------------------------------------------------

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(6, Math.max(1, Math.round(value)));
}

/**
 * Whether `index` in `text` sits behind an odd number of backslashes, i.e. is escaped. Every
 * custom-syntax check below uses this on the RAW source, so a literal construct and an identical
 * active one in the same paragraph can never be confused (review: escaped censor syntax active).
 */
export function isEscapedAt(text: string, index: number): boolean {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text.charAt(i) === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

/**
 * Custom inline syntax is represented to markdown-it by a unique private-use sentinel, substituted
 * BEFORE parsing. That way:
 *  - an escaped `\{\{censored…` can never be promoted just because the identical unescaped token
 *    exists elsewhere in the paragraph, and the atom keeps the marks around it;
 *  - a table cell's `<br>` becomes a real hard break without splitting emphasis (`**a<br>b**`
 *    stays one bold run with a break in the middle), which raw splitting cannot do.
 * The random nonce makes the sentinel impossible to predict (or forge) from note content.
 */
const SENTINEL_START = '\uE000';
const SENTINEL_END = '\uE001';

type SentinelValue = { kind: 'censored'; token: string } | { kind: 'hardBreak' };

/** The sentinels for one inline block; `prefix` is random, so note text cannot contain it. */
interface Sentinels {
  prefix: string;
  values: Map<string, SentinelValue>;
}

function sentinelNonce(): string {
  return Math.random().toString(36).slice(2);
}

/** Unescaped `<br>` / `<br/>` / `<br />` tags outside code spans, with their raw offsets. */
function cellHardBreaks(raw: string): { index: number; length: number }[] {
  const breaks: { index: number; length: number }[] = [];
  let i = 0;
  let fence = 0; // length of the code-span fence we are inside, 0 when outside
  while (i < raw.length) {
    const ch = raw.charAt(i);
    if (ch === '`') {
      let run = 0;
      while (raw.charAt(i + run) === '`') run++;
      if (fence === 0) fence = run;
      else if (run === fence) fence = 0;
      i += run;
      continue;
    }
    if (ch === '<' && fence === 0 && !isEscapedAt(raw, i)) {
      const tag = /^<br\s*\/?>/i.exec(raw.slice(i));
      if (tag && !isEscapedAt(raw, i + tag[0].length - 1)) {
        breaks.push({ index: i, length: tag[0].length });
        i += tag[0].length;
        continue;
      }
    }
    i++;
  }
  return breaks;
}

/**
 * Replace the custom inline syntax of one block's raw source with sentinels. `inCell` also turns
 * `<br>` into a hard break; `inTableCell` is the only place that construct is meaningful.
 */
function substituteSentinels(
  raw: string,
  inCell: boolean,
): { text: string; sentinels: Sentinels | null } {
  const maybeBreak = inCell && raw.toLowerCase().includes('<br');
  if (!raw.includes('{{censored:') && !maybeBreak) return { text: raw, sentinels: null };
  const prefix = `${SENTINEL_START}${sentinelNonce()}:`;
  const values = new Map<string, SentinelValue>();
  const replacements: { index: number; length: number; value: SentinelValue }[] = [];

  CENSOR_GLOBAL.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CENSOR_GLOBAL.exec(raw)) !== null) {
    const token = match[0];
    // Odd backslashes before the first `{` escape it: leave the raw text untouched.
    if (isEscapedAt(raw, match.index) || !isValidCensorToken(token)) continue;
    replacements.push({
      index: match.index,
      length: token.length,
      value: { kind: 'censored', token },
    });
  }
  if (maybeBreak) {
    for (const br of cellHardBreaks(raw)) {
      replacements.push({ index: br.index, length: br.length, value: { kind: 'hardBreak' } });
    }
  }
  if (replacements.length === 0) return { text: raw, sentinels: null };
  replacements.sort((a, b) => a.index - b.index);

  const parts: string[] = [];
  let copied = 0;
  for (const replacement of replacements) {
    if (replacement.index < copied) continue; // overlapping matches: the first one wins
    const sentinel = `${prefix}${values.size}${SENTINEL_END}`;
    values.set(sentinel, replacement.value);
    parts.push(raw.slice(copied, replacement.index), sentinel);
    copied = replacement.index + replacement.length;
  }
  parts.push(raw.slice(copied));
  return { text: parts.join(''), sentinels: { prefix, values } };
}

/**
 * Walk an already-decoded inline string at the sentinels of THIS parse. Linear: the random prefix
 * cannot occur in note text, so `split`/`indexOf` never rescan, and there is no regex quantifier
 * that a hostile run of private-use characters could make quadratic.
 */
function walkSentinels(
  text: string,
  sentinels: Sentinels | null,
  onText: (part: string) => void,
  onValue: (value: SentinelValue) => void,
): void {
  if (!sentinels || !text.includes(sentinels.prefix)) {
    onText(text);
    return;
  }
  const parts = text.split(sentinels.prefix);
  onText(parts[0] ?? '');
  for (let i = 1; i < parts.length; i++) {
    const part = parts[i]!;
    const end = part.indexOf(SENTINEL_END);
    const key = end === -1 ? null : `${sentinels.prefix}${part.slice(0, end + 1)}`;
    const value = key === null ? undefined : sentinels.values.get(key);
    if (value === undefined) {
      onText(`${sentinels.prefix}${part}`);
      continue;
    }
    onValue(value);
    onText(part.slice(end + 1));
  }
}

/** Turn any sentinel in an already-decoded string back into the literal source spelling. */
function restoreSentinels(text: string, sentinels: Sentinels | null): string {
  if (!sentinels) return text;
  let out = '';
  walkSentinels(
    text,
    sentinels,
    (part) => {
      out += part;
    },
    (value) => {
      out += value.kind === 'censored' ? value.token : '<br>';
    },
  );
  return out;
}

function collectLinkInner(children: Token[], start: number): { inner: Token[]; next: number } {
  let depth = 0;
  for (let i = start; i < children.length; i++) {
    const type = children[i]!.type;
    if (type === 'link_open') depth++;
    else if (type === 'link_close') {
      if (depth === 0) return { inner: children.slice(start, i), next: i + 1 };
      depth--;
    }
  }
  return { inner: children.slice(start), next: children.length };
}

function labelFromInline(inner: Token[]): string {
  let label = '';
  for (const t of inner) {
    if (t.type === 'text' || t.type === 'code_inline') label += t.content;
    else if (t.type === 'softbreak' || t.type === 'hardbreak') label += ' ';
  }
  return label;
}

function withMarks(marks: Mark[]): { marks: Mark[] } | Record<string, never> {
  return marks.length ? { marks: [...marks] } : {};
}

function parseInlineChildren(
  children: Token[],
  initialMarks: Mark[] = [],
  sentinels: Sentinels | null = null,
): JSONContent[] {
  const out: JSONContent[] = [];
  let marks = [...initialMarks];
  let i = 0;
  const pushText = (text: string) => {
    if (!text) return;
    out.push({ type: 'text', text, ...withMarks(marks) });
  };

  while (i < children.length) {
    const t = children[i]!;
    switch (t.type) {
      case 'text':
        walkSentinels(t.content, sentinels, pushText, (value) => {
          if (value.kind === 'censored') {
            out.push({ type: 'censored', attrs: { token: value.token }, ...withMarks(marks) });
          } else {
            out.push({ type: 'hardBreak', ...withMarks(marks) });
          }
        });
        i++;
        break;
      case 'strong_open':
        marks = addMark(marks, 'bold');
        i++;
        break;
      case 'strong_close':
        marks = removeMark(marks, 'bold');
        i++;
        break;
      case 'em_open':
        marks = addMark(marks, 'italic');
        i++;
        break;
      case 'em_close':
        marks = removeMark(marks, 'italic');
        i++;
        break;
      case 's_open':
        marks = addMark(marks, 'strike');
        i++;
        break;
      case 's_close':
        marks = removeMark(marks, 'strike');
        i++;
        break;
      case 'code_inline':
        // A token inside a code span is literal text, never an atom (it could not survive a
        // reload as an atom either).
        out.push({
          type: 'text',
          text: restoreSentinels(t.content, sentinels),
          marks: [...marks, { type: 'code' }],
        });
        i++;
        break;
      case 'hardbreak':
        out.push({ type: 'hardBreak', ...withMarks(marks) });
        i++;
        break;
      case 'softbreak':
        // A soft line break is preserved as a literal newline inside the paragraph (not a space).
        out.push({ type: 'text', text: '\n' });
        i++;
        break;
      case 'link_open': {
        const href = String(t.attrGet('href') ?? '');
        const rawTitle = t.attrGet('title');
        const title = rawTitle == null ? null : String(rawTitle);
        const cls = classifyHref(href);
        const { inner, next } = collectLinkInner(children, i + 1);
        if (cls.kind === 'file' || cls.kind === 'note' || cls.kind === 'task') {
          const label = restoreSentinels(labelFromInline(inner), sentinels);
          if (cls.kind === 'file') {
            out.push({ type: 'fileChip', attrs: { id: cls.id, name: label }, ...withMarks(marks) });
          } else {
            out.push({
              type: 'internalChip',
              attrs: { kind: cls.kind, id: cls.id, label },
              ...withMarks(marks),
            });
          }
        } else if (cls.kind === 'link') {
          const linkMark: Mark = {
            type: 'link',
            attrs: { href: cls.href, ...(title ? { title } : {}) },
          };
          out.push(...parseInlineChildren(inner, [...marks, linkMark], sentinels));
        } else {
          out.push(...parseInlineChildren(inner, marks, sentinels));
        }
        i = next;
        break;
      }
      case 'image': {
        const src = String(t.attrGet('src') ?? '');
        // A token can only reach here from inside an image's label; keep it as literal text.
        const alt = restoreSentinels(t.content, sentinels);
        const cls = classifyHref(src);
        if (cls.kind === 'file') {
          out.push({ type: 'noteImage', attrs: { id: cls.id, alt }, ...withMarks(marks) });
        } else {
          // Unsafe/foreign image src: show the literal markdown as text, never an <img>.
          pushText(`![${alt}](${src})`);
        }
        i++;
        break;
      }
      default:
        i++;
        break;
    }
  }
  return out;
}

/**
 * Inline nodes for one block. Custom syntax is substituted in the RAW source before parsing, so
 * only unescaped occurrences become atoms/breaks; documents without any reuse markdown-it's tokens.
 * `inCell` enables the table-cell `<br>` hard break.
 */
function parseInline(inline: Token | undefined, inCell = false): JSONContent[] {
  if (inline?.type !== 'inline') return [];
  const raw = inline.content ?? '';
  const hasSyntax = raw.includes('{{censored:') || (inCell && raw.toLowerCase().includes('<br'));
  if (!hasSyntax) return stripEmptyText(parseInlineChildren(inline.children ?? []));
  const { text, sentinels } = substituteSentinels(raw, inCell);
  if (!sentinels) return stripEmptyText(parseInlineChildren(inline.children ?? []));
  const substituted = md.parseInline(text, {}).find((t) => t.type === 'inline');
  return stripEmptyText(parseInlineChildren(substituted?.children ?? [], [], sentinels));
}

function firstTextNode(nodes: JSONContent[]): JSONContent | null {
  const paragraph = nodes.find((n) => n.type === 'paragraph');
  if (!paragraph?.content) return null;
  for (const child of paragraph.content) {
    if (child.type === 'text' && typeof child.text === 'string') return child;
  }
  return null;
}

/** The `[ ] `/`[x] ` prefix at the start of a list item, or null. */
function taskMarker(item: JSONContent): string | null {
  const firstText = firstTextNode(item.content ?? []);
  if (!firstText || typeof firstText.text !== 'string') return null;
  const m = /^\[([ xX])\]\s?/.exec(firstText.text);
  return m ? m[0] : null;
}

function invalidEmbedParagraph(label: string, url: string, raw: string): JSONContent {
  const href = safeHref(url);
  if (href) {
    // An empty label would produce an empty text node, which the schema rejects. Fall back to the
    // URL so the paragraph is never blank (review: valid Markdown must not open blank).
    return {
      type: 'paragraph',
      content: [{ type: 'text', text: label || url, marks: [{ type: 'link', attrs: { href } }] }],
    };
  }
  return { type: 'paragraph', content: [{ type: 'text', text: raw }] };
}

function alignFromToken(t: Token): string | null {
  const style = String(t.attrGet('style') ?? '');
  const m = /text-align:\s*(left|center|right)/i.exec(style);
  return m ? m[1]!.toLowerCase() : null;
}

function parseTable(tokens: Token[], i: number): { node: JSONContent; next: number } {
  const rows: JSONContent[] = [];
  let cells: JSONContent[] = [];
  let j = i + 1;
  while (j < tokens.length) {
    const t = tokens[j]!;
    if (t.type === 'table_close') {
      j++;
      break;
    }
    if (t.type === 'tr_open') {
      cells = [];
      j++;
    } else if (t.type === 'tr_close') {
      rows.push({ type: 'tableRow', content: cells });
      j++;
    } else if (t.type === 'th_open' || t.type === 'td_open') {
      const inline = tokens[j + 1];
      const content = parseInline(inline, true);
      const align = alignFromToken(t);
      cells.push({
        type: t.type === 'th_open' ? 'tableHeader' : 'tableCell',
        ...(align ? { attrs: { align } } : {}),
        content: [{ type: 'paragraph', content }],
      });
      j += 2;
      if (tokens[j]?.type === 'th_close' || tokens[j]?.type === 'td_close') j++;
    } else {
      j++; // thead_open/close, tbody_open/close, stray inline
    }
  }
  return { node: { type: 'table', content: rows }, next: j };
}

function parseStart(t: Token): number {
  const start = Number(t.attrGet('start'));
  return Number.isFinite(start) && start > 0 ? Math.floor(start) : 1;
}

function readBlock(
  tokens: Token[],
  i: number,
): { node: JSONContent | null; next: number; map: Token['map'] } {
  const t = tokens[i]!;
  const map = t.map;
  switch (t.type) {
    case 'paragraph_open': {
      const inline = tokens[i + 1];
      const raw = inline?.content?.trim() ?? '';
      // Raw-source grammar (not a decoded line): an escaped `\::embed` can never become an atom.
      const em = parseEmbedLine(raw);
      if (em) {
        if (parseEmbedUrl(em.url)) {
          return {
            node: { type: 'embed', attrs: { label: em.label, url: em.url } },
            next: i + 3,
            map,
          };
        }
        return { node: invalidEmbedParagraph(em.label, em.url, raw), next: i + 3, map };
      }
      return {
        node: { type: 'paragraph', content: parseInline(inline) },
        next: i + 3,
        map,
      };
    }
    case 'heading_open': {
      const level = clampLevel(parseInt(t.tag.slice(1), 10));
      return {
        node: {
          type: 'heading',
          attrs: { level },
          content: parseInline(tokens[i + 1]),
        },
        next: i + 3,
        map,
      };
    }
    case 'hr':
      return { node: { type: 'horizontalRule' }, next: i + 1, map };
    case 'fence':
    case 'code_block': {
      const language = (t.info ?? '').trim().split(/\s+/)[0] ?? '';
      const text = t.content.replace(/\n$/, '');
      return {
        node: {
          type: 'codeBlock',
          ...(language ? { attrs: { language } } : {}),
          content: text ? [{ type: 'text', text }] : [],
        },
        next: i + 1,
        map,
      };
    }
    case 'blockquote_open': {
      const inner = parseSequence(tokens, i + 1, 'blockquote_close');
      return {
        node: {
          type: 'blockquote',
          content: inner.nodes.length ? inner.nodes : [{ type: 'paragraph', content: [] }],
        },
        next: inner.next,
        map,
      };
    }
    case 'bullet_list_open':
    case 'ordered_list_open': {
      const closeType = t.type.replace('_open', '_close');
      const inner = parseSequence(tokens, i + 1, closeType);
      const items = inner.nodes;
      const markers = t.type === 'bullet_list_open' ? items.map(taskMarker) : [];
      const allTasks =
        t.type === 'bullet_list_open' && items.length > 0 && markers.every((m) => m !== null);
      const node: JSONContent = allTasks
        ? {
            type: 'taskList',
            content: items.map((item, idx) => {
              const firstText = firstTextNode(item.content ?? []);
              const marker = markers[idx]!;
              if (firstText && typeof firstText.text === 'string')
                firstText.text = firstText.text.slice(marker.length);
              return {
                type: 'taskItem',
                attrs: { checked: marker[1]!.toLowerCase() === 'x' },
                content: item.content ?? [],
              };
            }),
          }
        : t.type === 'ordered_list_open'
          ? { type: 'orderedList', attrs: { start: parseStart(t) }, content: items }
          : { type: 'bulletList', content: items };
      return { node, next: inner.next, map };
    }
    case 'list_item_open': {
      const inner = parseSequence(tokens, i + 1, 'list_item_close');
      const content = inner.nodes.length ? inner.nodes : [{ type: 'paragraph', content: [] }];
      return { node: { type: 'listItem', content }, next: inner.next, map };
    }
    case 'table_open':
      return { ...parseTable(tokens, i), map };
    default:
      return { node: null, next: i + 1, map };
  }
}

function parseSequence(
  tokens: Token[],
  start: number,
  stopType?: string,
  maps?: Token['map'][],
): { nodes: JSONContent[]; next: number } {
  const nodes: JSONContent[] = [];
  let i = start;
  while (i < tokens.length) {
    if (stopType && tokens[i]!.type === stopType) return { nodes, next: i + 1 };
    const r = readBlock(tokens, i);
    if (r.node) {
      nodes.push(r.node);
      if (maps) maps.push(r.map);
    }
    i = r.next > i ? r.next : i + 1;
  }
  return { nodes, next: i };
}

/** Drop empty text nodes (ProseMirror rejects them) and keep empty paragraphs (which it allows). */
function stripEmptyText(nodes: JSONContent[]): JSONContent[] {
  const kept: JSONContent[] = [];
  for (const node of nodes) {
    if (node.content) node.content = stripEmptyText(node.content);
    if (node.type === 'text' && (node.text ?? '') === '') continue;
    kept.push(node);
  }
  return kept;
}

/** Character offsets of each source line, used to slice the exact Markdown for each block. */
function lineOffsets(src: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let off = 0;
  for (const line of src.split('\n')) {
    out.push({ start: off, end: off + line.length });
    off += line.length + 1;
  }
  return out;
}

export interface BlockSourcePlan {
  src: string;
  sep: string;
  lead?: string;
}

/**
 * Slice each block's verbatim source from markdown-it's line map. Returns null when any range is
 * invalid or overlaps another: preservation is then dropped for the whole document rather than
 * duplicating or losing text (review: saved output must never contain a block twice).
 */
export function planSourceRanges(
  maps: (Token['map'] | null | undefined)[],
  src: string,
): (BlockSourcePlan | null)[] | null {
  const lines = lineOffsets(src);
  const plans: (BlockSourcePlan | null)[] = [];
  let previousEnd = 0;
  for (let i = 0; i < maps.length; i++) {
    const map = maps[i];
    // A block without a line map cannot be sliced: drop preservation rather than guess a range
    // that could swallow its neighbours.
    if (!map) return null;
    const [s, e] = map;
    if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e <= s) return null;
    if (s >= lines.length || e > lines.length) return null;
    const contentStart = lines[s]!.start;
    const contentEnd = lines[e - 1]!.end;
    if (contentStart < previousEnd || contentEnd < contentStart) return null;
    const nextStart = maps[i + 1] ? (lines[maps[i + 1]![0]!]?.start ?? src.length) : src.length;
    if (nextStart < contentEnd) return null;
    const plan: BlockSourcePlan = {
      src: src.slice(contentStart, contentEnd),
      sep: src.slice(contentEnd, nextStart),
    };
    if (i === 0) plan.lead = src.slice(0, contentStart);
    plans.push(plan);
    previousEnd = contentEnd;
  }
  return plans;
}

/** Attach verbatim source to each top-level block (review: no silent rewrite / no merges). */
function attachSourceMeta(nodes: JSONContent[], maps: Token['map'][], src: string): void {
  const plans = planSourceRanges(maps, src);
  if (!plans) return; // overlapping or invalid ranges: serialise the whole document canonically
  const ids = plans.map((plan, i) => (plan ? `b${i}` : null));
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const plan = plans[i];
    const attrs: Record<string, unknown> = { ...(node.attrs ?? {}) };
    if (plan) {
      attrs.src = plan.src;
      attrs.sep = plan.sep;
      if (plan.lead !== undefined) attrs.lead = plan.lead;
      attrs.blockId = ids[i];
      attrs.prevId = i > 0 ? ids[i - 1] : null;
      attrs.nextId = i + 1 < nodes.length ? ids[i + 1] : null;
    }
    node.attrs = attrs;
  }
}

/** Parse a full Markdown note into a TipTap/ProseMirror JSON document. */
export function markdownToDoc(src: string): JSONContent {
  // Normalise line endings BEFORE parsing and before slicing: markdown-it's token.map counts LF
  // lines, so a CR-only body used to yield overlapping source slices (duplicated tokens/text).
  const text = normaliseLineEndings(src ?? '');
  const tokens = md.parse(text, {});
  const maps: Token['map'][] = [];
  const { nodes } = parseSequence(tokens, 0, undefined, maps);
  const content = stripEmptyText(nodes.length ? nodes : [{ type: 'paragraph', content: [] }]);
  if (nodes.length) attachSourceMeta(content, maps, text);
  else if (content[0]) content[0].attrs = { ...(content[0].attrs ?? {}), lead: text };
  return { type: 'doc', content };
}

/** Parse a plaintext Markdown span into inline nodes (used to restore an uncensored span). */
export function markdownToInline(src: string): JSONContent[] {
  const text = normaliseLineEndings(src ?? '');
  const tokens = md.parseInline(text, {});
  return stripEmptyText(parseInline(tokens.find((t) => t.type === 'inline')));
}

// ---------------------------------------------------------------------------------------------
// ProseMirror JSON -> canonical Markdown
// ---------------------------------------------------------------------------------------------

interface StackMark {
  key: string;
  open: string;
  close: string;
}

/** Marks for one inline node, outer → inner. A stable order makes nested bold/italic re-parse. */
function desiredMarks(node: JSONContent): StackMark[] {
  const marks = node.marks ?? [];
  const has = (type: string) => marks.some((m) => m.type === type);
  const out: StackMark[] = [];
  const link = marks.find((m) => m.type === 'link');
  if (link) {
    const href = serializeHref(String(link.attrs?.href ?? ''));
    const title = link.attrs?.title;
    const tail = `](${href}${typeof title === 'string' && title ? ` "${serializeTitle(title)}"` : ''})`;
    out.push({ key: `link:${href}:${title ?? ''}`, open: '[', close: tail });
  }
  if (has('bold')) out.push({ key: 'bold', open: '**', close: '**' });
  if (has('strike')) out.push({ key: 'strike', open: '~~', close: '~~' });
  if (has('italic')) out.push({ key: 'italic', open: '*', close: '*' });
  return out;
}

/** The literal Markdown for one inline node, before mark delimiters are wrapped around it. */
function pieceFor(node: JSONContent, atLineStart: boolean): string | null {
  switch (node.type) {
    case 'text': {
      const text = node.text ?? '';
      if (!text) return null;
      return (node.marks ?? []).some((m) => m.type === 'code')
        ? serializeCode(text)
        : escapeText(text, atLineStart);
    }
    case 'censored':
      return isValidCensorToken(node.attrs?.token)
        ? String(node.attrs.token)
        : CENSORED_PLACEHOLDER;
    case 'noteImage':
      return `![${escapeLabel(String(node.attrs?.alt ?? ''))}](${NOTE_FILE_PREFIX}${isValidNoteFileId(node.attrs?.id) ? node.attrs.id : ''})`;
    case 'fileChip':
      return `[${escapeLabel(String(node.attrs?.name ?? ''))}](${NOTE_FILE_PREFIX}${isValidNoteFileId(node.attrs?.id) ? node.attrs.id : ''})`;
    case 'internalChip':
      return `[${escapeLabel(String(node.attrs?.label ?? ''))}](bokydo:${node.attrs?.kind === 'task' ? 'task' : 'note'}/${isValidNoteFileId(node.attrs?.id) ? node.attrs.id : ''})`;
    default:
      return typeof node.text === 'string' && node.text ? escapeText(node.text, atLineStart) : null;
  }
}

/**
 * A mark-stack serializer: instead of wrapping each text node independently (which breaks nested
 * bold+italic, e.g. `**a *b* c**`), we keep marks open across runs and only emit delimiters when
 * the active mark set changes. Review fix: mixed bold/italic and overlapping marks round-trip.
 */
function serializeInline(nodes: JSONContent[] = [], inCell = false): string {
  let out = '';
  let atLineStart = true;
  const stack: StackMark[] = [];
  const applyMarks = (desired: StackMark[]): void => {
    let prefix = 0;
    while (
      prefix < stack.length &&
      prefix < desired.length &&
      stack[prefix]!.key === desired[prefix]!.key
    )
      prefix++;
    while (stack.length > prefix) out += stack.pop()!.close;
    for (let i = prefix; i < desired.length; i++) {
      const mark = desired[i]!;
      out += mark.open;
      stack.push(mark);
    }
  };
  for (const node of nodes) {
    if (node.type === 'hardBreak') {
      // A GFM table row cannot contain a newline, so a break in a cell is written as `<br>`
      // (parsed back by the raw-source `<br>` scan with the same escape rules).
      out += inCell ? '<br>' : '\\\n';
      atLineStart = !inCell;
      continue; // keep marks open across a hard break
    }
    const piece = pieceFor(node, atLineStart);
    if (piece === null) continue;
    applyMarks(desiredMarks(node));
    out += piece;
    atLineStart = piece.endsWith('\n');
  }
  while (stack.length) out += stack.pop()!.close;
  return out;
}

function serializeCell(cell: JSONContent): string {
  const inner = cell.content?.[0]?.content ?? [];
  return (
    serializeInline(inner, true)
      // A pipe must be escaped in a GFM cell even inside a code span; markdown-it unescapes `\|`
      // before inline parsing, so `` `x\|y` `` round-trips to a code span containing `x|y`.
      .replace(/\\?\|/g, (m) => (m === '\\|' ? m : '\\|'))
      .replace(/\r?\n/g, ' ')
  );
}

function serializeAlignSep(node: JSONContent | undefined): string {
  const raw = node?.attrs?.align;
  const align = raw === 'left' || raw === 'center' || raw === 'right' ? (raw as string) : null;
  if (align === 'left') return ':---';
  if (align === 'right') return '---:';
  if (align === 'center') return ':---:';
  return '---';
}

function serializeTable(node: JSONContent): string {
  const rows = node.content ?? [];
  if (!rows.length) return '';
  const colCount = (rows[0]!.content ?? []).length;
  if (!colCount) return '';
  const line = (cells: string[]) => {
    const padded = [...cells];
    while (padded.length < colCount) padded.push('');
    return `| ${padded.slice(0, colCount).join(' | ')} |`;
  };
  const cellsOf = (row: JSONContent) => (row.content ?? []).map(serializeCell);
  const header = rows[0]!.content ?? [];
  const out = [
    line(cellsOf(rows[0]!)),
    `| ${Array.from({ length: colCount }, (_, i) => serializeAlignSep(header[i])).join(' | ')} |`,
  ];
  for (let i = 1; i < rows.length; i++) out.push(line(cellsOf(rows[i]!)));
  return out.join('\n');
}

function listLines(node: JSONContent, baseIndent: string): string[] {
  const kind = node.type;
  const start = kind === 'orderedList' ? Number(node.attrs?.start ?? 1) || 1 : 1;
  const lines: string[] = [];
  const items = node.content ?? [];
  items.forEach((item, idx) => {
    let marker: string;
    if (kind === 'taskList') marker = item.attrs?.checked ? '- [x] ' : '- [ ] ';
    else if (kind === 'orderedList') marker = `${start + idx}. `;
    else marker = '- ';
    const blocks = item.content?.length ? item.content : [{ type: 'paragraph', content: [] }];
    const contIndent = baseIndent + ' '.repeat(marker.length);
    const firstLines = serializeBlock(blocks[0]!).split('\n');
    lines.push(baseIndent + marker + (firstLines[0] ?? ''));
    for (let k = 1; k < firstLines.length; k++) lines.push(contIndent + firstLines[k]);
    for (let j = 1; j < blocks.length; j++) {
      const b = blocks[j]!;
      if (b.type === 'bulletList' || b.type === 'orderedList' || b.type === 'taskList') {
        lines.push(...listLines(b, contIndent));
      } else {
        // A blank line makes the item a *loose* list, keeping its multiple paragraphs distinct
        // instead of merging them into one paragraph with a soft break (review: loose lists).
        lines.push('');
        for (const l of serializeBlock(b).split('\n')) lines.push(contIndent + l);
      }
    }
  });
  return lines;
}

function serializeBlock(node: JSONContent): string {
  switch (node.type) {
    case 'paragraph': {
      const body = serializeInline(node.content);
      // A paragraph that would re-parse as an `::embed[…](…)` atom must stay a literal paragraph.
      return body.replace(/^(::embed\[)/, '\\$1');
    }
    case 'heading': {
      const level = clampLevel(Number(node.attrs?.level ?? 1));
      return `${'#'.repeat(level)} ${serializeInline(node.content)}`;
    }
    case 'codeBlock': {
      const language =
        typeof node.attrs?.language === 'string'
          ? (node.attrs.language.trim().split(/\s+/)[0] ?? '')
          : '';
      const text = (node.content ?? [])
        .map((n) => n.text ?? '')
        .join('')
        .replace(/\n$/, '');
      const fence = codeFence(text);
      return `${fence}${language}\n${text}\n${fence}`;
    }
    case 'blockquote': {
      const inner = serializeBlocks(node.content ?? []);
      return inner
        .split('\n')
        .map((l) => (l ? `> ${l}` : '>'))
        .join('\n');
    }
    case 'horizontalRule':
      return '---';
    case 'bulletList':
    case 'orderedList':
    case 'taskList':
      return listLines(node, '').join('\n');
    case 'table':
      return serializeTable(node);
    case 'embed': {
      const label = String(node.attrs?.label ?? '');
      const url = String(node.attrs?.url ?? '');
      return isValidEmbedUrl(url) ? formatEmbedLine(label, url) : label || url;
    }
    case 'noteUpload':
      return ''; // transient upload placeholder is never persisted to Markdown
    default:
      return '';
  }
}

/** Pure serialization from node content (no source preservation) — used for clipboard slices. */
function serializeBlocks(nodes: JSONContent[]): string {
  return nodes
    .map(serializeBlock)
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/**
 * A JSON value with bookkeeping attributes and empty containers dropped, so equality means "same
 * document" regardless of whether ProseMirror materialised a default attribute or an empty array.
 * Attr keys are sorted, so key order can never make two equal documents look different.
 */
function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    const list = value.map(canonicalValue);
    return list.length ? list : undefined;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      if (SOURCE_META_ATTRS.has(key) || TRANSIENT_ATTRS.has(key)) continue;
      // ProseMirror materialises its table-cell defaults in getJSON(); the parsed JSON leaves
      // them out. They are not content, so they must not make an untouched table "changed".
      const raw = (value as Record<string, unknown>)[key];
      if ((key === 'colspan' || key === 'rowspan') && raw === 1) continue;
      const child = canonicalValue(raw);
      if (child === undefined || child === null || child === '') continue;
      out[key] = child;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return value;
}

/** A block's JSON without bookkeeping attributes, as a stable string for exact comparison. */
export function canonicalBlockJson(node: JSONContent): string {
  return JSON.stringify(
    canonicalValue({
      type: node.type,
      text: node.text,
      attrs: node.attrs,
      marks: node.marks,
      content: node.content,
    }),
  );
}

// Parsing a block's own source to prove it unchanged is pure and can be repeated on every
// keystroke, so results (and their canonical form) are cached by source string. The cache is
// dropped wholesale once it grows past a small budget, keeping memory bounded for a hostile
// 512 KiB document.
interface ParsedSource {
  node: JSONContent | null;
  canonical: string | null;
}

const sourceParseCache = new Map<string, ParsedSource>();
const SOURCE_PARSE_CACHE_LIMIT = 128;
const SOURCE_PARSE_CACHE_CHARS = 2 * 1024 * 1024;
let sourceParseCacheChars = 0;

function parseBlockSource(src: string): ParsedSource | null {
  const cached = sourceParseCache.get(src);
  if (cached) return cached;
  const doc = markdownToDoc(src);
  const blocks = doc.content ?? [];
  const node = blocks.length === 1 ? blocks[0]! : null;
  const parsed: ParsedSource = {
    node,
    canonical: node === null ? null : canonicalBlockJson(node),
  };
  if (sourceParseCacheChars + src.length > SOURCE_PARSE_CACHE_CHARS) {
    sourceParseCache.clear();
    sourceParseCacheChars = 0;
  }
  if (sourceParseCache.size >= SOURCE_PARSE_CACHE_LIMIT) {
    sourceParseCache.clear();
    sourceParseCacheChars = 0;
  }
  sourceParseCache.set(src, parsed);
  sourceParseCacheChars += src.length;
  return parsed;
}

/**
 * Whether a top-level block still matches its captured source exactly. The stored `src` is parsed
 * again and compared recursively (content, marks with attrs, meaningful node attrs) instead of
 * comparing a lossy serialisation or its hash: an edit the serialiser cannot express still makes
 * the block "changed", so its source is never re-emitted over the edit.
 */
export function blockPreservesSource(block: JSONContent): boolean {
  const src = block.attrs?.src;
  if (typeof src !== 'string') return false;
  const parsed = parseBlockSource(src);
  if (!parsed || parsed.canonical === null) return false;
  return canonicalBlockJson(block) === parsed.canonical;
}

/** The separator to emit after block `index`: stored whitespace only for the same neighbour. */
function boundaryAfter(blocks: JSONContent[], index: number, preserved: boolean): string {
  const block = blocks[index]!;
  const last = index === blocks.length - 1;
  if (preserved) {
    const { sep, nextId } = (block.attrs ?? {}) as Record<string, unknown>;
    if (!last) {
      // Both sides must still name each other: a block inserted (or pasted) between them breaks
      // the pair even if one id happens to match.
      const next = blocks[index + 1]!;
      const stillNeighbours =
        nextId != null &&
        next.attrs?.blockId === nextId &&
        next.attrs?.prevId === block.attrs?.blockId;
      if (stillNeighbours && typeof sep === 'string') return sep;
    } else if (nextId === null && typeof sep === 'string') {
      return sep; // the block was last at parse time and still is: keep its trailing whitespace
    }
  }
  return last ? '' : '\n\n';
}

/**
 * Serialize a ProseMirror JSON document to Markdown. Each unchanged top-level block is emitted
 * verbatim from its captured `attrs.src`; edited blocks are re-serialized. Separators are reused
 * only between the same neighbours they were measured between, so an inserted or deleted block
 * can never merge two survivors (review: "first" + Enter + "second" must be two paragraphs).
 */
export function docToMarkdown(doc: JSONContent): string {
  const blocks = doc.content ?? [];
  if (!blocks.length) return '';
  let out = '';
  const first = blocks[0]!;
  const lead = first.attrs?.lead;
  if (typeof lead === 'string' && (first.attrs?.prevId == null || first.attrs?.src == null))
    out += lead;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const preserved = blockPreservesSource(block);
    out += preserved ? String(block.attrs!.src) : serializeBlock(block);
    out += boundaryAfter(blocks, i, preserved);
  }
  return out;
}

/**
 * Serialize a Fragment/slice JSON (as produced by `Fragment.toJSON()`) to Markdown. An empty
 * fragment serialises to `null`, so the input may be null.
 */
export function contentToMarkdown(nodes: JSONContent[] | null | undefined): string {
  const list = nodes ?? [];
  const allInline = list.every((n) => INLINE_TYPES.has(n.type ?? ''));
  return allInline ? serializeInline(list) : serializeBlocks(list);
}

// ---------------------------------------------------------------------------------------------
// Clipboard HTML sanitising (defence in depth on top of ProseMirror's schema)
// ---------------------------------------------------------------------------------------------

const REMOVE_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'link',
  'meta',
  'base',
  'svg',
  'math',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'option',
  'video',
  'audio',
  'source',
  'track',
  'template',
  'frame',
  'frameset',
  'applet',
  'marquee',
  'canvas',
  'noscript',
]);

const MAX_TABLE_COLS = 50;
const MAX_TABLE_ROWS = 2000;

/** Only these attributes may survive on a data-tagged note chip. */
function sanitizeElement(el: Element): void {
  const tag = el.tagName.toLowerCase();
  for (const attr of Array.from(el.attributes)) {
    const name = attr.name.toLowerCase();
    const unsafeName =
      name.startsWith('on') ||
      name === 'style' ||
      name === 'srcdoc' ||
      name === 'srcset' ||
      name === 'formaction' ||
      name === 'xlink:href' ||
      name === 'data-pm-slice' ||
      ((tag === 'td' || tag === 'th') &&
        (name === 'colspan' ||
          name === 'rowspan' ||
          name === 'colwidth' ||
          name === 'data-colwidth'));
    if (unsafeName) {
      el.removeAttribute(attr.name);
    } else if (tag === 'img' && !['src', 'alt', 'data-note-image', 'data-id'].includes(name)) {
      el.removeAttribute(attr.name);
    } else if (
      (tag === 'a' || tag === 'span' || tag === 'div') &&
      ![
        'href',
        'title',
        'data-file-chip',
        'data-internal-chip',
        'data-censored',
        'data-embed',
        'data-kind',
        'data-id',
        'data-label',
        'data-token',
        'data-url',
        'target',
        'rel',
        'download',
      ].includes(name) &&
      !name.startsWith('data-')
    ) {
      el.removeAttribute(attr.name);
    }
  }
}

/**
 * ProseMirror parses pasted HTML by assigning it to innerHTML, so a hostile `<img onerror>` could
 * otherwise fire while being parsed. DOMParser creates an inert document (no resource loads, no
 * script execution); we strip dangerous tags/attributes and validate every chip attribute before
 * ProseMirror ever sees the HTML. The schema's parseHTML rules validate again.
 */
export function sanitizeClipboardHtml(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const elements = Array.from(doc.body.querySelectorAll('*'));
  for (const el of elements) {
    const tag = el.tagName.toLowerCase();
    if (REMOVE_TAGS.has(tag)) {
      el.remove();
      continue;
    }
    sanitizeElement(el);

    if (tag === 'img') {
      const src = el.getAttribute('src') ?? '';
      const match = NOTE_FILE_SRC_RE.exec(src);
      if (
        !isValidNoteFileId(el.getAttribute('data-id')) ||
        !match ||
        !el.hasAttribute('data-note-image')
      ) {
        el.remove();
      } else {
        el.setAttribute('data-id', match[1]!);
      }
      continue;
    }
    if (tag === 'a' && el.hasAttribute('data-file-chip')) {
      if (!isValidNoteFileId(el.getAttribute('data-id'))) el.removeAttribute('data-file-chip');
    }
    if (tag === 'span' && el.hasAttribute('data-internal-chip')) {
      if (!isValidInternalChip(el.getAttribute('data-kind'), el.getAttribute('data-id')))
        el.removeAttribute('data-internal-chip');
    }
    if (tag === 'span' && el.hasAttribute('data-censored')) {
      if (!isValidCensorToken(el.getAttribute('data-token'))) el.removeAttribute('data-censored');
    }
    if (tag === 'div' && el.hasAttribute('data-embed')) {
      if (!isValidEmbedUrl(el.getAttribute('data-url'))) el.removeAttribute('data-embed');
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') ?? '';
      if (href && classifyHref(href).kind === 'unsafe') el.removeAttribute('href');
    }
  }

  // Bound pasted tables: strip spans, then cap columns/rows so a hostile blob can't blow up layout.
  for (const table of Array.from(doc.body.querySelectorAll('table'))) {
    const rows = Array.from(table.querySelectorAll('tr'));
    for (let r = MAX_TABLE_ROWS; r < rows.length; r++) rows[r]!.remove();
    for (const row of Array.from(table.querySelectorAll('tr'))) {
      const cells = Array.from(row.querySelectorAll('td,th'));
      for (let c = MAX_TABLE_COLS; c < cells.length; c++) cells[c]!.remove();
    }
  }
  return doc.body.innerHTML;
}
