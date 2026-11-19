import { safeHref } from '@bokydo/shared';
import type { Block, NoteDocument, Run, TextRun } from './ast.js';

/**
 * Markdown export: the parsed document, written back out as CommonMark. Links that only mean
 * something inside BokyDo are flattened to their text, note-file links point into the export's
 * `files/` folder, and censored spans are the `█████` placeholder.
 *
 * The output is read back by editors and by `markdown-it` itself, so it must not be able to
 * contain raw HTML or a fence the body can close early: code fences are chosen from the content
 * (see `fenceFor`), and an image that is not inside the zip is a link, never `![…]`.
 */

export interface MarkdownOptions {
  /** Note-file id → relative URL inside the export (only for files that are being exported). */
  fileUrls?: ReadonlyMap<string, string>;
  /** Note-file id → display filename, used when a file is not part of the export. */
  fileNames?: ReadonlyMap<string, string>;
  /** Note files whose bytes are gone: their references become `[file unavailable: name]`. */
  fileUnavailable?: ReadonlySet<string>;
  /** Called between blocks, so a render can abandon a document that is taking too long. */
  check?: () => void;
  /** Inside a GFM table cell, where `|` splits before inline parsing even in a code span. */
  inTable?: boolean;
}

/** ASCII punctuation that means something to CommonMark, escaped so text stays text. */
const ESCAPED = /[\\`*_[\]<>|~!#]/g;

function escapeText(text: string): string {
  return text.replace(ESCAPED, '\\$&');
}

/** A URL in a Markdown destination, in angle brackets when it holds characters that end one. */
function markdownUrl(url: string): string {
  return /[()\s<>]/.test(url) ? `<${url}>` : url;
}

/** The longest runs of backticks and tildes in `text`, both found in one linear pass. */
function fenceRuns(text: string): { backtick: number; tilde: number } {
  let backtick = 0;
  let tilde = 0;
  let run = 0;
  let runChar = '';
  for (const ch of text) {
    if (ch !== '`' && ch !== '~') {
      run = 0;
      runChar = '';
      continue;
    }
    if (ch === runChar) run++;
    else {
      runChar = ch;
      run = 1;
    }
    if (ch === '`') {
      if (run > backtick) backtick = run;
    } else if (run > tilde) {
      tilde = run;
    }
  }
  return { backtick, tilde };
}

/**
 * A fenced code block's fence, chosen from one pass over the body and one over the info string.
 * The fence character must not appear in the info string at all, and the fence must be longer
 * than the longest run of it in the body — a shorter fence could be closed early (or an info
 * string containing the fence character could open something else) when the export is parsed
 * again, including with `html: true`.
 */
