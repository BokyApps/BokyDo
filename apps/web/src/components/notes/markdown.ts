/* eslint-disable @typescript-eslint/no-non-null-assertion --
   Index access below is bounds-checked by the surrounding loop/length conditions. */
import { safeHref } from '@bokydo/shared';
import type { JSONContent } from '@tiptap/core';
import MarkdownIt, { type Token } from 'markdown-it';
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
 */

// ---------------------------------------------------------------------------------------------
// Constants / classification
// ---------------------------------------------------------------------------------------------

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const NOTE_FILE_HREF = new RegExp(`^/api/v1/note-files/(${UUID})$`);
const INTERNAL_NOTE = new RegExp(`^bokydo:note/(${UUID})$`);
const INTERNAL_TASK = new RegExp(`^bokydo:task/(${UUID})$`);

export const NOTE_FILE_PREFIX = '/api/v1/note-files/';
export const CENSORED_PLACEHOLDER = '█████';

/** `{{censored:v1:<salt>:<iv>:<ct>}}` — the shape the editor recognises (ADR 0025). */
const CENSOR_BODY = '\\{\\{censored:v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+\\}\\}';
export const CENSOR_TOKEN_EXACT = new RegExp(`^${CENSOR_BODY}$`);
const CENSOR_SPLIT = new RegExp(`(${CENSOR_BODY})`);

export type HrefKind =
  | { kind: 'link'; href: string }
  | { kind: 'file'; id: string }
  | { kind: 'note'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'unsafe' };

/** Classify a link/image destination. Anything not explicitly allowed becomes plain text. */
export function classifyHref(raw: string): HrefKind {
  const value = raw.trim();
  const file = NOTE_FILE_HREF.exec(value);
  if (file?.[1]) return { kind: 'file', id: file[1] };
  const note = INTERNAL_NOTE.exec(value);
  if (note?.[1]) return { kind: 'note', id: note[1] };
  const task = INTERNAL_TASK.exec(value);
  if (task?.[1]) return { kind: 'task', id: task[1] };
  const href = safeHref(value);
  if (href) return { kind: 'link', href };
  return { kind: 'unsafe' };
}

export function isCensorToken(value: string): boolean {
  return CENSOR_TOKEN_EXACT.test(value);
}

// ---------------------------------------------------------------------------------------------
// Escaping (produces readable, canonical Markdown that re-parses to the same doc)
// ---------------------------------------------------------------------------------------------

// Always escape characters that could start inline constructs, autolinks or entity decoding.
const ESCAPE_ALWAYS = /[\\`*_[\]<>~|&]/g;

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

function longestBacktickRun(text: string): number {
  let max = 0;
  let run = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '`') {
      run++;
      if (run > max) max = run;
    } else run = 0;
  }
  return max;
}

function serializeCode(text: string): string {
  const body = text.replace(/\r?\n/g, ' ');
  const delim = '`'.repeat(longestBacktickRun(body) + 1);
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

// ---------------------------------------------------------------------------------------------
// Markdown -> ProseMirror JSON
// ---------------------------------------------------------------------------------------------

const md = new MarkdownIt({ html: false, linkify: false, breaks: false });

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(3, Math.max(1, Math.round(value)));
}

