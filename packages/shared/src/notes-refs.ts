import MarkdownIt from 'markdown-it';

/**
 * The in-app links and note-file references in a note body (ADR 0025).
 *
 * This module is its own entry point (`@bokydo/shared/notes-refs`) rather than part of the barrel:
 * markdown-it is large and only the server derives links from a body, while the web imports the
 * barrel and must not pull the parser into its initial chunks.
 *
 * The parser is the editor's (`html: false`, `linkify: false`), so the rules are the same as the
 * ones the Markdown on screen follows:
 * - only a real link or image destination counts; plain text, bare UUIDs and look-alike URLs
 *   never do;
 * - code spans, code blocks and fenced code cannot produce one, by construction;
 * - escaped brackets in a label (`[Q4\].pdf](…)`) and `<…>` destinations are understood;
 * - reference-style links are resolved by the parser before we look at them, including nested
 *   images inside a link.
 */

export interface NoteRefs {
  noteIds: string[];
  taskIds: string[];
  fileIds: string[];
  /**
   * False when the body went past the parsing budget, so some references may be missing. A caller
   * must then only add claims, never drop them: an attachment after a hostile run of brackets
   * would otherwise be marked unreferenced and purged.
   */
  complete: boolean;
}

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const NOTE_HREF = new RegExp(`^bokydo:note/(${UUID})$`);
const TASK_HREF = new RegExp(`^bokydo:task/(${UUID})$`);
const FILE_HREF = new RegExp(`^/api/v1/note-files/(${UUID})(?:\\?inline=1)?$`);
const OPEN_BRACKET = 91;

/**
 * How many `[` characters the parser is given. markdown-it's label scan is linear but with a large
 * constant — a 512 KiB body of nothing but `[` costs about a second — and a body that reaches the
 * 1000-link cap contains a few thousand openers at most. Past this budget an opener is replaced
 * with a neutral letter in the copy we parse; the saved body is never touched, and a hostile body
 * can only cost its own author links.
 */
const MAX_LABEL_OPENERS = 50_000;

/** `body` with every `[` past the budget replaced, so the parser stays bounded on hostile input. */
function boundedBody(body: string): { text: string; complete: boolean } {
  let opens = 0;
  let parts: string[] | null = null;
  let copied = 0;
  for (let i = 0; i < body.length; i++) {
    if (body.charCodeAt(i) !== OPEN_BRACKET) continue;
    opens++;
    if (opens <= MAX_LABEL_OPENERS) continue;
    parts ??= [];
    parts.push(body.slice(copied, i), 'a');
    copied = i + 1;
  }
  if (!parts) return { text: body, complete: true };
  parts.push(body.slice(copied));
  return { text: parts.join(''), complete: false };
}

const parser = new MarkdownIt({ html: false, linkify: false });

/** Classify one destination by exact shape; no substring search, so look-alikes never match. */
function collect(
  destination: string | number | null,
  noteIds: Set<string>,
  taskIds: Set<string>,
  fileIds: Set<string>,
): void {
  if (typeof destination !== 'string') return;
  const note = NOTE_HREF.exec(destination)?.[1];
  if (note) {
    noteIds.add(note.toLowerCase());
    return;
  }
  const task = TASK_HREF.exec(destination)?.[1];
  if (task) {
    taskIds.add(task.toLowerCase());
    return;
  }
  const file = FILE_HREF.exec(destination)?.[1];
  if (file) fileIds.add(file.toLowerCase());
}

/**
 * The in-app links and note-file references in a Markdown body: exactly the destinations of type
 * `bokydo:note/<uuid>`, `bokydo:task/<uuid>` and `/api/v1/note-files/<uuid>` (optionally
 * `?inline=1`), lower-cased and de-duplicated, in first-seen order.
 */
export function extractNoteRefs(body: string): NoteRefs {
  const noteIds = new Set<string>();
  const taskIds = new Set<string>();
  const fileIds = new Set<string>();
  const bounded = boundedBody(body);
  for (const token of parser.parse(bounded.text, {})) {
    if (token.type !== 'inline') continue;
    for (const child of token.children ?? []) {
      if (child.type === 'link_open') collect(child.attrGet('href'), noteIds, taskIds, fileIds);
      else if (child.type === 'image') collect(child.attrGet('src'), noteIds, taskIds, fileIds);
    }
  }
  return {
    noteIds: [...noteIds],
    taskIds: [...taskIds],
    fileIds: [...fileIds],
    complete: bounded.complete,
  };
}
