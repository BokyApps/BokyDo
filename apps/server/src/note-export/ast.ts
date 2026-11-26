import {
  CENSOR_PLACEHOLDER,
  parseEmbedUrl,
  redactCensored,
  safeHref,
  splitMediaWidth,
} from '@bokydo/shared';
import MarkdownIt, { type Token } from 'markdown-it';
import { TooLargeError, checkBodyShape } from './limits.js';

/**
 * One small document model shared by the three note exporters. The stored note body is
 * CommonMark + GFM, parsed here with HTML and linkify disabled (ADR 0025); nothing in this
 * module ever sees censored plaintext, because the token is replaced by `█████` first.
 */

export type Align = 'left' | 'center' | 'right';

export interface AppLink {
  kind: 'note' | 'task';
  id: string;
}

/** Character-level formatting of a text run. Links are flattened into the run. */
export interface RunMarks {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  code?: boolean;
  /** An absolute safe `http(s)`/`mailto` URL. */
  href?: string;
  /** `bokydo:note/<uuid>` or `bokydo:task/<uuid>`; resolves only inside the app. */
  appLink?: AppLink;
  /** A note file of this note (`/api/v1/note-files/<uuid>`). */
  fileId?: string;
  /** A censored span: `text` is the placeholder, never the token. */
  censor?: boolean;
}

export interface TextRun extends RunMarks {
  kind: 'text';
  text: string;
}

export interface BreakRun {
  kind: 'break';
}

export interface ImageRun {
  kind: 'image';
  alt: string;
  src: string;
  /** Set when the image is a note file, so only this note's files are ever embedded. */
  fileId: string | null;
}

export type Run = TextRun | BreakRun | ImageRun;

export interface HeadingBlock {
  type: 'heading';
  level: number;
  runs: Run[];
}

export interface ParagraphBlock {
  type: 'paragraph';
  runs: Run[];
}

export interface CodeBlock {
  type: 'code';
  text: string;
  language: string;
}

export interface QuoteBlock {
  type: 'quote';
  blocks: Block[];
}

export interface ListItem {
  /** `null` when the item is not a task; otherwise its checkbox state. */
  checked: boolean | null;
  blocks: Block[];
}

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  start: number;
  items: ListItem[];
}

export interface TableBlock {
  type: 'table';
  align: (Align | null)[];
  header: Run[][];
  rows: Run[][][];
}

export interface HrBlock {
  type: 'hr';
}

export interface ImageBlock {
  type: 'image';
  alt: string;
  src: string;
  fileId: string | null;
}

export interface EmbedBlock {
  type: 'embed';
  label: string;
  openUrl: string;
  provider: 'youtube' | 'drive';
}

export type Block =
  | HeadingBlock
  | ParagraphBlock
  | CodeBlock
  | QuoteBlock
  | ListBlock
  | TableBlock
  | HrBlock
  | ImageBlock
  | EmbedBlock;

export interface NoteDocument {
  blocks: Block[];
  /** markdown-it tokens the body produced, for the export limit; not used by the renderers. */
  tokenCount: number;
}

const parser = new MarkdownIt({ html: false, linkify: false, breaks: false });

const NOTE_FILE_PREFIX = '/api/v1/note-files/';
const NOTE_PREFIX = 'bokydo:note/';
const TASK_PREFIX = 'bokydo:task/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `…/note-files/<uuid>[?inline=1]` → the uuid; anything else is not a note file. */
function noteFileId(src: string): string | null {
  if (!src.startsWith(NOTE_FILE_PREFIX)) return null;
  const rest = src.slice(NOTE_FILE_PREFIX.length);
  const query = rest.indexOf('?');
  const id = query === -1 ? rest : rest.slice(0, query);
  if (query !== -1 && rest.slice(query) !== '?inline=1') return null;
  return UUID.test(id) ? id.toLowerCase() : null;
}

function appLink(href: string): AppLink | null {
  for (const [prefix, kind] of [
    [NOTE_PREFIX, 'note'],
    [TASK_PREFIX, 'task'],
  ] as const) {
    if (!href.startsWith(prefix)) continue;
    const id = href.slice(prefix.length);
    return UUID.test(id) ? { kind, id: id.toLowerCase() } : null;
  }
  return null;
}

