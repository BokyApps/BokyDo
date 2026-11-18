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
shape as the notes routes'. `limits` is an optional route option, and the pipeline behind it
(`runNoteExport`, in `export.ts`) also takes a `semaphore`: tests use small limits and their own
concurrency gate instead of giant documents.

Only the owner can export, and in any state — active, archived or trashed. Another user's note is
`404 not_found`; a note whose id is not a UUID is `400 validation_failed`.

The note and its `ready` files are read in **one `repeatable read` transaction**, so a file
uploaded or purged halfway through an export cannot appear in the Markdown but not the zip. The
bytes are then read from disk one file at a time; the transaction is about the rows.

## Status codes

| Status | `error`                 | When                                                              |
| ------ | ----------------------- | ----------------------------------------------------------------- |
| 400    | `validation_failed`     | the id is not a UUID, or `format` is not `md`, `docx` or `pdf`    |
| 403    | `project_limited_token` | a project-limited bearer token called the route                   |
| 404    | `not_found`             | no such note, or not the caller's                                 |
| 413    | `too_large`             | any document-level limit (see below) or the 200 MB byte cap       |
| 429    | `export_busy`           | this user already has one export running, or three in the process |
| 503    | `export_timeout`        | rendering passed the 30 s deadline                                |

## What each format does with a construct

| Construct                      | Markdown                                                        | DOCX                                  | PDF                                                     |
| ------------------------------ | --------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Title                          | `# Title` first line (omitted when blank)                       | Heading 1                             | 22 pt bold heading                                      |
| Headings 1–6                   | kept                                                            | Heading 1–6 styles                    | 22/18/15.5/13.5/12/11 pt bold                           |
| Bold / italic / strike         | kept                                                            | `w:b` / `w:i` / `w:strike`            | Helvetica bold/oblique; strike                          |
| Inline code                    | kept                                                            | Courier New                           | Courier                                                 |
| Code block                     | fenced, language kept, fence chosen from the content            | one shaded Courier paragraph per line | 9 pt Courier, indentation preserved                     |
| Quote                          | kept                                                            | left indent + italic                  | left indent + italic                                    |
| Bullet / ordered list          | kept, nested                                                    | Word list styles, nested, start kept  | `•` / `1.`, nested                                      |
| Task item                      | `- [ ]` / `- [x]`                                               | `☐` / `☑` prefix on a list item       | drawn checkbox                                          |
| Table                          | GFM table                                                       | real table, header shaded             | wrapped cells, rows break across pages, header repeated |
| Horizontal rule                | `---`                                                           | bottom border                         | grey rule                                               |
| Link (`http(s)`, `mailto`)     | kept                                                            | external hyperlink                    | one link annotation per link run                        |
| `bokydo:note/…`                | label only                                                      | label text                            | label text                                              |
| `bokydo:task/…`                | label only                                                      | label text                            | label text                                              |
| Embed `::embed[…]`             | `[label](openUrl)`                                              | `▶ label — openUrl` hyperlink         | `» label — openUrl` hyperlink                           |
| File link                      | `files/<id>-<name>` inside the zip, else the file's name        | the file's name                       | the file's name                                         |
| Image (PNG/JPEG note file)     | `![alt](files/<id>-<name>)` inside the zip, else `[image: alt]` | embedded, scaled to the text column   | embedded, scaled to the text column                     |
| Image inside a paragraph       | kept as `![alt](…)` when zipped, else `[image: alt]`            | embedded inline (Word allows it)      | `[image: name]` (no inline placement)                   |
| Remote image (not a note file) | `[alt](url)` — a link, never `![…]`                             | `[image: alt]`                        | `[image: alt]`                                          |
| Any other image                | `[image: name]`                                                 | `[image: name]`                       | `[image: name]`                                         |
| Censored span                  | `█████`                                                         | `█████`                               | solid bar                                               |

Raw HTML is not passed through anywhere: `markdown-it` runs with `html: false`, and text that
looks like HTML is escaped like any other text.

## Censored text in titles and filenames

