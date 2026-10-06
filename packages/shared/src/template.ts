import { parseCsv, unguardFormula, writeCsv, type CsvLimits } from './csv.js';

/**
 * Project templates as Todoist writes them (one CSV row per section, task or comment), and the
 * in-memory shape BokyDo works with. Parsing is tolerant: columns are found by header name, extra
 * or missing columns are fine, and anything unusable is skipped with a warning instead of failing
 * the whole file. Text is only ever treated as text.
 */

/** Rows a template file may hold (Todoist itself allows 300 tasks per project). */
export const MAX_TEMPLATE_ROWS = 1000;
export const MAX_TEMPLATE_FILE_BYTES = 1024 * 1024;
/** Todoist allows indents 1–4. */
export const MAX_TEMPLATE_DEPTH = 3;

const TITLE_MAX = 1000;
const SECTION_MAX = 120;
const DESCRIPTION_MAX = 16_000;
const COMMENT_MAX = 15_000;
const MAX_WARNINGS = 50;

const TEMPLATE_CSV_LIMITS: CsvLimits = {
  maxChars: MAX_TEMPLATE_FILE_BYTES,
  maxRows: MAX_TEMPLATE_ROWS + 1,
  maxColumns: 40,
  maxCellChars: DESCRIPTION_MAX + 1000,
};

export interface TemplateTask {
  content: string;
  description: string;
  /** 1 (p1) … 4 (none). */
  priority: number;
  /** 0 for a top-level task, 1 for its sub-task, … */
  depth: number;
  /** A date as text: "tomorrow", "every monday at 9am", "2026-10-15 09:30". Read on import. */
  date: string | null;
  /** Fixed IANA zone for a timed date; null for floating. */
  timezone: string | null;
  durationMinutes: number | null;
  deadline: string | null;
  comments: string[];
}

export interface TemplateSection {
  name: string;
  tasks: TemplateTask[];
}

export interface Template {
  name: string;
  /** Tasks before the first section. */
  tasks: TemplateTask[];
  sections: TemplateSection[];
}

export interface TemplateWarning {
  /** Line number in the file, or null when it isn't about one row. */
  row: number | null;
  message: string;
}

export interface TemplateParse {
  template: Template;
  warnings: TemplateWarning[];
}

export const HEADER = [
  'TYPE',
  'CONTENT',
  'DESCRIPTION',
  'PRIORITY',
  'INDENT',
  'AUTHOR',
  'RESPONSIBLE',
  'DATE',
  'DATE_LANG',
  'TIMEZONE',
  'DURATION',
  'DURATION_UNIT',
  'META',
  'DEADLINE',
  'DEADLINE_LANG',
  'IS_COLLAPSED',
] as const;

export function countTemplate(t: Template): { sections: number; tasks: number; comments: number } {
  const all = [...t.tasks, ...t.sections.flatMap((s) => s.tasks)];
  return {
    sections: t.sections.length,
    tasks: all.length,
    comments: all.reduce((n, task) => n + task.comments.length, 0),
  };
}

// Control characters are replaced, matching what the command schemas accept: none in single-line
// text, and none but tab, LF and CR in multi-line text.
// eslint-disable-next-line no-control-regex
const SINGLE_LINE_BAD = /[\u0000-\u001f\u007f]/g;
// eslint-disable-next-line no-control-regex
const MULTI_LINE_BAD = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const oneLine = (s: string) =>
  s
    .split(/[\r\n]+/)
    .map((part) => part.replace(SINGLE_LINE_BAD, ' ').trim())
    .filter((part) => part !== '')
    .join(' ');

/**
 * Read a template CSV. Throws `CsvError` for a file that isn't usable at all (empty, binary, too
 * big, broken quoting) and `Error` when the header names no CONTENT column.
 */
