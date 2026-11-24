import MarkdownIt, { type Token } from 'markdown-it';
import {
  redactCensored,
  splitMediaWidth,
  type NotePreviewBlock,
  type NotePreviewKind,
  type NotePreviewRun,
} from './notes.js';

/**
 * The formatted start of a note for its card in the list (ADR 0025): headings, emphasis, lists,
 * quotes and code, as plain data the web renders as text. Server-only, like `notes-refs`: it uses
 * markdown-it, which must stay out of the web's initial chunks.
 *
 * Censored spans are redacted to █████ before anything is parsed, and only the first
 * `PREVIEW_SCAN_CHARS` characters are read, so a large or hostile body costs a bounded amount.
 */

const PREVIEW_SCAN_CHARS = 4_096;
const PREVIEW_MAX_BLOCKS = 10;
const PREVIEW_MAX_CHARS = 400;
const PREVIEW_CODE_LINES = 4;
const TASK_PREFIX = /^\[([ xX])\]\s+/;
const EMBED_PREFIX = '::embed';

const parser = new MarkdownIt({ html: false, linkify: false });

interface Marks {
  bold: number;
  italic: number;
  strike: number;
  link: number;
}

function runFor(text: string, marks: Marks, code = false): NotePreviewRun {
  const run: NotePreviewRun = { text };
  if (marks.bold) run.bold = true;
  if (marks.italic) run.italic = true;
  if (marks.strike) run.strike = true;
  if (marks.link) run.link = true;
  if (code) run.code = true;
  return run;
}

const styleOf = ({ text: _text, ...style }: NotePreviewRun) => {
  void _text;
  return JSON.stringify(style);
};

/** Add `run`, merging it into the previous run when the formatting is the same. */
function appendRun(runs: NotePreviewRun[], run: NotePreviewRun): void {
  if (!run.text) return;
  const last = runs[runs.length - 1];
  if (last && styleOf(last) === styleOf(run)) last.text += run.text;
  else runs.push({ ...run });
}

/** The runs of one inline token, merging neighbours with the same formatting. */
function inlineRuns(token: Token): NotePreviewRun[] {
  const marks: Marks = { bold: 0, italic: 0, strike: 0, link: 0 };
  const runs: NotePreviewRun[] = [];
  const push = (run: NotePreviewRun) => appendRun(runs, run);
  for (const child of token.children ?? []) {
    switch (child.type) {
      case 'text':
        push(runFor(child.content, marks));
        break;
      case 'code_inline':
        push(runFor(child.content, marks, true));
        break;
      case 'softbreak':
        push(runFor(' ', marks));
        break;
      case 'hardbreak':
        push(runFor('\n', marks));
        break;
      case 'image':
        push(runFor(splitMediaWidth(child.content).label || 'image', { ...marks, italic: 1 }));
        break;
      case 'strong_open':
        marks.bold++;
        break;
      case 'strong_close':
        marks.bold--;
        break;
      case 'em_open':
        marks.italic++;
        break;
      case 'em_close':
        marks.italic--;
        break;
      case 's_open':
        marks.strike++;
        break;
      case 's_close':
        marks.strike--;
        break;
      case 'link_open':
        marks.link++;
        break;
      case 'link_close':
        marks.link--;
        break;
      default:
        break;
    }
  }
  const first = runs[0];
  // A `::embed[label](url)` line shows as a play marker and its label.
  if (first && !first.link && first.text.startsWith(EMBED_PREFIX) && runs.length > 1) {
    first.text = `▶ ${first.text.slice(EMBED_PREFIX.length)}`;
    const last = runs.at(-1);
    if (last?.link) last.text = splitMediaWidth(last.text).label;
  }
  return runs;
}

const runsText = (runs: NotePreviewRun[]) => runs.map((run) => run.text).join('');

