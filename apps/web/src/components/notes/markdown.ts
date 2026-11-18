/* eslint-disable @typescript-eslint/no-non-null-assertion --
   Index access below is bounds-checked by the surrounding loop/length conditions. */
import { safeHref } from '@bokydo/shared';
import type { JSONContent } from '@tiptap/core';
import MarkdownIt, { type Token } from 'markdown-it';
import { parseToken } from '../../lib/censor.js';
import { EMBED_LINE, parseEmbedUrl } from './embed.js';

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
 * whitespace) and `attrs.hash`, a hash of its canonical serialisation. On serialise an unchanged
 * block is emitted verbatim from `src`, so an edit in one block can never rewrite or discard the
 * Markdown of any other block. Custom syntax is recognised from SOURCE, not decoded inline text,
 * so backslash-escaped `\{\{censored…` and `\::embed` stay literal.
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
const CENSOR_SPLIT = new RegExp(`(${CENSOR_BODY})`);
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

/** Stable hash of a block's canonical serialisation, used to detect edits. */
function hashString(s: string): string {
  let a = 0x811c9dc5;
  let b = 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b + c, 0x85ebca6b) >>> 0;
  }
  return `${a.toString(36)}-${b.toString(36)}`;
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
 * Custom censor tokens must be recognised from the RAW inline source, not markdown-it's decoded
 * `text` tokens: `\{\{censored…\}\}` decodes to a token-looking string but must stay literal text.
 * We collect the exact token strings that occur unescaped in the raw source (an escaped brace pair
 * is separated by backslashes, so the shape regex never matches it) and only promote those.
 */
function unescapedCensorTokens(raw: string): Set<string> {
  const set = new Set<string>();
  CENSOR_GLOBAL.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CENSOR_GLOBAL.exec(raw)) !== null) set.add(m[0]);
  return set;
}

function splitCensored(text: string, rawTokens: Set<string>): { text: string; token: boolean }[] {
  return text
    .split(CENSOR_SPLIT)
    .filter((part) => part.length > 0)
    .map((part) => ({
      text: part,
      token: rawTokens.has(part) && isValidCensorToken(part),
    }));
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
  rawTokens: Set<string> = new Set(),
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
        for (const part of splitCensored(t.content, rawTokens)) {
          if (part.token)
            out.push({ type: 'censored', attrs: { token: part.text }, ...withMarks(marks) });
          else pushText(part.text);
        }
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
        out.push({ type: 'text', text: t.content, marks: [...marks, { type: 'code' }] });
        i++;
        break;
      case 'hardbreak':
        out.push({ type: 'hardBreak' });
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
          out.push(...parseInlineChildren(inner, [...marks, linkMark], rawTokens));
        } else {
          out.push(...parseInlineChildren(inner, marks, rawTokens));
        }
        i = next;
        break;
      }
      case 'image': {
        const src = String(t.attrGet('src') ?? '');
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

function parseInline(inline: Token | undefined, rawTokens: Set<string> = new Set()): JSONContent[] {
  return inline?.type === 'inline' ? parseInlineChildren(inline.children ?? [], [], rawTokens) : [];
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
      const content = parseInline(inline, unescapedCensorTokens(inline?.content ?? ''));
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
      const em = EMBED_LINE.exec(raw);
      if (em) {
        const label = em[1] ?? '';
        const url = em[2] ?? '';
        if (parseEmbedUrl(url)) {
          return { node: { type: 'embed', attrs: { label, url } }, next: i + 3, map };
        }
        return { node: invalidEmbedParagraph(label, url, raw), next: i + 3, map };
      }
      return {
        node: {
          type: 'paragraph',
          content: parseInline(inline, unescapedCensorTokens(inline?.content ?? '')),
        },
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
          content: parseInline(tokens[i + 1], unescapedCensorTokens(tokens[i + 1]?.content ?? '')),
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

/** Attach verbatim source + a stability hash to each top-level block (review: no silent rewrite). */
function attachSourceMeta(nodes: JSONContent[], maps: Token['map'][], src: string): void {
  const lines = lineOffsets(src);
  const startOf = (i: number) => (lines[i] ? lines[i]!.start : src.length);
  const endOf = (i: number) => (lines[i] ? lines[i]!.end : src.length);
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    const attrs: Record<string, unknown> = { ...(node.attrs ?? {}) };
    const map = maps[i];
    if (map) {
      const [s, e] = map;
      const contentStart = startOf(s);
      const contentEnd = endOf(e - 1);
      attrs.src = src.slice(contentStart, contentEnd);
      const nextStart = i + 1 < nodes.length && maps[i + 1] ? startOf(maps[i + 1]![0]) : src.length;
      attrs.sep = src.slice(contentEnd, nextStart);
      if (i === 0) attrs.lead = src.slice(0, contentStart);
    }
    attrs.hash = hashString(serializeBlock(node));
    node.attrs = attrs;
  }
}

/** Parse a full Markdown note into a TipTap/ProseMirror JSON document. */
export function markdownToDoc(src: string): JSONContent {
  const tokens = md.parse(src ?? '', {});
  const maps: Token['map'][] = [];
  const { nodes } = parseSequence(tokens, 0, undefined, maps);
  const content = stripEmptyText(nodes.length ? nodes : [{ type: 'paragraph', content: [] }]);
  if (nodes.length) attachSourceMeta(content, maps, src);
  else if (content[0]) content[0].attrs = { ...(content[0].attrs ?? {}), lead: src };
  return { type: 'doc', content };
}

/** Parse a plaintext Markdown span into inline nodes (used to restore an uncensored span). */
export function markdownToInline(src: string): JSONContent[] {
  const tokens = md.parseInline(src ?? '', {});
  const inline = tokens.find((t) => t.type === 'inline');
  return stripEmptyText(parseInline(inline, unescapedCensorTokens(inline?.content ?? '')));
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
function serializeInline(nodes: JSONContent[] = []): string {
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
      out += '\\\n';
      atLineStart = true;
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
    serializeInline(inner)
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
      return isValidEmbedUrl(url) ? `::embed[${label}](${url})` : label || url;
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
 * Serialize a ProseMirror JSON document to Markdown. Each unchanged top-level block is emitted
 * verbatim from its captured `attrs.src`; edited blocks are re-serialized. This keeps otherwise
 * untouched Markdown byte-identical while a small edit elsewhere cannot rewrite/discard content.
 */
export function docToMarkdown(doc: JSONContent): string {
  const blocks = doc.content ?? [];
  if (!blocks.length) return '';
  let out = '';
  const lead = blocks[0]?.attrs?.lead;
  if (typeof lead === 'string') out += lead;
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i]!;
    const canonical = serializeBlock(block);
    const src = block.attrs?.src;
    const hash = block.attrs?.hash;
    const unchanged =
      typeof src === 'string' && typeof hash === 'string' && hashString(canonical) === hash;
    out += unchanged ? src : canonical;
    const sep = block.attrs?.sep;
    out += typeof sep === 'string' ? sep : i < blocks.length - 1 ? '\n\n' : '';
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