/** Split a text run where a censored span was redacted, so PDF can draw a solid bar. */
function pushText(runs: Run[], text: string, marks: RunMarks): void {
  if (text === '') return;
  let from = 0;
  for (;;) {
    const at = text.indexOf(CENSOR_PLACEHOLDER, from);
    if (at === -1) {
      if (from < text.length) runs.push({ ...marks, kind: 'text', text: text.slice(from) });
      return;
    }
    if (at > from) runs.push({ ...marks, kind: 'text', text: text.slice(from, at) });
    runs.push({ ...marks, kind: 'text', text: CENSOR_PLACEHOLDER, censor: true });
    from = at + CENSOR_PLACEHOLDER.length;
  }
}

function parseInline(children: readonly Token[] | null): Run[] {
  const runs: Run[] = [];
  if (!children) return runs;
  const marks: RunMarks = {};
  for (const token of children) {
    switch (token.type) {
      case 'text':
        pushText(runs, token.content, marks);
        break;
      case 'softbreak':
        pushText(runs, ' ', marks);
        break;
      case 'hardbreak':
        runs.push({ kind: 'break' });
        break;
      case 'code_inline':
        pushText(runs, token.content, { ...marks, code: true });
        break;
      case 'strong_open':
        marks.bold = true;
        break;
      case 'strong_close':
        delete marks.bold;
        break;
      case 'em_open':
        marks.italic = true;
        break;
      case 'em_close':
        delete marks.italic;
        break;
      case 's_open':
        marks.strike = true;
        break;
      case 's_close':
        delete marks.strike;
        break;
      case 'link_open': {
        const raw = String(token.attrGet('href') ?? '');
        const target = appLink(raw);
        const href = target ? null : safeHref(raw);
        if (target) {
          marks.appLink = target;
          delete marks.href;
        } else {
          if (href) marks.href = href;
          else delete marks.href;
          delete marks.appLink;
        }
        const file = noteFileId(raw);
        if (file) marks.fileId = file;
        else delete marks.fileId;
        break;
      }
      case 'link_close':
        delete marks.href;
        delete marks.appLink;
        delete marks.fileId;
        break;
      case 'image': {
        const src = String(token.attrGet('src') ?? '');
        runs.push({
          kind: 'image',
          // A display width (`alt|300`) is for the editor; exports use the plain alt text.
          alt: splitMediaWidth(token.content).label,
          src,
          fileId: noteFileId(src),
        });
        break;
      }
      // `html` is off, so these only appear as escaped text; keep the characters visible.
      case 'html_inline':
        pushText(runs, token.content, marks);
        break;
      default:
        break;
    }
  }
  return runs;
}

function isWhitespaceText(run: Run): boolean {
  return run.kind === 'text' && !run.censor && run.text.trim() === '';
}

/** Drop whitespace-only runs at both ends (a paragraph is `::embed[label](url)` and nothing else). */
function trimRuns(runs: Run[]): Run[] {
  let start = 0;
  let end = runs.length;
  while (start < end) {
    const run = runs[start];
    if (!run || !isWhitespaceText(run)) break;
    start++;
  }
  while (end > start) {
    const run = runs[end - 1];
    if (!run || !isWhitespaceText(run)) break;
    end--;
  }
  return runs.slice(start, end);
}

/** A paragraph that is only `::embed[label](<url>)` becomes an embed block (ADR 0025). */
function embedFromRuns(runs: Run[]): EmbedBlock | null {
  const trimmed = trimRuns(runs);
  const first = trimmed[0];
  if (!first || first.kind !== 'text' || !first.text.trimStart().startsWith('::embed')) return null;
  const head = first.text.trimStart().slice('::embed'.length);
  if (head.trim() !== '') return null;
  const rest = trimmed.slice(1);
  if (rest.length === 0) return null;
  const href = rest[0]?.kind === 'text' ? rest[0].href : undefined;
  if (!href) return null;
  let label = '';
  for (const run of rest) {
    if (run.kind !== 'text' || run.href !== href) return null;
    label += run.text;
  }
  const embed = parseEmbedUrl(href);
  if (!embed) return null;
  return {
    type: 'embed',
    label: splitMediaWidth(label).label.trim() || embed.openUrl,
    openUrl: embed.openUrl,
    provider: embed.provider,
  };
}

