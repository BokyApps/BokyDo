# Note export (Markdown, DOCX, PDF)

`GET /api/v1/notes/:id/export?format=md|docx|pdf` renders a note on the server, so the web app,
REST clients and MCP get byte-identical files. The design lives in
[ADR 0025](adr/0025-notes.md#export); this page is the implementation's own notes.

## Rendering happens in a worker

The request thread never parses attacker-controlled Markdown. Each export spawns one
`node:worker_threads` Worker (`src/note-export/worker.ts`) with
`resourceLimits: { maxOldGenerationSizeMb: 192, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 }`.
Everything that can be inflated by a note body runs there: the `markdown-it` parse, the AST and
limit walk, the `docx` packer and `pdfkit`. Full image validation (PNG chunk/CRC walk, JPEG
marker walk) also runs there; the main thread only stats the files and reads their bytes. The
main thread keeps the database snapshot, the file probes, the byte reads, and the zip stream,
and enforces every limit the worker cannot be trusted to enforce about its own output.

The worker is started and supervised by `src/note-export/runner.ts`. Protocol:

1. `analyze`: the body and the export limits; the worker parses once, checks token / block /
   table / run / image caps, and answers with the note-file ids it references and the measured
   document size. A parse that exceeds a cap answers `too_large`, which the route renders as 413.
2. `render`: the redacted title, file names/URLs, unavailable ids and (for DOCX/PDF) the image
   bytes are posted. `md` answers with the rendered text and the ids it actually wrote. DOCX and
   PDF answer with 1 MiB chunks, each waiting for an `ack` from the main thread before the next
   is produced, then a final `done`. Image `ArrayBuffer`s are transferred in, chunk
   `ArrayBuffer`s are transferred out, and the main thread counts every chunk against the
   100 MB output cap. The worker enforces the same cap while it generates: pdfkit's output is
   counted as `data` arrives and the document is destroyed the moment it passes 100 MB, and a
   DOCX is refused from a conservative pre-pack estimate (image bytes + 4 × text + 1 MB) and
   checked again against its real packed size.
3. `error`: `too_large`, `timeout` or `internal`. Before the first chunk the route maps that to
   413, 503 or 500; after it, the response stream is destroyed.

The 30 s deadline starts when the semaphore slot is acquired, not when the worker starts. On
expiry the main thread calls `worker.terminate()` and destroys the response. A client disconnect —
including one during analyse, before any header — aborts an `AbortController` and terminates the
worker at once. The semaphore slot is released from the worker's `'exit'` handler on every path,
so a killed-but-not-yet-exited thread cannot hold it, and admission is checked before the slot is
taken: if `rss + 400 MiB` would pass 85 % of the cgroup v2 `memory.max` (or total RAM when the
limit is `max`), the request is refused with `503 export_busy` and `Retry-After: 30`. A worker
that exits unexpectedly becomes `413 too_large` when it ran out of memory
(`ERR_WORKER_OUT_OF_MEMORY`) and `500 internal_error` otherwise; neither can become an uncaught
exception or an unhandled rejection.

Under vitest and `tsx watch` the worker entry is `worker-boot.ts`, which loads the real
`worker.ts` through tsx (`tsImport`). A built server spawns the sibling `worker.js` that
`tsconfig.build.json` emits, with no loader. Both paths are exercised: the test suite runs the
source path and the build check renders a PDF through `dist/note-export/runner.js`.

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

| Status | `error`                 | When                                                                                           |
| ------ | ----------------------- | ---------------------------------------------------------------------------------------------- |
| 400    | `validation_failed`     | the id is not a UUID, or `format` is not `md`, `docx` or `pdf`                                 |
| 403    | `project_limited_token` | a project-limited bearer token called the route                                                |
| 404    | `not_found`             | no such note, or not the caller's                                                              |
| 413    | `too_large`             | a body/document limit, the 25 MB image budget, worker OOM, or the 100 MB output cap            |
| 429    | `export_busy`           | this user already has one export running, one DOCX/PDF is running, or two Markdown exports are |
| 500    | `internal_error`        | the worker died for any other reason, before headers                                           |
| 503    | `export_busy`           | admitting this export would leave less than 15 % of the memory limit free (`Retry-After: 30`)  |
| 503    | `export_timeout`        | rendering (or the zip producer) passed the 30 s deadline                                       |

## What each format does with a construct

| Construct                      | Markdown                                                        | DOCX                                  | PDF                                                     |
| ------------------------------ | --------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------- |
| Title                          | `# Title` first line (omitted when blank)                       | Heading 1                             | 22 pt bold heading                                      |
| Headings 1–6                   | kept                                                            | Heading 1–6 styles                    | 22/18/15.5/13.5/12/11 pt bold                           |
| Bold / italic / strike         | kept                                                            | `w:b` / `w:i` / `w:strike`            | Noto Sans bold/oblique; strike                          |
| Inline code                    | kept                                                            | Courier New                           | Noto Sans Mono                                          |
| Code block                     | fenced, language kept, fence chosen from the content            | one shaded Courier paragraph per line | 9 pt Noto Sans Mono, indentation preserved              |
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
the PDF `Info` title, the `Content-Disposition` filename (including the decoded `filename*` form),
the zip entry paths, and the alt/name text of images. A note whose title holds a token therefore
exports as `█████`, not as ciphertext, and no censor token can reach a header or a metadata field.

Stored names are **not percent-decoded again**. Uploads already passed through `cleanFilename`,
which decodes once; the exporter uses `sanitizeStoredName` (`src/attachments/store.ts`), which only
removes control characters, `/`, `\`, leading dots and excess length. A stored literal
`%7B%7Bcensored:v1:…%7D%7D` is therefore not turned back into a token _after_ redaction. Because
emitting that literal would still put the ciphertext in a header or a zip path, the exporter also
redacts a percent-decoded form when — and only when — decoding reveals a censor marker; a benign
`Caf%C3%A9` stays encoded. Redaction is applied after sanitising, again to the final archive path
component, and again to the `filename*` text before it is percent-encoded.

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
longest run anywhere in the block. The same idea bounds inline code spans, and an inline span is
padded when its content starts or ends with a backtick. Adjacent code spans (and a code span next
to a code-only link) are separated by a literal space, and links whose whole label is inline code
keep their `[…](…)` wrapper: CommonMark matches a closing delimiter by exact run length, so two
touching runs can leave a span unterminated and release the rest of the line as raw HTML. The
property is tested by reparsing the export with `markdown-it` **`html: true`**: no `html_block` or
`html_inline` token may come out of a code block or a code/link corpus, so an export can never
reactivate HTML.

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
reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`) are prefixed with
`_`. The device-name check uses the stem before the **first** dot (`COM1.backup.txt` is still
`COM1`), with trailing spaces and dots removed and NFKC applied first, so `COM¹`, `COM²`, `ＣＯＮ`
and `con .txt` are caught too; `COM10` is not a device in any form. `..` segments are dropped.
Each component is bounded to 200 UTF-8 bytes without splitting a character. The file id in
`files/<id>-<name>` keeps two files with the same name apart. The same check is applied to the
`Content-Disposition` filename, so a note titled `CON` downloads as `_CON.pdf`, not as a Windows
device.