`redactCensored` (from `@bokydo/shared`, deliberately lenient) is applied to the **title** and to
**every filename** before anything is derived from them: the Markdown heading, the DOCX title,
the PDF `Info` title, the `Content-Disposition` filename (including the percent-decoded
`filename*` form), the zip entry paths, and the alt/name text of images. A note whose title holds
a token therefore exports as `█████`, not as ciphertext, and no censor token can reach a header or
a metadata field.

The rule in ADR 0025 is about note **text**: censored spans in the body are replaced before the
body is parsed. **Attachment bytes are copied verbatim** — a PNG or PDF attached to a note is
byte-for-byte the file the user uploaded, and censoring never rewrites it. A censor token inside
an attached file is not touched, because the server cannot know what an opaque format contains;
censoring covers the note's text, not the files hanging off it.

## Markdown

A note that references no note file is one `.md` file. A note that references at least one
`note_files` row of its own becomes a `.zip`:

```
<Title>.md
files/<file-id>-<filename>
```

Links and images in `<Title>.md` are rewritten from `/api/v1/note-files/<uuid>` to the relative
path (`encodeURI`-escaped where the name needs it), `bokydo:` links lose the link and keep the
label, and embeds become `[label](openUrl)`.

### Fences are chosen from the content

A code block is written with a fence that the body cannot close or forge: one pass computes the
longest run of backticks and of tildes in the code, and of the fence character in the info
string. The fence character never appears in the info string, and the fence is longer than the
longest run anywhere in the block. The same idea bounds inline code spans. The property is
tested by reparsing the export with `markdown-it` **`html: true`**: no `html_block` or
`html_inline` token may come out of a code block, so an export can never reactivate HTML.

### Remote images

An image that is not a note file is written as a **link** (`[alt](url)`), never as `![alt](url)`:
opening the `.md` file must not fetch anything from a third party. Only images that are actually
inside the zip use image syntax. A destination the app would not open (`javascript:`, `file:`, …)
is written as plain `[image: alt]` text.

### Files that are gone

Every referenced file is probed (`open`, then the handle is closed) **before** the `.md` entry is
written, so the Markdown and the archive agree:

- bytes are there → the link points into `files/` and the entry is written with
  `ZipWriter.addFile`, which opens the file before writing its entry header;
- bytes are gone (`ENOENT`) → the reference becomes plain text `[file unavailable: <name>]` and
  the file is left out; if nothing is left, the export is a plain `.md` file, not a zip of one;
- the file vanishes between the probe and the entry, or the read fails after the entry started
  (a directory where the file was gives `EISDIR`) → the archive is **aborted**, because a valid
  ZIP quietly missing a file is worse than a broken download.

### Archive paths

