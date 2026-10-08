# ADR 0021: Task Assist, Filter Assist, Ask your tasks and reports

- Status: Accepted (2026-10-08), W9 slices 1 to 3a

## Context

W9 (PLAN §5.3) adds AI features on top of the provider layer (ADR 0006, 0007). The first two are
small and frequent: Task Assist (make a task actionable, break it into steps, suggest a date and
priority) and Filter Assist (a sentence to a filter query). Task text is written by the user and
their collaborators, so it is untrusted input to the model (PLAN §5.5).

## Decision

- **Suggestions only.** `POST /api/v1/assist/task` and `/assist/filter` never write. The client
  shows the suggestion and applies the parts the user accepts through ordinary sync commands. A
  task that talks the model into something can at worst make it propose that, in front of the
  user, through the same permission checks as typing it.
- **Untrusted text is inert data.** Task title, description, project name and existing
  sub-tasks go to the model as JSON with `<` escaped inside a `<task>` block; the system prompt
  says block content is never an instruction. Comments and other tasks are not sent at all
  (least context). Filter Assist sends only the names the user can see (projects, sections,
  labels, people), within a project-limited token's projects.
- **Strict, re-checked output.** Replies must fit a flat JSON schema (with the provider layer's
  one correction round for malformed JSON). Every date the model names is re-read by BokyDo's
  own parser (unreadable ones are dropped, not guessed), text is flattened to one line and
  bounded, and sub-tasks that already exist or repeat are removed. Filter Assist only returns a
  query the real filter parser accepts: a rejected one gets one correction round with the
  parser's message, then `422 ai_unusable`. The accepted query is run once (read-only, the
  user's own visibility) to report how many open tasks it matches and which names don't exist.
- **Same access as the data.** Bearer tokens need `ai:use` plus `tasks:read` (Task Assist) or
  `projects:read` (Filter Assist); a task the caller can't see answers 404 before any model call.
  30 calls a minute per user; budgets and metering as for every AI call.

## Ask your tasks (slice 2)

- `POST /api/v1/assist/ask` takes the conversation (the client keeps it: up to 20 messages,
  30,000 characters, ending with the question) and answers in plain text. Session only: an app
  with a token has its own model and the MCP server.
- **The MCP tool layer is the only data access.** Read tools (search, filters, a task, projects,
  saved filters, the overview) run with the user's own visibility, exactly as over MCP; results
  are cut at 12,000 characters each.
- **Writes are proposals.** The write tools (add, update, complete, comment) are offered to the
  model described as proposals. A call is checked (arguments, the task is visible, the project
  writable) and returned to the client with a summary we write from the checked arguments, not
  the model's words; nothing changes. The user confirms each one, which calls
  `/assist/ask/confirm` and runs the same tool with their own rights. A task that injects
  instructions can therefore only cause a visible proposal.
- **Bounded loop:** at most 6 model rounds and 16 tool calls per question; the last round gets
  no tools and must answer. Each round is metered and budgeted like any AI call.
- **Exfiltration:** the model has no network or messaging tool, its reply goes only to the
  person who asked, and the client shows it as text (no links, images or HTML), on top of the
  CSP that only loads same-origin resources.

## Reports (slice 3a)

- `POST /api/v1/assist/report` with `day` (overdue, today), `week` (also the next 7 days and
  what was done in the last 7, by whom) or `project` (one project, undated tasks too). The data
  is gathered by the server from the projects the caller can see now (and a token's project
  limit), at most 60 items per list, and sent as escaped JSON in a `<data>` block; the model only
  writes prose, returned as plain text with the counts it was written from. A project the caller
  can't see answers 404 before any model call. Scheduled report emails are the next slice: the
  data will be gathered the same way at send time, so revoked access applies automatically.

## Consequences

- No "auto-apply": the decision-model features (§5.4) with confidence thresholds are later W9
  slices, as are scheduled reports and the eval harness.
- Filter Assist needs a model good enough to write the language from the prompt's summary;
  small local models may need the correction round more often.
