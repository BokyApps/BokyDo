# ADR 0012: Templates: CSV import and export, and the gallery

- Status: Accepted (2026-10-06)

## Context

W11b lets people start a project from a template, move a project in or out as a CSV file in
Todoist's format, and pick from a small gallery. Files are untrusted input, and an import writes
many rows into a user's projects, so it must not become a way around the rules every other write
follows.

## Decision

- **An import is ordinary sync commands, built in the browser.** The file is read and previewed
  on the user's machine and turned into `project_add`, `section_add`, `task_add` and `comment_add`
  commands, sent through the same sync queue as anything typed by hand. There is no import
  endpoint and no file parsing on the server. The server therefore judges every row exactly like
  any other write (schemas, nesting depth, per-project limits, project permissions), and an import
  can't write into a project the user can't edit. A server-side importer for Todoist accounts
  (W11a) is a different problem with different trust (tokens, background jobs) and keeps its own
  design.
- **Todoist's format, read tolerantly.** Columns are found by name, in any order, and missing or
  extra columns are fine; row types are `task`, `section` and `note` (`meta` is ignored). Nesting
  comes from INDENT (at most one level deeper than the row above, up to Todoist's four). Nothing
  unusable stops the file: a row that can't be used is skipped with a warning that names its line,
  shown before the import. An empty priority becomes p4 rather than p1. AUTHOR and RESPONSIBLE
  are ignored on import and left empty on export: people are never created, invited or named by
  a file. The format follows Todoist's published column list; it has not been tried against
  Todoist's own importer.
- **Dates are phrases, read by the same parser as quick add.** "tomorrow at 9am" means tomorrow
  for whoever imports; a date that can't be read comes in without a date, with a note. Export
  writes a repeating task's phrase as typed and a one-off date as ISO, which no one's date-format
  setting can misread.
- **Limits at the door.** 1 MB, 1,000 rows, 40 columns and capped cell lengths, checked before
  and during one linear parsing pass; binary and zip files are refused with a plain message. A
  full import stays under the sync rate limit (1,200 commands a minute), and the client reports
  how many tasks the server actually accepted instead of assuming.
- **Safe to open anywhere.** Every cell the writer produces is formula-guarded (a leading
  apostrophe on `=`, `+`, `-`, `@`, tab or CR), safe by default rather than per column; on import
  the guard is removed only where it would have been added. Control characters in imported text are
  replaced to match what the command schemas accept, and imported text is displayed by the same
  escaping renderer as typed text.
- **The gallery is data.** Nine templates written for BokyDo ship in the web app as plain
  template objects. Tests plan each one into commands and check them against the server's own
  schemas, read every date phrase, and round-trip it through CSV, so the gallery can't drift from
  what import and export accept. Community-contributed galleries are a later question (they would
  need review and a trust model).
- **Parser and writer live in `packages/shared`**, so the server can reuse the injection-safe
  writer for the full export in W11e.

## Consequences

- A large import is paced by the sync rate limit and can take a minute or more; the dialog shows
  progress and keeps going in the background.
- The Todoist importer in W11a can reuse `parseTemplateCsv` for backup files, but must add its own
  limits for the larger inputs it accepts.
- Strings in the gallery are English only until i18n (W12c).
