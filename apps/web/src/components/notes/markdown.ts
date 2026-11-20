/* eslint-disable @typescript-eslint/no-non-null-assertion --
   Index access below is bounds-checked by the surrounding loop/length conditions. */
import { safeHref } from '@bokydo/shared';
import type { JSONContent } from '@tiptap/core';
import MarkdownIt, { type Env, type StateBlock, type StateInline, type Token } from 'markdown-it';
import { parseToken } from '../../lib/censor.js';
import { formatEmbedLine, parseEmbedLine, parseEmbedUrl } from './embed.js';
import {
  SOURCE_META_ATTRS as SOURCE_META_ATTRS_LIST,
  TRANSIENT_ATTRS as TRANSIENT_ATTRS_LIST,
} from './source-meta.js';

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
/** Sticky: the inline rule asks whether the token starts exactly at the cursor. */
const CENSOR_AT = new RegExp(CENSOR_BODY, 'y');

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
  // A literal `!` directly before `[` is escaped even though `[` is escaped too: the pair must
  // never read back as an image marker (`![alt](url)`). The escape runs after the general pass so
  // the backslash it inserts is not itself escaped.
  let out = text.replace(ESCAPE_ALWAYS, '\\$&').replace(/!(?=\\\[)/g, '\\!');
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
 * document content, so block equality ignores them. The list itself lives in `source-meta.ts` so
 * the clipboard/drop guards strip exactly the same names.
 */
const SOURCE_META_ATTRS = new Set<string>(SOURCE_META_ATTRS_LIST);
/** Editor-only attributes (e.g. Remove-censor's transient id); never persisted, never compared. */
const TRANSIENT_ATTRS = new Set<string>(TRANSIENT_ATTRS_LIST);

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
 * Censor tokens are a markdown-it INLINE rule, not a private-use sentinel substituted into the
 * source: the parser's own escape, code-span and link rules run first, so an escaped
 * `\{\{censored…` and a token inside a code span or a link destination can never be promoted,
 * while a token in ordinary (or link-label) text becomes an atom exactly where it stands.
 */
function censorTokenRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x7b /* { */) return false;
  if (state.src.charCodeAt(state.pos + 1) !== 0x7b) return false;
  CENSOR_AT.lastIndex = state.pos;
  const match = CENSOR_AT.exec(state.src);
  if (!match || match.index !== state.pos) return false;
  const token = match[0];
  if (state.pos + token.length > state.posMax) return false;
  // Shape alone is not enough: strict parseToken checks the salt/IV/ciphertext sizes.
  if (!isValidCensorToken(token)) return false;
  if (!silent) {
    const node = state.push('censored', 'span', 0);
    node.content = token;
    node.markup = '{{censored:';
  }
  state.pos += token.length;
  return true;
}

/**
 * `<br>` inside a GFM table cell is a hard break (a table row cannot hold a newline). The rule is
 * enabled only for the inline parse of a cell through the shared env, so `<br>` anywhere else
 * stays literal text. Escapes are handled by the `escape` rule, and code spans by `backticks`,
 * both of which run before this one.
 */
function cellHardBreakRule(state: StateInline, silent: boolean): boolean {
  const env = state.env as Env & { inTableCell?: boolean };
  if (!env.inTableCell) return false;
  if (state.src.charCodeAt(state.pos) !== 0x3c /* < */) return false;
  const match = /^<br\s*\/?>/i.exec(state.src.slice(state.pos, state.posMax));
  if (!match) return false;
  if (!silent) state.push('hardbreak', 'br', 0);
  state.pos += match[0].length;
  return true;
}

/**
 * A `::embed[label](url)` line as a BLOCK rule. Escaped `\::embed` never matches (the backslash is
 * the line's first character); a line that is part of a longer paragraph is left to the paragraph
 * rule, so the atom only forms when the line stands alone.
 */
