# ADR 0021: Task Assist, Filter Assist, Ask your tasks, reports and triage

- Status: Accepted (2026-10-08), W9 slices 1 to 4

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
  can't see answers 404 before any model call.
- **Scheduled report emails (slice 3b):** `notifications.report` (off by default; a daily plan,
  or a weekly review on a chosen weekday, at a chosen time). The delivery job claims the day
  first (`users.last_report_on`, migration 0020), then writes the report through the same
  function at that moment, so access lost since never shows up, with the user's own routing and
  budget; no model or no budget skips the day. The email says it was written by AI and carries
  its own one-click unsubscribe topic.

## Inbox triage (slice 4, decision models)

- `POST /api/v1/assist/triage` takes up to 20 task ids and suggests, per task, a project, labels,
  a priority, a confidence and a reason: the decision capability of PLAN §5.4 through its LLM
  fallback (on Task Assist's model; no Jev adapter yet). The model chooses among opaque keys
  (`p3`, `l2`, `t1`) that we hand out for writable projects, the user's existing labels and the
  tasks; anything else in its answer is ignored. If any task isn't the caller's, none is sent.
- **Suggestions only, no auto-apply yet.** Moving a task into a shared project shows it to other
  people, so a model talked into it by task text could leak a private task. Auto-apply above a
  per-user threshold needs that case excluded and the decision log the plan asks for; both are
  for a later slice.

## Consequences

- No auto-apply and no decision log yet (see triage); the eval harness is a later W9 slice.
- Filter Assist needs a model good enough to write the language from the prompt's summary;
  small local models may need the correction round more often.