function splitCensored(text: string): { text: string; token: boolean }[] {
  return text
    .split(CENSOR_SPLIT)
    .filter((part) => part.length > 0)
    .map((part) => ({ text: part, token: CENSOR_TOKEN_EXACT.test(part) }));
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
        for (const part of splitCensored(t.content)) {
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
        pushText(' '); // soft line breaks normalise to a single space
        i++;
        break;
      case 'link_open': {
        const href = String(t.attrGet('href') ?? '');
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
          out.push(
            ...parseInlineChildren(inner, [...marks, { type: 'link', attrs: { href: cls.href } }]),
          );
        } else {
          out.push(...parseInlineChildren(inner, marks));
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

function parseInline(inline: Token | undefined): JSONContent[] {
  return inline?.type === 'inline' ? parseInlineChildren(inline.children ?? []) : [];
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
    return {
      type: 'paragraph',
      content: [{ type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] }],
    };
  }
  return { type: 'paragraph', content: [{ type: 'text', text: raw }] };
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
      const content = parseInline(inline);
      cells.push({
        type: t.type === 'th_open' ? 'tableHeader' : 'tableCell',
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

function readBlock(tokens: Token[], i: number): { node: JSONContent | null; next: number } {
  const t = tokens[i]!;
  switch (t.type) {
    case 'paragraph_open': {
      const inline = tokens[i + 1];
      const raw = inline?.content?.trim() ?? '';
      const em = EMBED_LINE.exec(raw);
      if (em) {
        const label = em[1] ?? '';
        const url = em[2] ?? '';
        if (parseEmbedUrl(url)) {
          return { node: { type: 'embed', attrs: { label, url } }, next: i + 3 };
        }
        return { node: invalidEmbedParagraph(label, url, raw), next: i + 3 };
      }
      return { node: { type: 'paragraph', content: parseInline(inline) }, next: i + 3 };
    }
    case 'heading_open': {
      const level = clampLevel(parseInt(t.tag.slice(1), 10));
      return {
        node: { type: 'heading', attrs: { level }, content: parseInline(tokens[i + 1]) },
        next: i + 3,
      };
    }
    case 'hr':
      return { node: { type: 'horizontalRule' }, next: i + 1 };
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
      };
    }
    case 'bullet_list_open':
    case 'ordered_list_open': {
      const closeType = t.type.replace('_open', '_close');
      const inner = parseSequence(tokens, i + 1, closeType);
      const items = inner.nodes;
      // A GFM task list is a bullet list where *every* item starts with `[ ]`/`[x]`. Mixed lists
      // stay ordinary bullet lists (the marker remains literal text) so we never mix taskItem and
      // listItem children inside one list, which the schema forbids.
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
      return { node, next: inner.next };
    }
    case 'list_item_open': {
      const inner = parseSequence(tokens, i + 1, 'list_item_close');
      const content = inner.nodes.length ? inner.nodes : [{ type: 'paragraph', content: [] }];
      return { node: { type: 'listItem', content }, next: inner.next };
    }
    case 'table_open':
      return parseTable(tokens, i);
    default:
      return { node: null, next: i + 1 };
  }
}

function parseSequence(
  tokens: Token[],
  start: number,
  stopType?: string,
): { nodes: JSONContent[]; next: number } {
  const nodes: JSONContent[] = [];
  let i = start;
  while (i < tokens.length) {
    if (stopType && tokens[i]!.type === stopType) return { nodes, next: i + 1 };
    const r = readBlock(tokens, i);
    if (r.node) nodes.push(r.node);
    i = r.next > i ? r.next : i + 1;
  }
  return { nodes, next: i };
}

/** Parse a full Markdown note into a TipTap/ProseMirror JSON document. */
export function markdownToDoc(src: string): JSONContent {
  const tokens = md.parse(src ?? '', {});
  const { nodes } = parseSequence(tokens, 0);
  // A ProseMirror doc always needs at least one block so the editor is editable.
  return { type: 'doc', content: nodes.length ? nodes : [{ type: 'paragraph', content: [] }] };
}

/** Parse a plaintext Markdown span into inline nodes (used to restore an uncensored span). */
export function markdownToInline(src: string): JSONContent[] {
  const tokens = md.parseInline(src ?? '', {});
  const inline = tokens.find((t) => t.type === 'inline');
  return parseInlineChildren(inline?.children ?? []);
}

// ---------------------------------------------------------------------------------------------
// ProseMirror JSON -> canonical Markdown
// ---------------------------------------------------------------------------------------------

function serializeInline(nodes: JSONContent[] = []): string {
  let out = '';
  let atLineStart = true;
  for (const node of nodes) {
    switch (node.type) {
      case 'text': {
        const text = node.text ?? '';
        if (!text) break;
        const marks = node.marks ?? [];
        const has = (type: string) => marks.some((m) => m.type === type);
        let piece = has('code') ? serializeCode(text) : escapeText(text, atLineStart);
        if (has('bold')) piece = `**${piece}**`;
        if (has('italic')) piece = `*${piece}*`;
        if (has('strike')) piece = `~~${piece}~~`;
        const link = marks.find((m) => m.type === 'link');
        if (link) piece = `[${piece}](${serializeHref(String(link.attrs?.href ?? ''))})`;
        out += piece;
        atLineStart = false;
        break;
      }
      case 'hardBreak':
        out += '\\\n';
        atLineStart = true;
        break;
      case 'censored':
        out += String(node.attrs?.token ?? CENSORED_PLACEHOLDER);
        atLineStart = false;
        break;
      case 'noteImage':
        out += `![${escapeLabel(String(node.attrs?.alt ?? ''))}](${NOTE_FILE_PREFIX}${node.attrs?.id ?? ''})`;
        atLineStart = false;
        break;
      case 'fileChip':
        out += `[${escapeLabel(String(node.attrs?.name ?? ''))}](${NOTE_FILE_PREFIX}${node.attrs?.id ?? ''})`;
        atLineStart = false;
        break;
      case 'internalChip':
        out += `[${escapeLabel(String(node.attrs?.label ?? ''))}](bokydo:${node.attrs?.kind}/${node.attrs?.id ?? ''})`;
        atLineStart = false;
        break;
      default:
        if (typeof node.text === 'string' && node.text) {
          out += escapeText(node.text, atLineStart);
          atLineStart = false;
        }
        break;
    }
  }
  return out;
}

function serializeCell(cell: JSONContent): string {
  const inner = cell.content?.[0]?.content ?? [];
  return serializeInline(inner).replace(/\r?\n/g, ' ');
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
  const out = [line(cellsOf(rows[0]!)), `| ${new Array(colCount).fill('---').join(' | ')} |`];
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
        for (const l of serializeBlock(b).split('\n')) lines.push(contIndent + l);
      }
    }
  });
  return lines;
}