/** markdown-it has no GFM task lists, so `- [ ] done` is a paragraph starting with `[ ] `. */
function takeTaskMarker(runs: Run[]): boolean | null {
  const first = runs[0];
  if (!first || first.kind !== 'text' || first.censor) return null;
  const match = /^\[([ xX])\](?: |$)/.exec(first.text);
  if (!match) return null;
  const rest = first.text.slice(match[0].length);
  if (rest === '') runs.shift();
  else runs[0] = { ...first, text: rest };
  return match[1] === ' ' ? false : true;
}

/** A paragraph holding exactly one image is a picture, not a line of text. */
function liftImage(runs: Run[]): ImageBlock | null {
  const trimmed = trimRuns(runs);
  const only = trimmed[0];
  if (trimmed.length !== 1 || !only || only.kind !== 'image') return null;
  return { type: 'image', alt: only.alt, src: only.src, fileId: only.fileId };
}

class Walker {
  private index = 0;
  constructor(private readonly tokens: readonly Token[]) {}

  peek(): Token | null {
    return this.tokens[this.index] ?? null;
  }

  next(): Token {
    const token = this.tokens[this.index];
    if (!token) throw new Error('unexpected end of markdown tokens');
    this.index++;
    return token;
  }

  atEnd(): boolean {
    return this.index >= this.tokens.length;
  }
}

/** Parse block-level tokens until a closing token of one of `stops` (or the end). */
function parseBlocks(walker: Walker, ...stops: string[]): Block[] {
  const blocks: Block[] = [];
  while (!walker.atEnd()) {
    const token = walker.peek();
    if (!token) break;
    if (stops.includes(token.type)) break;
    switch (token.type) {
      case 'paragraph_open': {
        walker.next();
        const inline = walker.peek()?.type === 'inline' ? walker.next() : null;
        if (walker.peek()?.type === 'paragraph_close') walker.next();
        const runs = parseInline(inline?.children ?? null);
        const embed = embedFromRuns(runs);
        if (embed) blocks.push(embed);
        else {
          const image = liftImage(runs);
          if (image) blocks.push(image);
          else if (runs.length > 0) blocks.push({ type: 'paragraph', runs });
        }
        break;
      }
      case 'heading_open': {
        const open = walker.next();
        const level = Number(open.tag.slice(1)) || 1;
        const inline = walker.peek()?.type === 'inline' ? walker.next() : null;
        if (walker.peek()?.type === 'heading_close') walker.next();
        const runs = parseInline(inline?.children ?? null);
        blocks.push({ type: 'heading', level: Math.min(6, Math.max(1, level)), runs });
        break;
      }
      case 'fence':
      case 'code_block': {
        const code = walker.next();
        blocks.push({
          type: 'code',
          text: code.content,
          language: code.info.trim().split(/\s+/)[0] ?? '',
        });
        break;
      }
      case 'blockquote_open': {
        walker.next();
        const inner = parseBlocks(walker, 'blockquote_close');
        if (walker.peek()?.type === 'blockquote_close') walker.next();
        if (inner.length > 0) blocks.push({ type: 'quote', blocks: inner });
        break;
      }
      case 'bullet_list_open':
      case 'ordered_list_open': {
        blocks.push(parseList(walker));
        break;
      }
      case 'table_open': {
        blocks.push(parseTable(walker));
        break;
      }
      case 'hr': {
        walker.next();
        blocks.push({ type: 'hr' });
        break;
      }
      case 'html_block': {
        // HTML is disabled (ADR 0025): markdown-it only emits this when an embedder turns it on.
        const html = walker.next();
        const runs: Run[] = [];
        pushText(runs, html.content, {});
        if (runs.length > 0) blocks.push({ type: 'paragraph', runs });
        break;
      }
      default:
        // Paragraphs inside tight lists are hidden; other wrappers (`tbody_open`) are noise.
        walker.next();
        break;
    }
  }
  return blocks;
}