The ZIP is written with `src/zip/zip-writer.ts`, the same streaming writer the account export
uses. Each entry is one `stream/promises` `pipeline` (input → CRC counter → deflate → compressed
counter) into a **fresh `PassThrough` per entry**, and that pass-through is piped into the shared
output with `end: false`. The entry wrapper is unpiped and destroyed in `finally`. The shared
output therefore never gains a listener per entry — it carries one permanent `close`/`error`
handler that tears the active entries down — so a 10,000-entry archive has the same
`listenerCount('close')` as a one-entry archive and can never trip
`MaxListenersExceededWarning`. That is one observed promise per entry: when the reader goes away,
`pipeline` destroys the input and the compressor and rejects exactly once, instead of leaving a
second `done` promise unobserved — which used to be able to terminate Node with an unhandled
rejection.

The Markdown zip keeps the export slot after the render worker exits: it is released when the
archive has been fully read (`'end'`) or torn down (`'close'`), never when the worker exits. The
producer gets the request's disconnect signal and a timer at the export deadline; a stalled entry
(no reader, no `'drain'`) is aborted by that timer, the zip stream is destroyed, and the route
destroys the response. File entries are read 64 KiB at a time and check the signal and deadline
before every read, so a disconnect stops reading rather than finishing the file first.

## Censored spans