export function parseTemplateCsv(text: string, name: string): TemplateParse {
  const rows = parseCsv(text, TEMPLATE_CSV_LIMITS);
  const header = (rows[0] ?? []).map((h) => h.trim().toUpperCase());
  const col = (n: string) => header.indexOf(n);
  const at = (cells: string[], n: string): string => {
    const i = col(n);
    return i < 0 ? '' : oneLine(unguardFormula(cells[i] ?? ''));
  };
  if (col('CONTENT') < 0)
    throw new Error('This does not look like a Todoist-style CSV: there is no CONTENT column.');

  const warnings: TemplateWarning[] = [];
  let suppressed = 0;
  const warn = (row: number | null, message: string) => {
    if (warnings.length < MAX_WARNINGS) warnings.push({ row, message });
    else suppressed++;
  };

  const template: Template = { name, tasks: [], sections: [] };
  let list = template.tasks;
  let last: TemplateTask | null = null;
  let depth = 0;

  rows.slice(1).forEach((cells, index) => {
    const row = index + 2;
    if (cells.every((c) => c.trim() === '')) return;
    const type = at(cells, 'TYPE').toLowerCase();
    // Cells are read raw so descriptions and comments keep their line breaks.
    const raw = (n: string) =>
      unguardFormula(cells[col(n)] ?? '')
        .replace(MULTI_LINE_BAD, ' ')
        .trim();

    if (type === 'meta') return;
    if (type === 'section') {
      let sectionName = at(cells, 'CONTENT');
      if (!sectionName) return warn(row, 'A section with no name was skipped.');
      if (sectionName.length > SECTION_MAX) {
        sectionName = sectionName.slice(0, SECTION_MAX);
        warn(row, `The section name was shortened to ${SECTION_MAX} characters.`);
      }
      const section: TemplateSection = { name: sectionName, tasks: [] };
      template.sections.push(section);
      list = section.tasks;
      last = null;
      depth = 0;
      return;
    }
    if (type === 'note') {
      let comment = raw('CONTENT');
      if (!comment) return;
      if (!last) return warn(row, 'A comment with no task before it was skipped.');
      if (comment.length > COMMENT_MAX) {
        comment = comment.slice(0, COMMENT_MAX);
        warn(row, 'A long comment was shortened.');
      }
      last.comments.push(comment);
      return;
    }
    if (type !== 'task') return warn(row, `A row of type “${type || 'blank'}” was skipped.`);

    let content = at(cells, 'CONTENT');
    if (!content) return warn(row, 'A task with no title was skipped.');
    if (content.length > TITLE_MAX) {
      content = content.slice(0, TITLE_MAX);
      warn(row, `A long title was shortened to ${TITLE_MAX} characters.`);
    }
    let description = raw('DESCRIPTION');
    if (description.length > DESCRIPTION_MAX) {
      description = description.slice(0, DESCRIPTION_MAX);
      warn(row, 'A long description was shortened.');
    }

    const priorityText = at(cells, 'PRIORITY');
    let priority = Number.parseInt(priorityText, 10);
    if (!(priority >= 1 && priority <= 4)) {
      if (priorityText) warn(row, `Priority “${priorityText}” isn't 1–4; used 4 (none).`);
      priority = 4;
    }

    // A task nests under the one above it: at most one level deeper, and within Todoist's limit.
    const indent = Number.parseInt(at(cells, 'INDENT'), 10);
    const wanted = Number.isFinite(indent) && indent >= 1 ? indent - 1 : 0;
    const allowed = Math.min(wanted, last ? depth + 1 : 0, MAX_TEMPLATE_DEPTH);
    if (allowed !== wanted) warn(row, 'A task was indented too far; it was moved up a level.');
    depth = allowed;

    let durationMinutes: number | null = null;
    const durationText = at(cells, 'DURATION');
    if (durationText) {
      const unit = at(cells, 'DURATION_UNIT').toLowerCase();
      const n = Number.parseInt(durationText, 10);
      const minutes = unit === 'day' ? n * 24 * 60 : n;
      if (
        (unit === '' || unit === 'minute' || unit === 'day') &&
        minutes >= 1 &&
        minutes <= 24 * 60
      )
        durationMinutes = minutes;
      else if (unit !== 'none') warn(row, 'A duration could not be read and was left out.');
    }

    const task: TemplateTask = {
      content,
      description,
      priority,
      depth,
      date: at(cells, 'DATE') || null,
      timezone: at(cells, 'TIMEZONE') || null,
      durationMinutes,
      deadline: at(cells, 'DEADLINE') || null,
      comments: [],
    };
    list.push(task);
    last = task;
  });

  if (suppressed > 0) warnings.push({ row: null, message: `…and ${suppressed} more notes.` });
  return { template, warnings };
}

/** Write a template as a Todoist-style CSV (every cell is formula-guarded by `writeCsv`). */
export function serializeTemplateCsv(template: Template): string {
  const rows: string[][] = [[...HEADER]];
  const blank = (type: string, content: string): string[] => {
    const cells = HEADER.map(() => '');
    cells[0] = type;
    cells[1] = content;
    return cells;
  };
  const addTasks = (tasks: TemplateTask[]) => {
    for (const t of tasks) {
      const cells = blank('task', t.content);
      cells[2] = t.description;
      cells[3] = String(t.priority);
      cells[4] = String(t.depth + 1);
      if (t.date) {
        cells[7] = t.date;
        cells[8] = 'en';
        cells[9] = t.timezone ?? '';
      }
      if (t.durationMinutes) {
        cells[10] = String(t.durationMinutes);
        cells[11] = 'minute';
      }
      if (t.deadline) {
        cells[13] = t.deadline;
        cells[14] = 'en';
      }
      rows.push(cells);
      for (const comment of t.comments) rows.push(blank('note', comment));
    }
  };
  addTasks(template.tasks);
  for (const section of template.sections) {
    const cells = blank('section', section.name);
    cells[15] = 'FALSE';
    rows.push(cells);
    addTasks(section.tasks);
  }
  return writeCsv(rows);
}
