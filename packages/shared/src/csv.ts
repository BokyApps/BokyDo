/**
 * CSV for import and export (RFC 4180 with the usual leniencies). Files are untrusted input: the
 * parser enforces size, row, column and cell limits, rejects binary data, and never throws
 * anything but `CsvError`. The writer is safe by default against spreadsheet formula injection.
 */

export type CsvErrorCode =
  | 'empty'
  | 'binary'
  | 'too_large'
  | 'too_many_rows'
  | 'too_many_columns'
  | 'cell_too_long'
  | 'unterminated_quote';

export class CsvError extends Error {
  constructor(
    readonly code: CsvErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CsvError';
  }
}

export interface CsvLimits {
  /** Characters in the whole text (the web app also checks the file size before reading). */
  maxChars: number;
  maxRows: number;
  maxColumns: number;
  maxCellChars: number;
}

export const DEFAULT_CSV_LIMITS: CsvLimits = {
  maxChars: 2 * 1024 * 1024,
  maxRows: 2000,
  maxColumns: 40,
  maxCellChars: 20_000,
};

/** The characters a spreadsheet may take as the start of a formula (OWASP CSV injection). */
const FORMULA_START = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Make a cell safe to open in a spreadsheet: a value that could start a formula gets a leading
 * apostrophe, which spreadsheets display as plain text. `unguardFormula` reverses it on import.
 */
export function guardFormula(value: string): string {
  return value !== '' && FORMULA_START.has(value.charAt(0)) ? `'${value}` : value;
}

/** Undo `guardFormula` (only where it would have applied, so ordinary apostrophes stay). */
export function unguardFormula(value: string): string {
  return value.charAt(0) === "'" && FORMULA_START.has(value.charAt(1)) ? value.slice(1) : value;
}

/** Zip, gzip and other binary containers start with bytes that are not text. */
function looksBinary(text: string): boolean {
  return (
    text.startsWith('PK\u0003\u0004') || text.startsWith('\u001f\u008b') || text.includes('\0')
  );
}

/** Pick `,` or `;` from the first line (Excel in many locales writes semicolons). */
function detectDelimiter(text: string): string {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '\n' || ch === '\r')) break;
    else if (!quoted && ch === ',') commas++;
    else if (!quoted && ch === ';') semicolons++;
  }
  return semicolons > commas ? ';' : ',';
}

/**
 * Parse CSV text into rows of cells. Handles a byte-order mark, CRLF/LF/CR line ends, quoted
 * cells with embedded commas, quotes and line breaks. A stray quote inside an unquoted cell is
 * kept as text. Blank lines come back as a row with one empty cell.
 */
export function parseCsv(input: string, limits: CsvLimits = DEFAULT_CSV_LIMITS): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  if (text.trim() === '') throw new CsvError('empty', 'The file is empty.');
  if (looksBinary(text)) throw new CsvError('binary', 'That file is not a text (CSV) file.');
  if (text.length > limits.maxChars) throw new CsvError('too_large', 'The file is too large.');

  const delimiter = detectDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let wasQuoted = false;

  const endCell = () => {
    if (cell.length > limits.maxCellChars)
      throw new CsvError('cell_too_long', 'A cell in the file is too long.');
    row.push(cell);
    if (row.length > limits.maxColumns)
      throw new CsvError('too_many_columns', 'The file has too many columns.');
    cell = '';
    wasQuoted = false;
  };
  const endRow = () => {
    endCell();
    rows.push(row);
    if (rows.length > limits.maxRows)
      throw new CsvError('too_many_rows', 'The file has too many rows.');
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (quoted) {
      if (ch === '"') {
        if (text.charAt(i + 1) === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += ch;
      if (cell.length > limits.maxCellChars)
        throw new CsvError('cell_too_long', 'A cell in the file is too long.');
    } else if (ch === '"' && cell === '' && !wasQuoted) {
      quoted = true;
      wasQuoted = true;
    } else if (ch === delimiter) endCell();
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text.charAt(i + 1) === '\n') i++;
      endRow();
    } else cell += ch;
  }
  if (quoted) throw new CsvError('unterminated_quote', 'A quoted cell is never closed.');
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/**
 * Write rows as CSV (CRLF line ends, UTF-8). Every cell is formula-guarded, so a title like
 * `=HYPERLINK(...)` can't run when the file is opened in a spreadsheet.
 */
export function writeCsv(rows: readonly (readonly string[])[]): string {
  return (
    rows.map((row) => row.map((cell) => quote(guardFormula(cell))).join(',')).join('\r\n') + '\r\n'
  );
}