`redactCensored` from `@bokydo/shared` replaces every valid `{{censored:v1:…}}` token with `█████`
before the body is parsed. The token — and therefore any ciphertext — never reaches an output; a
malformed token is inert text. In PDF the placeholder is drawn as a filled rectangle rather than
text, so it looks the same with the bundled fonts and with the built-in fallback.

## Images

Only note files of the note being exported, with a PNG or JPEG that passes a full structural
validation, are embedded:

- at most 10 MB per image,
- at most 40 megapixels (read from the PNG IHDR or the JPEG SOF header before any decoder sees
  the bytes),
- at most 25 MB of image bytes in one export (otherwise `413 too_large`); the budget is summed
  from the declared sizes and again from the bytes actually read. Images are external buffers,
  so they are not counted by the worker's 192 MB heap limit; they are transferred, not cloned.

The main thread does only what needs the filesystem: `stat` each candidate against the per-image
and per-export budget, then one `fs.promises.readFile(path, { signal })` whose signal is aborted on
a client disconnect, the export deadline, or a worker failure. A `stat`/read that says the file is
gone skips it (`[image: name]`); an abort is thrown, never swallowed. The PNG chunk/CRC walk and
the JPEG marker walk happen in the worker, after the bytes are transferred.

**PNG** must be: a valid signature; a chunk walk where every chunk length fits in the bytes left
and every chunk carries a CRC-32 that matches; at most 10,000 chunks; `IHDR` first, with a bit
depth the spec allows for that colour type (`0`: 1/2/4/8/16; `2`, `4`, `6`: 8/16; `3`: 1/2/4/8)
and the usual compression/filter/interlace fields; at least one `IDAT` whose total is bounded by
the raw scanline size plus zlib's small framing overhead; `IEND` last, with length zero and nothing
after it. A bad CRC, a truncated chunk, a missing `IDAT`, a non-empty `IEND`, trailing bytes and
absurd dimensions are all refused. A file with 20,000 tiny chunks is refused after the 10,000th,
without walking the rest.

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

Before a PNG reaches `pdfkit` it is **rebuilt**: signature, the original `IHDR`, one `IDAT` made
from every `IDAT` payload, and an empty `IEND`, with every CRC recomputed. Every ancillary chunk
(`tEXt`, `zTXt`, `iTXt`, `iCCP`, `eXIf`, …) is dropped, so a 256 KiB metadata chunk cannot reach
png-js or pdfkit's chunk parser. `openImage()` is inside the same `try` as `doc.image()`, so any
image error still renders `[image: name]` rather than failing the export.

So in **PDF** a PNG is embedded only when it is also in that class; every other PNG is written as
`[image: name]`. **DOCX** copies the original bytes into the archive and has no decoder, so it
takes every structurally valid PNG (alpha and interlace included) — the structure, including the
IHDR bit-depth/colour-type combination, is still checked, so Word and a PNG decoder cannot
disagree about the file.

**JPEG** must have `SOI`, segment lengths that fit inside the file, and a `SOF` before the scan
that carries sane dimensions. The `EOI` is located with a bounded marker walk through the
entropy-coded data (skipping `FF 00` stuffing and `FF D0`–`FF D7` restart markers), and only the
bytes through that first `EOI` are embedded. One walk both validates and finds the `EOI`, so a
grammar JPEG is not scanned twice. An Android Motion Photo's appended video is therefore ignored
instead of being copied into the document; a JPEG with no `EOI` is still refused. `pdfkit` reads
only the markers and passes the bytes through as `DCTDecode`.

