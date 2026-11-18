# Note export (Markdown, DOCX, PDF)

`GET /api/v1/notes/:id/export?format=md|docx|pdf` renders a note on the server, so the web app,
REST clients and MCP get byte-identical files. The design lives in
[ADR 0025](adr/0025-notes.md#export); this page is the implementation's own notes.

## Registering it

```ts
registerNoteExportRoutes(app, { db, store });
```

`db` is the drizzle handle (`DbHandle['db']`) and `store` is the `<dataDir>/note-files`
`AttachmentStore` (note files never share the attachment directory). The route declares
`{ access: 'user', scopes: ['notes:read'] }` and refuses project-limited tokens with
`403 project_limited_token`, so its entry in `apps/server/src/authz-matrix.test.ts` is the same
shape as the notes routes'.

Only the owner can export, and in any state — active, archived or trashed. Another user's note is
`404 not_found`; a note whose id is not a UUID is `400 validation_failed`; the block limit is
`413 too_large`.

## What each format does with a construct

| Construct                  | Markdown                                                        | DOCX                                  | PDF                                 |
| -------------------------- | --------------------------------------------------------------- | ------------------------------------- | ----------------------------------- |
| Title                      | `# Title` first line (omitted when blank)                       | Heading 1                             | 22 pt bold heading                  |
| Headings 1–6               | kept                                                            | Heading 1–6 styles                    | 22/18/15.5/13.5/12/11 pt bold       |
| Bold / italic / strike     | kept                                                            | `w:b` / `w:i` / `w:strike`            | Helvetica bold/oblique; strike      |
| Inline code                | kept                                                            | Courier New                           | Courier                             |
| Code block                 | fenced, language kept                                           | one shaded Courier paragraph per line | 9 pt Courier, indentation preserved |
| Quote                      | kept                                                            | left indent + italic                  | left indent + italic                |
| Bullet / ordered list      | kept, nested                                                    | Word list styles, nested              | `•` / `1.`, nested                  |
| Task item                  | `- [ ]` / `- [x]`                                               | `☐` / `☑` prefix on a list item       | drawn checkbox                      |
| Table                      | GFM table                                                       | real table, header shaded             | simple grid                         |
| Horizontal rule            | `---`                                                           | bottom border                         | grey rule                           |
| Link (`http(s)`, `mailto`) | kept                                                            | external hyperlink                    | link annotation                     |
| `bokydo:note/…`            | label only                                                      | label text                            | label text                          |
| `bokydo:task/…`            | label only                                                      | label text                            | label text                          |
| Embed `::embed[…]`         | `[label](openUrl)`                                              | `▶ label — openUrl` hyperlink         | `» label — openUrl` hyperlink       |
| File link                  | `files/<id>-<name>` inside the zip, else label                  | the file's name                       | the file's name                     |
| Image (PNG/JPEG note file) | `![alt](files/<id>-<name>)` inside the zip, else `[image: alt]` | embedded, scaled to the text column   | embedded, scaled to the text column |
| Any other image            | `[image: name]`                                                 | `[image: name]`                       | `[image: name]`                     |
| Censored span              | `█████`                                                         | `█████`                               | solid bar                           |

Raw HTML is not passed through anywhere: `markdown-it` runs with `html: false`, and text that
looks like HTML is escaped like any other text.

## Markdown

A note that references no note file is one `.md` file. A note that references at least one
`note_files` row of its own becomes a `.zip`:

```
<Title>.md
files/<file-id>-<filename>
```

Links and images in `<Title>.md` are rewritten from `/api/v1/note-files/<uuid>` to the relative
path (`encodeURI`-escaped where the name needs it), `bokydo:` links lose the link and keep the
label, and embeds become `[label](openUrl)`. A reference to a file that has been purged, or to
another note's file, is not a reason to zip: it is shown as text.

The ZIP is written with `src/zip/zip-writer.ts`, the same streaming writer the account export
uses.

## Censored spans

`redactCensored` from `@bokydo/shared` replaces every valid `{{censored:v1:…}}` token with `█████`
before the body is parsed. The token — and therefore any ciphertext — never reaches an output; a
malformed token is inert text. In PDF the placeholder is drawn as a filled rectangle rather than
text, because the built-in fonts have no `█` glyph.

## Images

Only note files of the note being exported, with a PNG or JPEG header that sniffs from the file's
own bytes (never the client's claim), are embedded:

- at most 10 MB per image,
- at most 40 megapixels (read from the PNG IHDR or the JPEG SOF header before any decoder sees
  the bytes),
- at most 100 MB of images in one export (otherwise `413 too_large`).

Everything else is rendered as `[image: <name>]`. Images are scaled to the A4 text column and
never enlarged. The 40 MP and 10 MB checks mean a crafted header cannot make the exporter allocate
without bound; the 100 MB budget is summed from the declared sizes before a byte is read.

## PDF font limitation

PDFs use the built-in Helvetica and Courier families, which are WinAnsi (cp1252) only. There is no
bundled TTF/OTF in the repository that `pdfkit` could embed (`@fontsource` ships WOFF/WOFF2, which
`pdfkit` cannot read), so text outside cp1252 — Cyrillic, Greek, Khmer, CJK, emoji — is written as
`?` and the exporter documents that rather than embedding a font. Latin-1 and the cp1252
punctuation (curly quotes, dashes, `€`, `•`, …) are exact. `▶` (the embed marker) is written as
`»`; task checkboxes and censored spans are drawn, not typed, so they survive.

If a Unicode font is ever added, it belongs in this directory and should be registered once for
both `Helvetica`-substitute and `Courier`-substitute use.

## Limits and memory

- Parsing the body is linear in its length (the body is capped at 512 KiB by the database).
- More than 50,000 blocks — every heading, paragraph, list item, table row, quote block, counted
  recursively — is refused with `413` before rendering.
- Markdown is a string (≤ 1 MB) and the zip and PDF are streamed.
- DOCX is built by the `docx` packer, which produces the archive as one Node buffer before
  streaming it; its size is bounded by the 100 MB image budget. That is the one format whose
  in-memory size is not a few megabytes.

## Tests

`apps/server/src/note-export/*.test.ts`: the AST conversion for every construct, the Markdown
writer (including zip link rewriting and escaping), the image header reader, DOCX (a real zip whose
`word/document.xml` is inspected), PDF (uncompressed content streams), and the route against a
real Postgres — ownership, archived/trashed notes, scopes, project-limited tokens, hostile titles,
the zip layout and the block limit.
