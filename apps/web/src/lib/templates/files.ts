import {
  CsvError,
  MAX_TEMPLATE_FILE_BYTES,
  parseTemplateCsv,
  type TemplateParse,
} from '@bokydo/shared';

/** A file name made from a project or template name: safe on every system, never empty. */
export function safeFilename(name: string, extension = 'csv'): string {
  let base = '';
  for (const ch of name.normalize('NFKC')) {
    const code = ch.codePointAt(0) ?? 0;
    base += code < 0x20 || code === 0x7f || '\\/:*?"<>|'.includes(ch) ? '-' : ch;
  }
  base = base.trim().slice(0, 60).trim();
  while (base.startsWith('.') || base.startsWith('-')) base = base.slice(1);
  return `${base || 'project'}.${extension}`;
}

/** The project name to suggest for an imported file: its name without the extension. */
export function templateNameFromFile(filename: string): string {
  const withoutExtension = filename.replace(/\.[A-Za-z0-9]{1,5}$/, '');
  const name = withoutExtension.replaceAll('_', ' ').trim().slice(0, 120);
  return name || 'Imported project';
}

/** What to tell the user when a file can't be read at all. */
export function describeTemplateError(err: unknown): string {
  if (err instanceof CsvError) {
    switch (err.code) {
      case 'empty':
        return 'That file is empty.';
      case 'binary':
        return 'That is not a CSV text file. Export a project as CSV from Todoist and choose that file.';
      case 'too_large':
        return 'That file is too large. Templates are limited to 1 MB.';
      case 'too_many_rows':
        return 'That file has too many rows. Templates are limited to 1,000 rows: split it into smaller files.';
      case 'too_many_columns':
        return 'That file has too many columns to be a Todoist-style CSV.';
      case 'cell_too_long':
        return 'Something in that file is far too long for a task title or description.';
      case 'unterminated_quote':
        return 'That file is damaged: a quoted value is never closed.';
    }
  }
  if (err instanceof Error && err.message.includes('CONTENT'))
    return 'That does not look like a Todoist-style CSV: it has no CONTENT column.';
  return 'That file could not be read.';
}

export class TemplateFileError extends Error {}

/** Read a chosen file as a template, refusing anything oversize before it is even loaded. */
export async function readTemplateFile(file: File): Promise<TemplateParse> {
  if (file.size > MAX_TEMPLATE_FILE_BYTES)
    throw new TemplateFileError(describeTemplateError(new CsvError('too_large', '')));
  try {
    return parseTemplateCsv(await file.text(), templateNameFromFile(file.name));
  } catch (err) {
    throw new TemplateFileError(describeTemplateError(err));
  }
}

/** Offer text as a file download (nothing is sent anywhere). */
export function downloadText(
  filename: string,
  text: string,
  type = 'text/csv;charset=utf-8',
): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