function serializeBlock(node: JSONContent): string {
  switch (node.type) {
    case 'paragraph':
      return serializeInline(node.content);
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
      return `\`\`\`${language}\n${text}\n\`\`\``;
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
    case 'embed':
      return `::embed[${String(node.attrs?.label ?? '')}](${String(node.attrs?.url ?? '')})`;
    case 'noteUpload':
      return ''; // transient upload placeholder is never persisted to Markdown
    default:
      return '';
  }
}

function serializeBlocks(nodes: JSONContent[]): string {
  return nodes
    .map(serializeBlock)
    .filter((s) => s.length > 0)
    .join('\n\n');
}

/** Serialize a ProseMirror JSON document to canonical Markdown. */
export function docToMarkdown(doc: JSONContent): string {
  return serializeBlocks(doc.content ?? []);
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

/**
 * ProseMirror parses pasted HTML by assigning it to innerHTML, so a hostile `<img onerror>` could
 * otherwise fire while being parsed. DOMParser creates an inert document (no resource loads, no
 * script execution); we strip dangerous tags/attributes before ProseMirror ever sees the HTML.
 * Only known, data-tagged chips and safe links survive, which the schema then filters again.
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
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const unsafeName =
        name.startsWith('on') ||
        name === 'style' ||
        name === 'srcdoc' ||
        name === 'srcset' ||
        name === 'formaction' ||
        name === 'xlink:href';
      if (unsafeName) el.removeAttribute(attr.name);
      else if (tag === 'img' && name !== 'src' && name !== 'alt' && !name.startsWith('data-')) {
        el.removeAttribute(attr.name);
      }
    }
    if (tag === 'img' && !el.hasAttribute('data-note-image')) {
      el.remove();
      continue;
    }
    if (tag === 'a') {
      const href = el.getAttribute('href') ?? '';
      if (classifyHref(href).kind === 'unsafe') el.removeAttribute('href');
    }
  }
  return doc.body.innerHTML;
}