function embedBlockRule(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  if (state.sCount[startLine]! - state.blkIndent >= 4) return false; // indented code
  const start = state.bMarks[startLine]! + state.tShift[startLine]!;
  const max = state.eMarks[startLine]!;
  if (start >= max) return false;
  const raw = state.src.slice(start, max);
  if (!raw.startsWith('::embed[')) return false;
  const parsed = parseEmbedLine(raw);
  if (!parsed) return false;
  // A lazy continuation line means this is a paragraph, not a standalone atom.
  if (startLine + 1 < endLine) {
    const line = startLine + 1;
    const nextStart = state.bMarks[line]! + state.tShift[line]!;
    if (state.sCount[line]! - state.blkIndent < 4 && nextStart < state.eMarks[line]!) return false;
  }
  if (silent) return true;
  const token = state.push('embed', 'div', 0);
  token.map = [startLine, startLine + 1];
  // A non-allow-listed URL is still recognised as an embed *line*; readBlock turns it into the
  // same safe-link paragraph the old raw-source grammar produced (ADR 0025: "shown as a link").
  token.meta = {
    label: parsed.label,
    url: parsed.url,
    raw,
  };
  token.markup = '::embed';
  state.line = startLine + 1;
  return true;
}

md.inline.ruler.before('emphasis', 'censor', censorTokenRule);
md.inline.ruler.before('html_inline', 'cellHardBreak', cellHardBreakRule);
md.block.ruler.before('paragraph', 'embed', embedBlockRule, {
  alt: ['paragraph', 'reference', 'blockquote', 'list'],
});

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
    // A chip label is a string attribute, so a censor token in it stays literal token text (it
    // is still encrypted; the chip renders the label, never decrypts). Dropping it would lose
    // the token on save.
    if (t.type === 'text' || t.type === 'code_inline' || t.type === 'censored') label += t.content;
    else if (t.type === 'softbreak' || t.type === 'hardbreak') label += ' ';
  }
  return label;
}

function withMarks(marks: Mark[]): { marks: Mark[] } | Record<string, never> {
  return marks.length ? { marks: [...marks] } : {};
}