`safeEntryName` (in `src/zip/zip-writer.ts`) makes every entry safe on Windows as well as Unix:
drive designators (`C:`) and backslashes never become a directory, `:` `*` `?` `"` `<` `>` `|` and
control characters are removed or replaced, a name ending in a dot or space loses them, the
reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`, with or without
an extension) are prefixed with `_`, `..` segments are dropped, and each component is bounded to
200 UTF-8 bytes without splitting a character. The file id in `files/<id>-<name>` keeps two files
with the same name apart.

The ZIP is written with `src/zip/zip-writer.ts`, the same streaming writer the account export
uses. When the reader goes away (client disconnect) the writer's pending writes reject instead of
waiting for a `'drain'` that never comes, so the producer stops.

## Censored spans

`redactCensored` from `@bokydo/shared` replaces every valid `{{censored:v1:…}}` token with `█████`
before the body is parsed. The token — and therefore any ciphertext — never reaches an output; a
malformed token is inert text. In PDF the placeholder is drawn as a filled rectangle rather than
text, because the built-in fonts have no `█` glyph.

## Images

Only note files of the note being exported, with a PNG or JPEG that passes a full structural
validation, are embedded:

- at most 10 MB per image,
- at most 40 megapixels (read from the PNG IHDR or the JPEG SOF header before any decoder sees
  the bytes),
- at most 100 MB of image bytes in one export (otherwise `413 too_large`); the budget is summed
  from the declared sizes and again from the bytes actually read.

**PNG** must be: a valid signature; a chunk walk where every chunk length fits in the bytes left
and every chunk carries a CRC-32 that matches; `IHDR` first, with a valid bit depth/colour type and
the usual compression/filter/interlace fields; at least one `IDAT`; `IEND` last with nothing after
it. A bad CRC, a truncated chunk, a missing `IDAT`, trailing bytes and absurd dimensions are all
refused.

That is necessary because `pdfkit`'s `PNGImage` does not pass every PNG through: for alpha
(colour types 4 and 6), indexed colour with `tRNS`, and interlaced files it calls png-js
`decodePixels`, which inflates the data inside an asynchronous zlib callback — a throw there is
not a stream error, it escapes to the process. A `tRNS` on greyscale/truecolour only adds a
`/Mask` and `PLTE` only changes the declared colour space, but both are refused too: the first
because the rule is a narrow allow-list, the second because the pass-through data would be
labelled `Indexed`. For the class it does pass through (8-bit greyscale or truecolour, colour type 0 or 2,
non-interlaced, no `tRNS`, no `PLTE`) `embed()` ends the XObject with `imgData` — the raw `IDAT`
bytes — and a `DecodeParms` predictor; it never inflates the data (`node_modules/pdfkit/js/pdfkit.js`,
`class PNGImage`, `embed()`: `if (isInterlaced && true) return this.decodeData(); … this.finalize()`,
and `finalize()` → `this.obj.end(this.imgData)`). `PLTE` is excluded because `embed()` would
declare an `Indexed` colour space over pass-through truecolour data.

So in **PDF** a PNG is embedded only when it is also in that class; every other PNG is written as
`[image: name]`. **DOCX** copies the original bytes into the archive and has no decoder, so it
takes every structurally valid PNG (alpha and interlace included) — the structure is still
checked, so Word and a PNG decoder cannot disagree about the file.

**JPEG** must have `SOI`, segment lengths that fit inside the file, a `SOF` before the scan that
carries sane dimensions, and `EOI` as the last two bytes. `pdfkit` reads only the markers and
passes the bytes through as `DCTDecode`.

An image that cannot be embedded is rendered as `[image: <name>]`. Images are scaled to the A4
text column and never enlarged. Each file is parsed once per export (`doc.openImage` in PDF, one
`ImageRun` per file in DOCX), so a file placed several times costs one prepared object.

## PDF specifics

- **Tables.** Column widths come from the content (each column's natural width, scaled into the
  text column with a minimum), cell text wraps in its column, rows break across pages and the
  header row is repeated at the top of every page the table continues on. A row taller than a
  page is drawn over several segments rather than overflowing the margin.
- **Links.** A link annotation covers a contiguous run of text with the same destination
  (`doc.link`), not each word, which keeps the annotation count proportional to the links and not
  to the words.
- **Inline images** are not placed inside a line: `pdfkit` lines are drawn atom by atom, so an
  image in a paragraph or table cell is `[image: name]`. A picture on its own line is embedded.
- **File links** show the file's name, because a note-file URL means nothing outside the app.

## DOCX specifics

- Ordered lists carry their start number (`7. eight` numbers 7, 8, …) and each list is its own
  numbering instance, so a later list starts again instead of continuing the previous one.
- Inline images are real runs, so a picture inside a paragraph stays inline.
- The archive is built by the `docx` packer as one buffer before it is streamed.

## Limits and memory

| Limit                      | Value             | Enforced where                                    |
| -------------------------- | ----------------- | ------------------------------------------------- |
| Markdown tokens            | 200,000           | right after `md.parse`, before the document model |
| Blocks (incl. rows, items) | 50,000            | after parsing, before rendering                   |
| Table cells                | 100,000           | same walk                                         |
| Inline runs                | 500,000           | same walk                                         |
| Image placements           | 500               | same walk (a file placed 500 times is 500)        |
| Link annotations (PDF)     | 20,000            | while drawing, after coalescing                   |
| Output bytes               | 200 MB            | the response stream is destroyed past this        |
| Render time                | 30 s              | checked between blocks and between zip entries    |
| Concurrent exports         | 1/user, 3/process | `429 export_busy`                                 |

The token cap has to bite before the block cap can be dodged: markdown-it is linear, but a body of
one-character list items produces seven tokens per two blocks, so a body that is under the block
cap can still be hundreds of thousands of tokens. Counting `md.parse`'s output first is cheap and
happens before the walker.

Markdown is a string; the zip and PDF are streamed. DOCX is the one format whose in-memory size is
the whole archive, bounded by the 100 MB image budget.

## Not letting a renderer crash the process

Rendering is structured so no exception can escape a callback:

- the PNG/JPEG rules above remove the one code path in `pdfkit` that throws from an asynchronous
  zlib callback;
- a render is built inside the request promise, so a synchronous throw (a limit, the deadline, a
  decoder refusal) becomes a rejection the route turns into a status code, before headers;
- every stream the export creates or sends has an `'error'` listener: the source, the byte-cap
  transformer and `reply.raw`. An error destroys the response instead of becoming an unhandled
  event, and the export slot is released on `end`/`close`/timeout whichever comes first;
- `docx`'s packer stream is an old-style emitter with no `destroy()`; the reply's close destroys
  the `PassThrough` it writes into, and its write error is handled rather than left unhandled.

## Cancellation

The route listens on `reply.raw` `'close'`: on a client disconnect it destroys the source stream
(so the zip producer stops mid-entry and the PDF stops flushing), destroys the byte-cap
transformer and releases the export slot. `ZipWriter`'s writes observe `'close'` as well as
`'drain'`, and its deflate stream is destroyed when the destination goes away, so no producer can
hang forever on a buffer that nobody reads.

## PDF font limitation

PDFs use the built-in Helvetica and Courier families, which are WinAnsi (cp1252) only. There is no
bundled TTF/OTF in the repository that `pdfkit` could embed (`@fontsource` ships WOFF/WOFF2, which
`pdfkit` cannot read), so text outside cp1252 — Cyrillic, Greek, Khmer, CJK, emoji — is written as
`?` and the exporter documents that rather than embedding a font. Latin-1 and the cp1252
punctuation (curly quotes, dashes, `€`, `•`, …) are exact. `▶` (the embed marker) is written as
`»`; task checkboxes and censored spans are drawn, not typed, so they survive.

If a Unicode font is ever added, it belongs in this directory and should be registered once for
both `Helvetica`-substitute and `Courier`-substitute use.

## Tests

`apps/server/src/note-export/*.test.ts`:

- **ast** — every construct, censored spans (valid and malformed), HTML as text, the token cap
  checked before the document model, the block count.
- **image-info** — PNG/JPEG header reading, the full PNG chunk walk (CRC, chunk bounds, IHDR
  rules, `IDAT`/`IEND`, trailing bytes, 16-bit/interlaced/`tRNS`/`PLTE`), JPEG markers and `EOI`.
- **images** — which files are loaded for which format, the per-image and total budgets, a
  corrupt-CRC file never reaching a decoder.
- **markdown** — the writer, fence selection, the `html: true` reparse, remote images as links,
  unavailable files.
- **docx** — a real archive whose `word/document.xml`, `numbering.xml` and media entries are
  inspected, ordered-list starts, one media entry for a file placed twice, inline images, the
  deadline.
- **pdf** — uncompressed content streams: constructs, coalesced link annotations, the annotation
  cap, an alpha PNG rendered as text even when unvalidated, file links as names, table wrapping
  and page breaks with a repeated header, the deadline.
- **routes** — the HTTP surface against real Postgres: ownership, archived/trashed notes, scopes,
  project-limited tokens, hostile titles, redacted title/filenames in all three formats, the zip
  layout, missing and unreadable files, short limits for `429`/`413`/`503`, and every PNG class
  pdfkit would decode rendered as text without crashing.

`apps/server/src/zip/zip-writer.test.ts` covers the entry-name rules and a writer whose reader
disappears mid-entry.