An image that cannot be embedded is rendered as `[image: <name>]`. Images are scaled to the A4
text column and never enlarged. PDF parses each file once (`doc.openImage`) and reuses the
prepared object. DOCX creates a new `ImageRun` per placement: `docx` deduplicates the media by a
hash of the bytes (one `word/media` entry), but the drawing id (`<wp:docPr id>`) lives on the run,
so reusing one run would give every placement the same id and Word could drop or repair the
duplicate drawing.

## PDF specifics

- **Tables.** Column widths come from the content (each column's natural width, scaled into the
  text column with a minimum), cell text wraps in its column, rows break across pages and the
  header row is repeated at the top of every page the table continues on. A row taller than a
  page is drawn over several segments rather than overflowing the margin. Minimum widths are
  checked **before** any width correction: if `columns × 24 pt` cannot fit the text column, the
  table is rendered as one `header: value` line per non-empty cell instead of a grid, so nothing
  overflows. A header row taller than a page is truncated to the page with `…` on the last line of
  each cell, leaving room for at least one body line, so it can still be repeated and a row is
  never starved off a page.
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
- Every placement is its own `ImageRun`, so every `<wp:docPr id>` is unique while the media is
  stored once.
- The archive is built by the `docx` packer as one buffer inside the worker before it is
  streamed; a worker that runs out of heap while packing becomes 413, not a crash.

## Limits and memory

| Limit                      | Value                             | Enforced where                                                               |
| -------------------------- | --------------------------------- | ---------------------------------------------------------------------------- |
| Body lines                 | 20,000                            | one linear pass before `md.parse`; CRLF counts once, a lone CR is a break    |
| Body `\|` characters       | 50,000                            | same pass — a sparse-table bomb fails in milliseconds                        |
| Markdown tokens            | 200,000                           | right after `md.parse`, before the document model                            |
| Blocks (incl. rows, items) | 50,000                            | after parsing, before rendering                                              |
| Table cells                | 100,000                           | same walk                                                                    |
| Inline runs                | 500,000                           | same walk                                                                    |
| Image placements           | 500                               | same walk (a file placed 500 times is 500)                                   |
| Image bytes                | 25 MB total, 10 MB each           | declared sizes and the real `stat`/read sizes                                |
| PNG chunks                 | 10,000                            | inside the structural walk in the worker                                     |
| Link annotations (PDF)     | 20,000                            | while drawing, after coalescing                                              |
| Output bytes               | 100 MB                            | inside the worker while generating, and the main thread's chunk counter      |
| Render time                | 30 s                              | from slot acquisition; worker and zip producer are destroyed at the deadline |
| Worker heap                | 192 MB (+16 MB young, 4 MB stack) | `resourceLimits`; OOM becomes 413                                            |
| Concurrent exports         | 1 DOCX/PDF **or** 2 Markdown      | `429 export_busy`; every kind is also 1 per user                             |
| Admission                  | rss + 400 MB ≤ 85 % of limit      | before the slot; `503 export_busy` with `Retry-After: 30`                    |

The token cap has to bite before the block cap can be dodged: markdown-it is linear, but a body of
one-character list items produces seven tokens per two blocks, so a body that is under the block
cap can still be hundreds of thousands of tokens. Counting `md.parse`'s output first is cheap and
happens before the walker. The line and pipe caps run _before_ the parser and are the cheap path
for a sparse table (tens of thousands of empty cells) or a body of 20,000 `\n`, `\r\n` or `\r`
separated lines; the isolate's 192 MB heap is the backstop for anything the counters cannot
predict.

