# ADR 0025: Notes

- Status: Proposed (2026-11-18)
- Decision: owner requested a Keep-style notes section alongside tasks

## Context

Users want somewhere to keep notes next to their tasks: titled, tagged and searchable, with rich
content (text, images, files, links, embedded YouTube and Google Drive video), the option to
archive or delete, links between notes, links between notes and tasks, and export to Markdown,
DOCX and PDF. The editor is WYSIWYG, with a small toggle that shows the Markdown underneath.
Text can also be censored behind a password, and neither copying it nor opening the Markdown view
may reveal it.

## Decision

### Ownership and lifecycle

A note belongs to one user (`owner_user_id`), like a habit. Notes are not shared through projects.
Each note is in one of three states: `active`, `archived` or `trashed` (`trashed_at`). Trashed
notes are purged after 30 days, or straight away by "delete forever". Deleting a note also deletes
its files and links. All routes run as `access: 'user'`. They take the new scopes `notes:read` and
`notes:write`, and refuse project-limited tokens with `403 project_limited_token`, as habits do.

### Storage format: Markdown

`notes.body` is CommonMark + GFM (tables, task lists, strikethrough), with a 512 KiB limit. The
title is plain text of 0–200 characters. Tags are a normalised `text[]`: trimmed, lower-cased,
1–50 characters each, at most 20, with no `#`, `,` or whitespace. A few constructs carry meaning
inside the Markdown:

| Construct         | Markdown                                               | Notes                                                                        |
| ----------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| Image (note file) | `![alt](/api/v1/note-files/<uuid>)`                    | Rendered with `?inline=1`. Only files of the same note resolve.              |
| File (note file)  | `[name](/api/v1/note-files/<uuid>)`                    | Always downloaded, never rendered.                                           |
| Embed             | a paragraph that is only `::embed[label](<url>)`       | Allow-listed providers only (below); anything else is shown as a plain link. |
| Link to a note    | `[label](bokydo:note/<uuid>)`                          | Kept in `note_links` for backlinks.                                          |
| Link to a task    | `[label](bokydo:task/<uuid>)`                          | Kept in `note_task_links`, alongside links made explicitly from a task.      |
| Censored text     | `{{censored:v1:<salt>:<iv>:<ciphertext>}}` (base64url) | Ciphertext only; see below.                                                  |

The renderer has no raw-HTML path. HTML in the Markdown is shown as text. Ordinary links must be
`http(s)` or `mailto` (the existing `safeHref`). `bokydo:` links resolve inside the app. Every
other scheme is rendered as text.

On every save the server derives `note_links` (note → note) and the body half of
`note_task_links` from the Markdown. A link only counts when its target exists and the user can
see it: their own note, or a task in a project they belong to. Links to anything else stay in the
text but are not stored and do not resolve.

### Links to tasks

`note_task_links(note_id, task_id, source)` has `source` of `body` or `manual`. Linking from a
task's detail panel creates a `manual` row, and unlinking removes it. Body rows are rebuilt on
each save. When a task's notes are listed, the result is always limited to the caller's own notes.
When a note's tasks are listed, the result is always limited to tasks in projects the caller can
access _now_, so leaving a project hides those tasks at once. Deleting a task removes its rows.

### Search

A `search_text` column holds the title, the tags and the body after censor tokens, URLs and
Markdown punctuation have been removed. A generated `tsvector` (`simple` configuration, GIN index)
is built from it. `GET /api/v1/notes?q=` matches `websearch_to_tsquery` OR a case-insensitive
title substring. `tag=` filters with array containment. Censored text is never indexed: the server
never has its plaintext.

### Files

Note files use their own table (`note_files`) and their own directory (`<dataDir>/note-files`),
which `AttachmentStore` takes as a parameter. That way the attachment purge, which deletes every
file it has no row for, can never remove a note file. The rules follow the existing attachments
(T-rows for W5), with owner-only access:

- Raw `application/octet-stream` upload, streamed to disk under a UUID name and capped by
  `attachments.maxSizeMb` (0 disables uploads). There is also a per-user quota of 1 GiB and 2,000
  files. Uploads are rate-limited to 120 an hour per user.
- The type is detected from the file's magic bytes, never from the client's claim. Only PNG,
  JPEG, GIF and WebP are served inline. Everything else, SVG and HTML included, is served as
  `application/octet-stream` with `Content-Disposition: attachment`. Every response carries
  `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`.
- The filename is cleaned for display only (`cleanFilename`) and never touches the filesystem.
- An upload starts as pending. It is claimed when a saved body references it. Files that are still
  pending, or no longer referenced, are deleted after 24 hours.