function parseInlineChildren(children: Token[], initialMarks: Mark[] = []): JSONContent[] {
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
        pushText(t.content);
        i++;
        break;
      case 'censored':
        out.push({ type: 'censored', attrs: { token: t.content }, ...withMarks(marks) });
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
        // reload as an atom either); markdown-it already kept it out of the censor rule.
        out.push({
          type: 'text',
          text: t.content,
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
          const label = labelFromInline(inner);
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
          out.push(...parseInlineChildren(inner, [...marks, linkMark]));
        } else {
          out.push(...parseInlineChildren(inner, marks));
        }
        i = next;
        break;
      }
      case 'image': {
        const src = String(t.attrGet('src') ?? '');
        // A token can only reach here from inside an image's label; keep it as literal text.
        const alt = t.content;
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
 * Inline nodes for one block. Censor tokens and table-cell breaks are markdown-it rules, so the
 * parser's own escapes/code spans/references apply. `inCell` re-parses the raw cell source with
 * `inTableCell` in the shared env, which is what enables the `<br>` rule there.
 */
function parseInline(inline: Token | undefined, inCell = false, env: Env = {}): JSONContent[] {
  if (inline?.type !== 'inline') return [];
  const raw = inline.content ?? '';
  if (inCell && raw.toLowerCase().includes('<br')) {
    const cellEnv: Env = { ...env, inTableCell: true };
    const cell = md.parseInline(raw, cellEnv).find((token) => token.type === 'inline');
    return stripEmptyText(parseInlineChildren(cell?.children ?? []));
  }
  return stripEmptyText(parseInlineChildren(inline.children ?? []));
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

function parseTable(tokens: Token[], i: number, env: Env): { node: JSONContent; next: number } {
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
      const content = parseInline(inline, true, env);
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
  env: Env,
): { node: JSONContent | null; next: number; map: Token['map'] } {
  const t = tokens[i]!;
  const map = t.map;
  switch (t.type) {
    case 'paragraph_open': {
      const inline = tokens[i + 1];
      return {
        node: { type: 'paragraph', content: parseInline(inline, false, env) },
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
      const inner = parseSequence(tokens, i + 1, 'blockquote_close', undefined, env);
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
      const inner = parseSequence(tokens, i + 1, closeType, undefined, env);
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
      const inner = parseSequence(tokens, i + 1, 'list_item_close', undefined, env);
      const content = inner.nodes.length ? inner.nodes : [{ type: 'paragraph', content: [] }];
      return { node: { type: 'listItem', content }, next: inner.next, map };
    }
    case 'table_open':
      return { ...parseTable(tokens, i, env), map };
    case 'embed': {
      const meta = (t.meta ?? {}) as { label?: unknown; url?: unknown; raw?: unknown };
      const label = typeof meta.label === 'string' ? meta.label : '';
      const url = typeof meta.url === 'string' ? meta.url : '';
      const raw = typeof meta.raw === 'string' ? meta.raw : formatEmbedLine(label, url);
      // The block rule only marks allow-listed URLs as `valid`; this is defence in depth so a
      // future rule change cannot create a node the renderer refuses.
      return {
        node: parseEmbedUrl(url)
          ? { type: 'embed', attrs: { label, url } }
          : invalidEmbedParagraph(label, url, raw),
        next: i + 1,
        map,
      };
    }
    default:
      return { node: null, next: i + 1, map };
  }
}

function parseSequence(
  tokens: Token[],
  start: number,
  stopType?: string,
  maps?: Token['map'][],
  env: Env = {},
): { nodes: JSONContent[]; next: number } {
  const nodes: JSONContent[] = [];
  let i = start;
  while (i < tokens.length) {
    if (stopType && tokens[i]!.type === stopType) return { nodes, next: i + 1 };
    const r = readBlock(tokens, i, env);
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
  const env: Env = {};
  const tokens = md.parse(text, env);
  const maps: Token['map'][] = [];
  const { nodes } = parseSequence(tokens, 0, undefined, maps, env);
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
  /** Whether `desired` would open a link mark from the current stack. */
  const opensLink = (desired: StackMark[]): boolean => {
    let prefix = 0;
    while (
      prefix < stack.length &&
      prefix < desired.length &&
      stack[prefix]!.key === desired[prefix]!.key
    )
      prefix++;
    return desired.slice(prefix).some((mark) => mark.key.startsWith('link:'));
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
    const marks = desiredMarks(node);
    // A literal `!` that ends the previous run would turn an immediately following `[label](url)`
    // into an image. Escape it at the node boundary as well as inside one text node.
    if (out.endsWith('!') && opensLink(marks)) out = `${out.slice(0, -1)}\\!`;
    applyMarks(marks);
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

/** Two physically distinct list markers, so adjacent lists of one family never merge. */
type ListMarker = 'a' | 'b';
type ListFamily = 'bullet' | 'ordered';

function flipMarker(marker: ListMarker): ListMarker {
  return marker === 'a' ? 'b' : 'a';
}

function listFamily(node: JSONContent | undefined): ListFamily | null {
  if (!node) return null;
  if (node.type === 'orderedList') return 'ordered';
  if (node.type === 'bulletList' || node.type === 'taskList') return 'bullet';
  return null;
}

function listLines(node: JSONContent, baseIndent: string, marker: ListMarker = 'a'): string[] {
  const kind = node.type;
  const start = kind === 'orderedList' ? Number(node.attrs?.start ?? 1) || 1 : 1;
  const lines: string[] = [];
  const items = node.content ?? [];
  items.forEach((item, idx) => {
    let itemMarker: string;
    if (kind === 'taskList')
      itemMarker = `${marker === 'b' ? '*' : '-'} [${item.attrs?.checked ? 'x' : ' '}] `;
    else if (kind === 'orderedList') itemMarker = `${start + idx}${marker === 'b' ? ')' : '.'} `;
    else itemMarker = `${marker === 'b' ? '*' : '-'} `;
    const blocks = item.content?.length ? item.content : [{ type: 'paragraph', content: [] }];
    const contIndent = baseIndent + ' '.repeat(itemMarker.length);
    const firstLines = serializeBlock(blocks[0]!).split('\n');
    lines.push(baseIndent + itemMarker + (firstLines[0] ?? ''));
    for (let k = 1; k < firstLines.length; k++) lines.push(contIndent + firstLines[k]);
    // Adjacent nested lists of the same family alternate their marker too (inside one item there
    // is no blank line between them, so a repeated marker would merge them on the next load).
    let previousFamily = listFamily(blocks[0]);
    let previousMarker: ListMarker = 'a';
    for (let j = 1; j < blocks.length; j++) {
      const b = blocks[j]!;
      const family = listFamily(b);
      const nestedMarker: ListMarker =
        family !== null && family === previousFamily ? flipMarker(previousMarker) : 'a';
      if (family !== null) {
        lines.push(...listLines(b, contIndent, nestedMarker));
      } else {
        // A blank line makes the item a *loose* list, keeping its multiple paragraphs distinct
        // instead of merging them into one paragraph with a soft break (review: loose lists).
        lines.push('');
        for (const l of serializeBlock(b).split('\n')) lines.push(contIndent + l);
      }
      previousFamily = family;
      previousMarker = nestedMarker;
    }
  });
  return lines;
}

function serializeBlock(node: JSONContent, marker: ListMarker = 'a'): string {
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
      const text = (node.content ?? []).map((n) => n.text ?? '').join('');
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
      return listLines(node, '', marker).join('\n');
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

/**
 * Pure serialization from node content (no source preservation). Adjacent lists of the same
 * family always get a different bullet/delimiter character, because `- a` followed by `- b` (with
 * or without a blank line) is one list on the next load.
 */
function serializeBlocks(nodes: JSONContent[]): string {
  const out: string[] = [];
  let previousFamily: ListFamily | null = null;
  let previousMarker: ListMarker = 'a';
  for (const node of nodes) {
    const family = listFamily(node);
    const marker: ListMarker =
      family !== null && family === previousFamily ? flipMarker(previousMarker) : 'a';
    const text = serializeBlock(node, marker);
    if (text.length > 0) out.push(text);
    previousFamily = family;
    previousMarker = marker;
  }
  return out.join('\n\n');
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

/** Adjacent text nodes with equal marks are one text run to Markdown; merge them for equality. */
function marksKey(node: JSONContent): string {
  return JSON.stringify(node.marks ?? []);
}

function mergeAdjacentText(node: JSONContent): JSONContent {
  const copy: JSONContent = { ...node };
  if (node.content) {
    const merged: JSONContent[] = [];
    for (const child of node.content) {
      const next = mergeAdjacentText(child);
      const previous = merged[merged.length - 1];
      if (
        next.type === 'text' &&
        previous?.type === 'text' &&
        marksKey(previous) === marksKey(next)
      ) {
        merged[merged.length - 1] = {
          ...previous,
          text: `${previous.text ?? ''}${next.text ?? ''}`,
        };
      } else {
        merged.push(next);
      }
    }
    copy.content = merged;
  }
  return copy;
}

/** A block's JSON without bookkeeping attributes, as a stable string for exact comparison. */
export function canonicalBlockJson(node: JSONContent): string {
  const normalised = mergeAdjacentText(node);
  return JSON.stringify(
    canonicalValue({
      type: normalised.type,
      text: normalised.text,
      attrs: normalised.attrs,
      marks: normalised.marks,
      content: normalised.content,
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

/** Non-whitespace lines in a stored separator: link reference definitions, which parse to no block. */
function definitionLines(sep: unknown): string[] {
  if (typeof sep !== 'string' || sep.trim() === '') return [];
  return sep.split('\n').filter((line) => line.trim() !== '');
}

/** A separator that keeps any reference definitions the stored separator carried. */
function withDefinitions(sep: unknown): string {
  const defs = definitionLines(sep);
  return defs.length ? `\n\n${defs.join('\n')}\n\n` : '\n\n';
}

/**
 * The separator to emit after block `index`. The stored separator may only be reused when BOTH
 * neighbours are unchanged: a table followed by a line without a blank line swallows it as a row,
 * and two same-family lists on consecutive lines are one list. Review round 3 (H4): the next block
 * must be preserved too, and a table is always followed by a blank line.
 */
function boundaryAfter(blocks: JSONContent[], index: number, preserved: boolean): string {
  const block = blocks[index]!;
  const last = index === blocks.length - 1;
  const next = last ? null : blocks[index + 1]!;
  const { sep, nextId } = (block.attrs ?? {}) as Record<string, unknown>;
  const stored = typeof sep === 'string' ? sep : null;
  if (preserved && stored !== null) {
    if (last) {
      // The block was last at parse time and still is: keep its trailing whitespace (and any
      // reference definitions that follow it), even if it was edited — they are invisible to the
      // document and must survive, or existing reference links stop resolving.
      if (nextId === null) return stored;
    } else {
      // Both sides must still name each other AND still match their own source; a block inserted
      // or edited between them breaks the pair even if one id happens to match.
      const stillNeighbours =
        nextId != null &&
        next!.attrs?.blockId === nextId &&
        next!.attrs?.prevId === block.attrs?.blockId;
      // A table keeps swallowing lines until a blank one (even a heading becomes a row), so it is
      // only safe to reuse its separator when the stored separator has a blank line in it.
      const safeNeighbour = block.type !== 'table' || /\n\s*\n/.test(stored);
      if (stillNeighbours && safeNeighbour && blockPreservesSource(next!)) return stored;
    }
  }
  if (last) {
    // A trailing reference definition is not part of any block: keep it even when the last block
    // changed, so links that resolve today never turn into literal Markdown on the next load.
    return definitionLines(stored).length ? `\n\n${definitionLines(stored).join('\n')}` : '';
  }
  return withDefinitions(stored);
}

/**
 * Serialize a ProseMirror JSON document to Markdown. Each unchanged top-level block is emitted
 * verbatim from its captured `attrs.src`; edited blocks are re-serialized. Separators are reused
 * only between the same unchanged neighbours they were measured between, so an inserted, deleted
 * or edited block can never merge two survivors (review: "first" + Enter + "second" must be two
 * paragraphs).
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

/** Every reference-definition line carried by the document's preserved separators, in order. */
function documentDefinitions(blocks: JSONContent[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const block of blocks) {
    const attrs = (block.attrs ?? {}) as Record<string, unknown>;
    for (const line of [...definitionLines(attrs.lead), ...definitionLines(attrs.sep)]) {
      if (!seen.has(line)) {
        seen.add(line);
        out.push(line);
      }
    }
  }
  return out;
}

/** Serialize with NO source preservation, keeping reference definitions at the end. */
function serializeFreshDoc(doc: JSONContent): string {
  const blocks = doc.content ?? [];
  const body = serializeBlocks(blocks);
  const defs = documentDefinitions(blocks);
  return defs.length ? (body ? `${body}\n\n${defs.join('\n')}` : defs.join('\n')) : body;
}

/** A whole-document JSON value without bookkeeping attributes, for exact equivalence. */
export function canonicalDocJson(doc: JSONContent): string {
  const normalised = mergeAdjacentText(doc);
  return JSON.stringify(
    canonicalValue({
      type: normalised.type,
      text: normalised.text,
      attrs: normalised.attrs,
      marks: normalised.marks,
      content: normalised.content,
    }),
  );
}

/** Whether two documents hold the same content, ignoring source-meta and transient attributes. */
export function docsEquivalent(a: JSONContent, b: JSONContent): boolean {
  return canonicalDocJson(a) === canonicalDocJson(b);
}

export interface VerifiedDocMarkdown {
  markdown: string;
  /** The preserved serialisation did not re-parse to the same document; the fresh one was used. */
  fallback: boolean;
  /** Even the fresh serialisation differs: a serializer bug. Kept, but flagged for tests. */
  mismatch: boolean;
}

/** Test-visible counters; `mismatch` means the fallback serializer itself lost content. */
export const serializationStats = { attempts: 0, fallback: 0, mismatch: 0 };

export function resetSerializationStats(): void {
  serializationStats.attempts = 0;
  serializationStats.fallback = 0;
  serializationStats.mismatch = 0;
}

function reparsesTo(markdown: string, doc: JSONContent): boolean {
  try {
    return docsEquivalent(markdownToDoc(markdown), doc);
  } catch {
    return false;
  }
}

/**
 * Review round 3 (H4b): always re-parse what is about to be saved and compare it to the editor
 * document. If the source-preserving serialisation changed structure (a swallowed table row, two
 * merged lists, a lost reference definition) re-serialise the whole document with NO preservation;
 * if even that differs, keep it but log a dev warning and count it, so the serializer bug is
 * visible to tests instead of silently corrupting a save. Runs off the keystroke path: the page's
 * `preparePatch` hook calls it on the autosave debounce and before every keepalive PATCH.
 */
export function verifyDocMarkdown(
  doc: JSONContent,
  first: string = docToMarkdown(doc),
): VerifiedDocMarkdown {
  serializationStats.attempts += 1;
  if (reparsesTo(first, doc)) return { markdown: first, fallback: false, mismatch: false };
  serializationStats.fallback += 1;
  const fresh = serializeFreshDoc(doc);
  if (reparsesTo(fresh, doc)) return { markdown: fresh, fallback: true, mismatch: false };
  serializationStats.mismatch += 1;
  console.warn(
    'notes: the Markdown serializer could not represent this document exactly; saving the fallback form',
  );
  return { markdown: fresh, fallback: true, mismatch: true };
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