Markdown is a string; the zip and PDF are streamed. DOCX is the one format whose in-memory size is
the whole archive, produced inside the worker. Before packing, `estimateDocxBytes` refuses the
document when `image bytes + 4 × text bytes + 1 MB` already passes the output budget; after
packing, the real size is counted again as the archive leaves the packer.

### Planned peak and residual risk

One admitted DOCX/PDF export is planned at **400 MiB** of resident memory: the 192 MB worker heap
(plus young generation and the isolate's own structures), one copy of the image bytes on the main
thread while they are read and transferred (≤ 25 MB), the worker's validated image buffers and
pdfkit/docx structures, a 25 MB DOCX archive or streamed PDF, and the 1 MiB chunk in flight.

Admission refuses a new export when `rss + 400 MiB` would exceed 85 % of `/sys/fs/cgroup/memory.max`
(falling back to `os.totalmem()` when the file says `max` or does not exist). That is deliberately
conservative: the limit is per process, so the check is a best-effort guard, not a reservation,
and concurrent non-export requests still allocate.

**Residual risk:** a worker's `resourceLimits` bound the V8 heap exactly, but not native memory.
zlib, pdfkit's image handling, `docx`'s zip writer and the thread's own stack can allocate outside
the counted heap, and a 25 MB image copied through several native buffers does not show up in
`maxOldGenerationSizeMb`. The admission threshold and the process-level RSS check are what cover
that gap; they are heuristics, not a hard per-export cap. The measured peak for the heaviest
allowed DOCX and PDF (25 MB of images, ~10,000 and ~16,000 table cells respectively) is asserted
under 500 MiB by `src/note-export/memory.test.ts`, which samples `process.memoryUsage().rss` every
50 ms. The docx cell count is lower because the library's per-cell object graph is what exhausts
the 192 MB heap first (16,000 cells already OOM, which becomes 413).

## Not letting a renderer crash the process

The worker is the containment boundary, not a set of per-renderer patches:

- a parse, a limit, a pdfkit refusal or a `docx` packer error becomes an `error` message or a
  stream rejection; the main thread turns it into 413/500 before headers, or destroys the
  response after them;
- `ERR_WORKER_OUT_OF_MEMORY`, a non-zero exit and a worker `'error'` event are all observed on the
  same promise the request is waiting for. There is no path where a dead worker leaves a pending
  export promise or an unhandled rejection;
- every stream the main thread creates or sends has an `'error'` listener: the worker render
  stream, the byte-cap transformer, the zip stream and `reply.raw`. An error destroys the response
  instead of becoming an uncaught event;
- the worker's read side is one `Readable` per render, with a no-op `'error'` listener from
  construction, so a failure before the first chunk (which is when the stream is handed to the
  route) cannot be unobserved;
- `ZipWriter.add` observes exactly one `pipeline` promise per entry, and the stream always has an
  error listener. The old separate `done` promise + `drain` handling is gone; destroying the
  output under backpressure rejects once, with no unhandled rejection.

## Cancellation

The route listens on `reply.raw` `'close'` twice: before the worker output exists, the handler
aborts an `AbortController` that the worker supervisor observes (killing the thread even during
parsing or image loading); after headers, the byte-cap transformer's close handler destroys the
source stream, which terminates the worker. The same controller also aborts the image reads
(`fs.promises.readFile` with the signal) and, for a Markdown zip, the archive producer, which
checks it before every 64 KiB file read. The zip producer also observes close/drain through its
entry pipeline, so no producer can hang forever on a buffer nobody reads; a timer at the export
deadline destroys a stalled producer even when it is waiting on a reader. The DOCX/PDF slot is
released only from the worker's `'exit'` handler, and the response's final chunk is held back until
that exit, so a client that reads the whole body immediately after sees the slot free. A Markdown
zip keeps its slot until the stream has ended or been destroyed, not merely until the render
worker exits, because the archive read is the slow part.

## PDF fonts

PDFs embed subsetted copies of four OFL-1.1 Noto families. The binaries are **not** in git; they
are pinned in `apps/server/fonts.lock.json` and fetched from the official `notofonts` release
assets by `apps/server/scripts/fetch-fonts.mjs`:

| Scripts                                                                    | Family                 | Faces                          | Size    |
| -------------------------------------------------------------------------- | ---------------------- | ------------------------------ | ------- |
| Latin, Cyrillic, Greek, common punctuation                                 | Noto Sans 2.015        | Regular/Bold/Italic/BoldItalic | 2.5 MB  |
| Code                                                                       | Noto Sans Mono 2.014   | Regular/Bold                   | 1.2 MB  |
| Han, Hiragana, Katakana, Hangul, CJK punctuation/symbols, full-width forms | Noto Sans CJK SC 2.004 | Regular/Bold                   | 33.4 MB |
| Khmer U+1780–U+17FF and U+19E0–U+19FF                                      | Noto Sans Khmer 2.004  | Regular/Bold                   | 0.2 MB  |

`pnpm --filter @bokydo/server fonts:fetch` downloads into `apps/server/fonts/` (gitignored by one
rule in `.gitignore`; `LICENSES/OFL.txt` stays tracked). Each archive and each extracted file must
match the SHA-256 in the lock before it is moved into place, and `apps/server/fonts.sha256` lists
the same files for `sha256sum -c`. The Docker build runs the fetcher and then `sha256sum -c` in the
build stage, and copies only the verified files into `/app/fonts` in the distroless runtime.

The worker loads fonts from `BOKYDO_FONT_DIR`, defaulting to the `fonts/` directory next to the
app: `apps/server/fonts` in development and tests, `/app/fonts` in the image (the image sets the
variable explicitly). A family whose regular file is missing falls back to the built-in
Helvetica/Courier for the scripts it covers and logs one warning, so a checkout without fetched
fonts still exports; those runs keep the old WinAnsi `?` substitution for unencodable text.

Runs are segmented by script before words are measured, and every atom is measured in the font it
is drawn with, so wrapping and table column widths follow the embedded faces. A combining mark,
ZWJ/ZWNJ, variation selector or emoji modifier stays with the run before it. Word splitting uses
grapheme clusters and glues a Khmer coeng (U+17D2) to the consonant after it, so a cluster reaches
the shaper whole. A character the chosen face does not cover becomes `?` — emoji, and scripts no
bundled family covers — never an invisible `.notdef`; a note cannot silently lose text. `▶` still
becomes `»` when the face has no arrow; censored spans are drawn as bars and task checkboxes as
boxes. Noto Sans CJK and Noto Sans Khmer have no italic file, so italic text that needs them uses
their Regular face. Code uses Noto Sans Mono for the scripts mono covers, and the CJK or Khmer
face for characters it does not.

Khmer needs OpenType shaping. Noto Sans Khmer carries GSUB/GPOS, and pdfkit passes `doc.text`
through `fontkit`'s layout, which detects the script from the string. The font test renders
`សួស្តី` and checks the shaped run: the coeng sign and its consonant become one subscript glyph
(five glyphs for six code points, one glyph mapping back to two code points), the PDF contains
glyph ids rather than `?`, the layout does not throw, and the document's own `ToUnicode` CMap
round-trips the word. Subsetting is pdfkit's default: `/FontFile2` for the TrueType faces,
`/FontFile3` for the CFF CJK face. Each face is loaded on first use, so a Latin-only note never
reads the 16 MB CJK files.

DOCX is unchanged (Word uses system fonts). The pinned, hash-verified font files are the only font
files pdfkit ever parses — never a note, an upload or any other user-supplied font.

## Tests

`apps/server/src/note-export/*.test.ts`:

- **ast** — every construct, censored spans (valid and malformed), HTML as text, the token cap
  checked before the document model, the block count.
- **image-info** — PNG/JPEG header reading, the full PNG chunk walk (CRC, chunk bounds, IHDR
  rules, `IDAT`/`IEND`, trailing bytes, 16-bit/interlaced/`tRNS`/`PLTE`), JPEG markers and `EOI`.
- **images** — which files are loaded, the per-image and total budgets from declared and real
  sizes, a missing file or a directory skipped, and an abort between reads stopping the rest.
- **fonts** — script segmentation for Latin/Cyrillic/Greek, Han/kana/Hangul, Khmer, combining
  marks, joiners and emoji; the family and style mapping; the font directory resolution; and the
  lock file against `fonts.sha256` and the committed OFL text.
- **image-info** — PNG/JPEG header reading, the full PNG chunk walk (CRC, chunk bounds, IHDR
  rules, `IDAT`/`IEND`, trailing bytes, 16-bit/interlaced/`tRNS`/`PLTE`, the 10,000-chunk cap),
  JPEG markers and `EOI`.
- **markdown** — the writer, fence selection, the `html: true` reparse (including a `|` inside a
  table-cell code span), remote images as links, unavailable files.
- **docx** — a real archive whose `word/document.xml`, `numbering.xml` and media entries are
  inspected, ordered-list starts, one media entry for a file placed twice with a distinct
  `wp:docPr` id per placement, inline images, the pre-pack size estimate, the deadline.
- **pdf** — uncompressed content streams: constructs, coalesced link annotations, the annotation
  cap, an alpha PNG rendered as text even when unvalidated, a 256 KiB `tEXt` PNG rebuilt and
  embedded, a motion-photo JPEG embedded only through its EOI, file links as names, table wrapping
  and page breaks with a repeated header, the wide-table `header: value` fallback, the truncated
  tall header, the deadline, the output cap aborting the render, and the built-in-font fallback
  when the font directory is absent. Text is read back by decoding embedded subsets through their
  `ToUnicode` CMaps, so the same assertions hold with and without the fetched fonts.
- **pdf-fonts** — skipped unless `fonts:fetch` has run: Cyrillic/Greek/Han/kana/Hangul/Khmer render
  without `?`, subsetted `/FontFile2`/`/FontFile3` faces with the expected `BaseFont` names, a
  Khmer coeng subscript in the shaped glyph run, long Khmer/CJK wrapping, and emoji staying `?`.
- **worker** — the thread boundary itself: live Markdown/PDF through the ack protocol; a sparse
  table and a 512 KiB list refused quickly; injected OOM → 413 and a second worker succeeding;
  an injected throw; the deadline terminating a slow render; a consumer disconnect terminating the
  worker; the output cap; image validation in the worker (a bad CRC never reaches DOCX, a
  20,000-chunk PNG is refused quickly); no unhandled rejection on any of those paths.
- **memory** — the heaviest allowed DOCX and PDF (25 MB of images; 9,600 cells for DOCX, 16,000
  for PDF) run for real, with RSS sampled every 50 ms and the peak delta asserted under 500 MiB.
- **routes** — the HTTP surface against real Postgres: ownership, archived/trashed notes, scopes,
  project-limited tokens, hostile titles, redacted title/filenames in all three formats (including
  a percent-encoded title and a filename with a real token), the zip layout, missing and unreadable
  files, short limits for `413`/`429`/`503`, the memory-admission `503 export_busy` with
  `Retry-After`, an OOM 413, an internal 500, a fast sparse-table 413, a 512 KiB list, a Markdown
  zip that holds its slot until it is read, a stalled zip aborted at the deadline, a disconnect
  stopping file reads, the Windows device name in `Content-Disposition`, and client disconnects
  before and during streaming.

`apps/server/src/zip/zip-writer.test.ts` covers the entry-name rules (first-dot device names,
NFKC-folded superscripts and full-width letters), 100 entries leaving the shared output's
`listenerCount('close')` unchanged with no `MaxListenersExceededWarning`, a writer whose reader
disappears mid-entry, a disconnect signal stopping a file read after one chunk, a stalled producer
aborted by its deadline, and the `unhandledRejection` spy that proves a destroyed output rejects
once and leaves nothing behind.