- A download checks ownership and that the note is not purged. A file of another user's note
  returns 404, not 403.

### Embeds

Only these patterns are embeddable, rewritten to a canonical embed URL on the client and checked
again on the server when the body is saved:

- YouTube: `youtube.com/watch?v=ID`, `youtu.be/ID`, `youtube.com/shorts/ID`, where ID matches
  `[A-Za-z0-9_-]{11}`. They embed as `https://www.youtube-nocookie.com/embed/ID`.
- Google Drive: `drive.google.com/file/d/ID/...`, where ID matches `[A-Za-z0-9_-]{10,100}`. It
  embeds as `https://drive.google.com/file/d/ID/preview`.

Embeds are **click to load**. The note shows a placeholder card, and nothing is fetched from a
third party until the user presses play. That keeps the instance's no-third-party-request default
(T81) for anyone who only reads a note.

The frame is created with `sandbox="allow-scripts allow-same-origin allow-presentation
allow-popups"`, `referrerpolicy="strict-origin-when-cross-origin"` and `credentialless`. CSP
gains `frame-src https://www.youtube-nocookie.com https://drive.google.com`, and nothing else
changes. COEP stays `require-corp`. A `credentialless` iframe is the only way a third-party frame
can load under it. Browsers without that support (and Drive files that need a signed-in Google
account) get an "Open in new tab" link on the card instead.

### Censoring (client-side encryption)

The server never sees censored plaintext or the password.

- The key is derived in the browser with PBKDF2-HMAC-SHA-256 (WebCrypto). It uses 600,000
  iterations and a random 16-byte salt for each censored span.
- Encryption is AES-256-GCM with a random 12-byte IV. The plaintext is the UTF-8 Markdown of the
  span. The additional data is the ASCII string `bokydo-censor-v1`.
- The token is `{{censored:v1:<salt>:<iv>:<ct>}}`, in unpadded base64url, up to 64 KiB of
  ciphertext.
- In the editor a censored span is one atomic inline node, drawn as a solid block of fixed width.
  The cleartext is never part of the document. **Reveal** decrypts it into a transient overlay
  that is not part of the editor state and is excluded from selection and copy
  (`user-select: none`). The overlay closes after 60 seconds, on blur, or on navigation.
  **Remove censor** decrypts and puts the cleartext back into the document.
- Copying, the Markdown view, search, exports, the REST API and MCP all see the token or a
  `█████` placeholder, never cleartext. The clipboard serialiser writes `█████` for the node.
- Passwords exist only in memory. During a session the tab may keep derived keys, keyed by salt,
  so other spans under the same password unlock together. "Lock" and sign-out clear them. A
  forgotten password cannot be recovered, and the UI says so before the user censors anything.
- Unlocking is only ever triggered by an explicit Reveal or Remove action, never on render or
  in bulk. Each attempt is a full PBKDF2, and a planted note can contain thousands of tokens.
  Concurrent requests for one token are merged. Remembered passwords are tried at most three at
  a time, then the user is asked for one.
- Cached keys are keyed by a digest of the whole token, not its salt. An explicit unlock always
  derives from the password the user typed. Lock, sign-out and `pagehide` clear the cache,
  password inputs and any open overlay. A cache generation stops results that were still in
  flight from coming back.
- Remove censor asks for confirmation, because a token can be moved between notes (the AAD is a
  constant). The overlay is tested with copy while it is open, since `user-select` alone
  guarantees nothing about the clipboard.

### Export

`GET /api/v1/notes/:id/export?format=md|docx|pdf` renders on the server, so API clients get the
same output.

- `md` is a single `.md` file. A note with files is exported as a `.zip` that also holds a
  `files/` folder, with links rewritten to it.
- `docx` uses the `docx` library and `pdf` uses `pdfkit`. Both embed PNG and JPEG images under
  10 MB and 40 megapixels (dimensions read from the header before decoding). Other files appear
  as their names. Embeds export as links. Censored spans export as `█████`.

## Consequences

- Censored text is unrecoverable without its password, and it cannot be searched. Both are
  intended.
- In Firefox and Safari, and for private Drive files, embeds fall back to a link while COEP stays
  in force. Dropping COEP would allow signed-in embeds, but it reverses F-008/T81, and this ADR
  does not do that.
- Notes are personal. Collaborators on a task see only their own notes linked to it.
- Notes ship on the web and through REST/MCP first. Android follows as a separate deliverable.
