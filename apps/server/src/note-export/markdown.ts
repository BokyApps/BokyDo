import type { Block, NoteDocument, Run, TextRun } from './ast.js';

/**
 * Markdown export: the parsed document, written back out as CommonMark. Links that only mean
 * something inside BokyDo are flattened to their text, note-file links point into the export's
 * `files/` folder, and censored spans are the `█████` placeholder.
 */

export interface MarkdownOptions {
  /** Note-file id → relative URL inside the export (only for files that are being exported). */
  fileUrls?: ReadonlyMap<string, string>;
  /** Note-file id → display filename, used when a file is not part of the export. */
  fileNames?: ReadonlyMap<string, string>;
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

function codeSpan(text: string): string {
  let fence = '`';
  while (text.includes(fence)) fence += '`';
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

function imageMarkdown(
  image: { alt: string; src: string; fileId: string | null },
  opts: MarkdownOptions,
): string {
  const url = image.fileId ? fileUrl(image.fileId, opts) : null;
  if (url) return `![${escapeText(image.alt)}](${markdownUrl(url)})`;
  if (image.fileId)
    return `[image: ${escapeText(image.alt || fileName(image.fileId, opts) || 'file')}]`;
  return `![${escapeText(image.alt)}](${markdownUrl(image.src)})`;
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
    text = markText(run.code ? codeSpan(run.text) : escapeText(run.text), run);
  }

  if (run.fileId) {
    if (run.code) return text;
    const url = fileUrl(run.fileId, opts);
    if (url) return `[${text}](${markdownUrl(url)})`;
    if (run.href) return `[${text}](${markdownUrl(run.href)})`;
    return text;
  }
  if (run.appLink || !run.href || run.code) return text;
  return `[${text}](${markdownUrl(run.href)})`;
}

function inlineMarkdown(runs: readonly Run[], opts: MarkdownOptions): string {
  return runs.map((run) => runMarkdown(run, opts)).join('');
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
  let fence = '```';
  while (text.includes(fence)) fence += '`';
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return `${fence}${language}\n${body}\n${fence}`;
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
  const cell = (runs: readonly Run[]) => inlineMarkdown(runs, opts).replace(/\n/g, ' ');
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
