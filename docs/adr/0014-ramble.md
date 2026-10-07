# ADR 0014: Ramble — draft extraction, audio chunks and committing a reviewed draft

- Status: Accepted (2026-10-07)

## Context

Ramble (PLAN §5.3, W8) turns a spoken or typed brain-dump into tasks, with live corrections
("actually make that Thursday", "scratch the last one"). It feeds the user's own words, and the
names of projects, sections, labels and people (some chosen by collaborators), to an AI model,
and turns what the model says into tasks. That makes it the first feature where model output
leads to writes, so the W8 gate asks about prompt injection, authorization of extracted tasks,
audio retention, and session length and rate limits. W7b (ADR 0007) provides `ai.transcribe`
and `ai.chatJson`.

## Decision

- **Three endpoints, the draft lives with the client.**
  - `POST /api/v1/ramble/transcribe?seconds=&language=` takes one audio chunk (raw `audio/*`
    body, ≤ 5 MiB, ≤ 60 s) and returns its text.
  - `POST /api/v1/ramble/extract` takes `{ text, draft }` and returns the edited draft, each task
    resolved (`resolved`: project, section, parsed due date, labels, assignee, issues) plus the
    operations that took effect.
  - `POST /api/v1/ramble/commit` takes the reviewed tasks and creates them.

  Being stateless, the same API serves the web (chunked voice or pasted text), the Android app
  (A5) and API clients. Transcribe and extract accept bearer tokens with `ai:use`, commit with
  `tasks:write`.

- **Edit operations, not a fresh list.** The model gets the current draft and the new text and
  answers, through `chatJson`, with flat `add` / `update` / `remove` operations (flat, so every
  provider's JSON mode copes). The server applies them: updates and removals must name an
  existing ref, adds are numbered by the server, fields are trimmed to the draft's limits, and a
  draft holds at most 50 tasks.
- **Names, not ids.** The model only sees, and only writes, names: projects the user can write
  to (owner, admin or editor; not archived), their sections, the user's labels, and the members
  of those projects. Projects the user can only view, and everything else on the server, are
  never mentioned. Names are resolved by the server; nothing is guessed. An unknown project means
  the Inbox, a person who isn't a member of the task's project means unassigned, and a date the
  quick-add parser can't read means no date. Each is reported as an issue for the review panel.
- **Injection framing.** Names (which collaborators choose) go in a `<context>` block as JSON
  with `<` escaped, the draft in `<draft>`, and the transcript in `<transcript>` with `<` replaced.
  The system prompt says these blocks are data and never instructions. The framing isn't relied
  on: the worst a steered model can do is produce a strange draft, which the user sees before
  anything is created.
- **Commit is one batch.** The reviewed tasks are resolved again, and turned into `task_add`
  commands applied with `SyncService.applyAll`: same checks as any client (write access to the
  project, the assignee's membership), one transaction, all or nothing. A project picked in
  review is passed as `projectId` and checked the same way.
- **Audio is never stored.** A chunk is held in memory for the transcription call only. Metering
  never counts less than the chunk's size implies (256 kbit/s for compressed formats, 48 kHz
  16-bit stereo for WAV), so a client can't under-report its length.
- **Limits.** 40 transcriptions, 30 extractions and 30 commits per user per minute, on top of the
  AI budgets. An AI call is cancelled (and metered as failed) when the client goes away before
  the answer. Errors are codes: `ai_not_configured` (409), `ai_budget_exceeded` (429),
  `ai_refused` (422), `ai_provider_error` (502).

## Consequences

- A "session" is the client's: the server bounds each call and the rate, not a session's total
  length. Monthly budgets bound the total.
- The live pipeline (OpenAI Realtime, Gemini Live) is not built. It needs a WebSocket relay that
  holds the provider key server-side, and is split out of W8.
- The web UI (mic capture, waveform, live draft, review panel, push-to-talk, Web Speech fallback)
  builds on these endpoints and is split out too.
- Subtasks aren't extracted yet. Every task is top-level.
