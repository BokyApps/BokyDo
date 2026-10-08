# ADR 0021: Task Assist and Filter Assist

- Status: Accepted (2026-10-08), W9 slice 1

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

## Consequences

- No "auto-apply": the decision-model features (§5.4) with confidence thresholds are later W9
  slices, as are reports, Ask your tasks and the eval harness.
- Filter Assist needs a model good enough to write the language from the prompt's summary;
  small local models may need the correction round more often.