export function fenceFor(body: string, info: string): { fence: string; info: string } {
  let label = info;
  let char: 'backtick' | 'tilde' = 'backtick';
  if (label.includes('`')) {
    // A backtick fence may not carry a backtick in its info string; a tilde fence may carry a
    // tilde, but the rule here is stricter and simpler: the fence character never appears in
    // the info string at all.
    if (label.includes('~')) label = label.replace(/[`~]/g, '');
    else char = 'tilde';
  }
  const runs = fenceRuns(body);
  const longest = Math.max(char === 'backtick' ? runs.backtick : runs.tilde, 0);
  return { fence: (char === 'backtick' ? '`' : '~').repeat(Math.max(3, longest + 1)), info: label };
}

function codeSpan(text: string): string {
  const fence = '`'.repeat(fenceRuns(text).backtick + 1);
  const pad =
    text.startsWith('`') || text.endsWith('`') || text.startsWith(' ') || text.endsWith(' ');
  return pad ? `${fence} ${text} ${fence}` : `${fence}${text}${fence}`;
}
function fileName(fileId: string, opts: MarkdownOptions): string | null {
  return opts.fileNames?.get(fileId) ?? null;
}

function fileUrl(fileId: string, opts: MarkdownOptions): string | null {
  return opts.fileUrls?.get(fileId) ?? null;
}

/** No bytes behind the reference: plain text, so the export never points at nothing. */
function unavailableMarkdown(name: string): string {
  return `\\[file unavailable: ${escapeText(name)}\\]`;
}

function imageMarkdown(
  image: { alt: string; src: string; fileId: string | null },
  opts: MarkdownOptions,
): string {
  if (image.fileId) {
    const name = fileName(image.fileId, opts) ?? 'file';
    if (opts.fileUnavailable?.has(image.fileId)) return unavailableMarkdown(name);
    const url = fileUrl(image.fileId, opts);
    // Only an image that is actually in the zip is written as an image.
    if (url) return `![${escapeText(image.alt)}](${markdownUrl(url)})`;
    return `[image: ${escapeText(image.alt || name)}]`;
  }
  // A remote image would be fetched when the export is opened: keep it a link.
  const href = safeHref(image.src);
  if (!href) return `[image: ${escapeText(image.alt || 'image')}]`;
  return `[${escapeText(image.alt) || escapeText(image.src)}](${markdownUrl(href)})`;
}

/** Emphasis markers need the spaces outside: `** bold**` is not emphasis in CommonMark. */
function markText(text: string, run: TextRun): string {
  if (!run.bold && !run.italic && !run.strike) return text;
  // `trim` and `indexOf` are linear; a `\s*$` regex would rescan the whole run.
  const core = text.trim();
  if (core === '') return text;
  const start = text.indexOf(core);
  const leading = text.slice(0, start);
  const trailing = text.slice(start + core.length);
  let out = core;
  if (run.strike) out = `~~${out}~~`;
  if (run.bold) out = `**${out}**`;
  if (run.italic) out = `*${out}*`;
  return `${leading}${out}${trailing}`;
}

/** One run, with its marks. Links keep their label; `bokydo:` links keep only the label. */
function runMarkdown(run: Run, opts: MarkdownOptions): string {
  if (run.kind === 'break') return '\\\n';
  if (run.kind === 'image') return imageMarkdown(run, opts);
  let text: string;
  if (run.censor) text = run.text;
  else {
    const code = run.code ? codeSpan(opts.inTable ? run.text.replace(/\|/g, '\\|') : run.text) : '';
    text = markText(run.code ? code : escapeText(run.text), run);
  }

  if (run.fileId) {
    // Keep the link wrapper even when the label is inline code: dropping it would put two code
    // spans side by side, and their backtick runs can then merge into a delimiter that never
    // closes (the following text would parse as HTML in an `html: true` reader).
    const name = fileName(run.fileId, opts) ?? text;
    if (opts.fileUnavailable?.has(run.fileId)) return unavailableMarkdown(name);
    const url = fileUrl(run.fileId, opts);
    if (url) return `[${text}](${markdownUrl(url)})`;
    if (run.href) return `[${text}](${markdownUrl(run.href)})`;
    return text;
  }
  if (run.appLink || !run.href) return text;
  return `[${text}](${markdownUrl(run.href)})`;
}

/**
 * Inline runs, kept from merging delimiters: a code span's closing backticks and the next run's
 * opening backticks must never form one longer run. CommonMark matches a closing delimiter by
 * exact length, so a merged run can leave a span unterminated and release the rest of the line
 * (including `<b>`) into raw HTML for a lenient reader. A literal space is the cheapest
 * separator and changes only the whitespace between two spans, never their content.
 */
function inlineMarkdown(runs: readonly Run[], opts: MarkdownOptions): string {
  const parts: string[] = [];
  let previous = '';
  for (const run of runs) {
    let piece = runMarkdown(run, opts);
    if (piece === '') continue;
    if (previous.endsWith('`') && piece.startsWith('`')) piece = ` ${piece}`;
    parts.push(piece);
    previous = piece;
  }
  return parts.join('');
}

/** `1. text` or `- text` at the very start of a paragraph would become a list without this. */
function protectLineStart(text: string): string {
  if (/^\d{1,9}[.)]\s/.test(text)) return text.replace(/^(\d{1,9})([.)])/, '$1\\$2');
  if (/^[-+]\s/.test(text)) return `\\${text}`;
  return text;
}

function paragraphMarkdown(runs: readonly Run[], opts: MarkdownOptions): string {
  return protectLineStart(inlineMarkdown(runs, opts));
}

function headingMarkdown(level: number, runs: readonly Run[], opts: MarkdownOptions): string {
  return `${'#'.repeat(level)} ${inlineMarkdown(runs, opts)}`;
}

function codeMarkdown(text: string, language: string): string {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const { fence, info } = fenceFor(body, language);
  return `${fence}${info}\n${body}\n${fence}`;
}

function quoteMarkdown(blocks: readonly Block[], opts: MarkdownOptions): string {
  return renderBlocks(blocks, opts)
    .split('\n')
    .map((line) => (line === '' ? '>' : `> ${line}`))
    .join('\n');
}

function listMarkdown(block: Extract<Block, { type: 'list' }>, opts: MarkdownOptions): string {
  const items: string[] = [];
  block.items.forEach((item, index) => {
    const marker = block.ordered ? `${block.start + index}. ` : '- ';
    const task = item.checked === null ? '' : item.checked ? '[x] ' : '[ ] ';
    const prefix = `${marker}${task}`;
    // A nested list starts on the next line; anything else is its own paragraph.
    const body = item.blocks
      .map((block, index) =>
        index > 0 && block.type === 'list'
          ? `\n${blockMarkdown(block, opts)}`
          : index > 0
            ? `\n\n${blockMarkdown(block, opts)}`
            : blockMarkdown(block, opts),
      )
      .join('');
    if (body === '') {
      items.push(prefix.trimEnd());
      return;
    }
    const pad = ' '.repeat(prefix.length);
    items.push(
      body
        .split('\n')
        .map((line, lineIndex) => {
          if (lineIndex === 0) return prefix + line;
          return line === '' ? '' : pad + line;
        })
        .join('\n'),
    );
  });
  return items.join('\n');
}

function tableMarkdown(block: Extract<Block, { type: 'table' }>, opts: MarkdownOptions): string {
  const cell = (runs: readonly Run[]) =>
    inlineMarkdown(runs, { ...opts, inTable: true }).replace(/\n/g, ' ');
  const width = Math.max(block.header.length, ...block.rows.map((row) => row.length));
  const line = (runs: readonly Run[][]) => {
    const cells: string[] = [];
    for (let i = 0; i < width; i++) cells.push(cell(runs[i] ?? []));
    return `| ${cells.join(' | ')} |`;
  };
  const separator = Array.from({ length: width }, (_, i) => {
    switch (block.align[i] ?? null) {
      case 'center':
        return ':---:';
      case 'right':
        return '---:';
      case 'left':
        return ':---';
      default:
        return '---';
    }
  });
  const out = [line(block.header), `| ${separator.join(' | ')} |`];
  for (const row of block.rows) out.push(line(row));
  return out.join('\n');
}

function blockMarkdown(block: Block, opts: MarkdownOptions): string {
  opts.check?.();
  switch (block.type) {
    case 'heading':
      return headingMarkdown(block.level, block.runs, opts);
    case 'paragraph':
      return paragraphMarkdown(block.runs, opts);
    case 'code':
      return codeMarkdown(block.text, block.language);
    case 'quote':
      return quoteMarkdown(block.blocks, opts);
    case 'list':
      return listMarkdown(block, opts);
    case 'table':
      return tableMarkdown(block, opts);
    case 'hr':
      return '---';
    case 'image':
      return imageMarkdown(block, opts);
    case 'embed':
      return `[${escapeText(block.label)}](${markdownUrl(block.openUrl)})`;
    default:
      return '';
  }
}

/** Render a document body (without the title) as CommonMark. */
export function renderBlocks(blocks: readonly Block[], opts: MarkdownOptions = {}): string {
  return blocks
    .map((block) => blockMarkdown(block, opts))
    .filter((text) => text !== '')
    .join('\n\n');
}

/** A whole note as one Markdown file: the title as `# Title`, then the body. */
export function renderNoteMarkdown(
  title: string,
  doc: NoteDocument,
  opts: MarkdownOptions = {},
): string {
  const parts: string[] = [];
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  if (cleanTitle) parts.push(`# ${escapeText(cleanTitle)}`);
  const body = renderBlocks(doc.blocks, opts);
  if (body) parts.push(body);
  return `${parts.join('\n\n')}\n`;
}