function parseList(walker: Walker): ListBlock {
  const open = walker.next();
  const ordered = open.type === 'ordered_list_open';
  const start = Number(open.attrGet('start') ?? '1') || 1;
  const items: ListItem[] = [];
  while (walker.peek()?.type === 'list_item_open') {
    walker.next();
    const blocks = parseBlocks(walker, 'list_item_close');
    if (walker.peek()?.type === 'list_item_close') walker.next();
    let checked: boolean | null = null;
    const first = blocks[0];
    if (first?.type === 'paragraph') checked = takeTaskMarker(first.runs);
    if (checked !== null && first?.type === 'paragraph' && first.runs.length === 0) blocks.shift();
    items.push({ checked, blocks });
  }
  if (walker.peek()?.type === 'list_close') walker.next();
  return { type: 'list', ordered, start, items };
}

function parseTable(walker: Walker): TableBlock {
  walker.next(); // table_open
  const align: (Align | null)[] = [];
  let header: Run[][] = [];
  const rows: Run[][][] = [];
  let row: Run[][] | null = null;
  let inHeader = false;
  let cell: Run[] = [];
  while (!walker.atEnd()) {
    const token = walker.next();
    switch (token.type) {
      case 'table_close':
        return { type: 'table', align, header, rows };
      case 'thead_open':
        inHeader = true;
        break;
      case 'thead_close':
        inHeader = false;
        break;
      case 'tr_open':
        row = [];
        break;
      case 'tr_close':
        if (row) {
          if (inHeader && header.length === 0) header = row;
          else rows.push(row);
        }
        row = null;
        break;
      case 'th_open':
      case 'td_open': {
        const style = String(token.attrGet('style') ?? '');
        const index = row?.length ?? 0;
        align[index] = style.includes('center')
          ? 'center'
          : style.includes('right')
            ? 'right'
            : style.includes('left')
              ? 'left'
              : null;
        cell = [];
        break;
      }
      case 'inline':
        cell = parseInline(token.children);
        break;
      case 'th_close':
      case 'td_close':
        row?.push(cell);
        cell = [];
        break;
      default:
        break;
    }
  }
  return { type: 'table', align, header, rows };
}

/**
 * Parse a stored note body into the shared document model. Censored spans become `█████`.
 *
 * The token count is checked the moment `md.parse` returns, before the walker builds a single
 * block: markdown-it is linear, but a 512 KiB body of one-character list items still yields
 * hundreds of thousands of tokens, and the cap has to bite before the model does.
 */
export function parseNoteBody(body: string, opts: { maxTokens?: number } = {}): NoteDocument {
  // Cheap first-pass shape limits: a sparse table or a hundred thousand one-line blocks is
  // refused before markdown-it allocates a single token.
  checkBodyShape(body);
  const redacted = redactCensored(body);
  const tokens = parser.parse(redacted, {});
  if (opts.maxTokens !== undefined && tokens.length > opts.maxTokens)
    throw new TooLargeError(`note body has more than ${opts.maxTokens} Markdown tokens`);
  return { blocks: parseBlocks(new Walker(tokens)), tokenCount: tokens.length };
}

/** Every block, list item and table row, recursively — what `maxBlocks` is measured against. */
export function countBlocks(blocks: readonly Block[]): number {
  let total = 0;
  for (const block of blocks) {
    total++;
    if (block.type === 'quote') total += countBlocks(block.blocks);
    else if (block.type === 'list') {
      for (const item of block.items) total += 1 + countBlocks(item.blocks);
    } else if (block.type === 'table') total += block.header.length + block.rows.length;
  }
  return total;
}

/** Every note-file id the document points at (links and images). */
export function documentFileIds(blocks: readonly Block[]): Set<string> {
  const ids = new Set<string>();
  const scanRuns = (runs: readonly Run[]) => {
    for (const run of runs) {
      if (run.kind === 'image' && run.fileId) ids.add(run.fileId);
      else if (run.kind === 'text' && run.fileId) ids.add(run.fileId);
    }
  };
  for (const block of blocks) {
    if (block.type === 'heading' || block.type === 'paragraph') scanRuns(block.runs);
    else if (block.type === 'image' && block.fileId) ids.add(block.fileId);
    else if (block.type === 'quote') for (const id of documentFileIds(block.blocks)) ids.add(id);
    else if (block.type === 'list')
      for (const item of block.items) for (const id of documentFileIds(item.blocks)) ids.add(id);
    else if (block.type === 'table') {
      for (const cell of block.header) scanRuns(cell);
      for (const row of block.rows) for (const cell of row) scanRuns(cell);
    }
  }
  return ids;
}