/** Trim the preview to its character budget, cutting the last run and marking the cut. */
function clip(blocks: NotePreviewBlock[]): NotePreviewBlock[] {
  let budget = PREVIEW_MAX_CHARS;
  const out: NotePreviewBlock[] = [];
  for (const block of blocks) {
    if (budget <= 0) break;
    const runs: NotePreviewRun[] = [];
    for (const run of block.runs) {
      if (budget <= 0) break;
      if (run.text.length <= budget) {
        runs.push(run);
        budget -= run.text.length;
      } else {
        let cut = run.text.slice(0, budget);
        if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
        runs.push({ ...run, text: `${cut}…` });
        budget = 0;
      }
    }
    out.push({ ...block, runs });
  }
  return out;
}

export function notePreview(body: string): NotePreviewBlock[] {
  const source = redactCensored(body).slice(0, PREVIEW_SCAN_CHARS);
  const tokens = parser.parse(source, {});
  const blocks: NotePreviewBlock[] = [];
  const lists: { ordered: boolean; next: number }[] = [];
  let quote = 0;
  let heading: NotePreviewKind | null = null;
  let item: { ordered: boolean; number: number; depth: number; used: boolean } | null = null;
  let row: NotePreviewRun[][] | null = null;

  const add = (block: NotePreviewBlock) => {
    if (block.kind === 'blank' && (blocks.at(-1)?.kind ?? 'blank') === 'blank') return;
    blocks.push(block);
  };

  for (const token of tokens) {
    if (blocks.length >= PREVIEW_MAX_BLOCKS + 1) break;
    switch (token.type) {
      case 'heading_open': {
        const level = Number(token.tag.slice(1));
        heading = level <= 1 ? 'h1' : level === 2 ? 'h2' : 'h3';
        break;
      }
      case 'heading_close':
        heading = null;
        break;
      case 'blockquote_open':
        quote++;
        break;
      case 'blockquote_close':
        quote--;
        break;
      case 'bullet_list_open':
        lists.push({ ordered: false, next: 0 });
        break;
      case 'ordered_list_open':
        lists.push({ ordered: true, next: Number(token.attrGet('start') ?? 1) || 1 });
        break;
      case 'bullet_list_close':
      case 'ordered_list_close':
        lists.pop();
        break;
      case 'list_item_open': {
        const list = lists[lists.length - 1];
        if (list) {
          item = {
            ordered: list.ordered,
            number: list.next++,
            depth: lists.length - 1,
            used: false,
          };
        }
        break;
      }
      case 'list_item_close':
        item = null;
        break;
      case 'tr_open':
        row = [];
        break;
      case 'tr_close':
        if (row) {
          const runs: NotePreviewRun[] = [];
          row.forEach((cell, i) => {
            if (i > 0) appendRun(runs, { text: ' · ' });
            for (const run of cell) appendRun(runs, run);
          });
          add({ kind: 'paragraph', runs });
        }
        row = null;
        break;
      case 'fence':
      case 'code_block': {
        const lines = token.content.replace(/\n$/, '').split('\n').slice(0, PREVIEW_CODE_LINES);
        add({ kind: 'code', runs: [{ text: lines.join('\n'), code: true }] });
        break;
      }
      case 'inline': {
        const runs = inlineRuns(token);
        if (row) {
          row.push(runs);
          break;
        }
        const text = runsText(runs);
        if (!heading && !item && !text.trim()) {
          add({ kind: 'blank', runs: [] });
          break;
        }
        if (heading) {
          add({ kind: heading, runs });
        } else if (item && !item.used) {
          item.used = true;
          const task = TASK_PREFIX.exec(runs[0]?.text ?? '');
          if (task && runs[0]) {
            runs[0] = { ...runs[0], text: runs[0].text.slice(task[0].length) };
            add({ kind: 'task', runs, depth: item.depth, checked: task[1] !== ' ' });
          } else if (item.ordered) {
            add({ kind: 'ordered', runs, depth: item.depth, number: item.number });
          } else {
            add({ kind: 'bullet', runs, depth: item.depth });
          }
        } else {
          add({ kind: quote ? 'quote' : 'paragraph', runs });
        }
        break;
      }
      default:
        break;
    }
  }
  while (blocks.at(-1)?.kind === 'blank') blocks.pop();
  return clip(blocks.slice(0, PREVIEW_MAX_BLOCKS));
}
