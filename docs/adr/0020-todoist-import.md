# ADR 0020: Importing from Todoist

- Status: Accepted (2026-10-08), server slice

## Context

W11a (PLAN §8): bring a Todoist account over granularly: preview it, choose what comes, see a dry
run, run it in the background, and be able to run it again without duplicates. The input is
untrusted (another service's answer, shaped by whoever controls that account) and the user hands
us a credential for another service.

Todoist API v1 merged the old REST and Sync APIs under `https://api.todoist.com/api/v1/`. A
full sync (`POST /api/v1/sync` with `sync_token: "*"` and the resource types we need) returns
projects, sections, open tasks (`items`), task and project comments (`notes`, `project_notes`),
labels, filters, collaborators and the user in one JSON answer. Field names were taken from
Doist's own TypeScript SDK (`@doist/todoist-sdk` 11.0.0), which validates the same wire format;
the documentation site was not reachable from the development sandbox. W11b's CSV path stays
for single projects.

## Decision

- **The token is used once.** `POST /api/v1/import/todoist/connect` takes it in the body, makes
  the one Sync request with it as a bearer header through the outbound client's public-only
  policy (fixed URL, https, no redirects, 32 MiB and 120 s caps), and drops it. It is never
  stored, logged or echoed, so there is nothing to revoke on our side. Re-running means pasting
  it again. Session-only routes: a BokyDo API token can't reach any of this.
- **The snapshot lives in memory for 30 minutes**, one per user, at most eight on the instance,
  behind an unguessable session id that only its owner can use (anyone else gets the same answer
  as an expired one). The user can drop it early. It is never written to the database.
- **The answer is validated, bounded and normalised** in one place (`todoist-client.ts`): Zod
  schemas with length and count limits (2,000 projects, 100,000 tasks and comments, and so on),
  deleted and completed items dropped, dates normalised (date only; floating local time; a UTC
  instant with its zone converted to that zone). The rest of the importer never sees Todoist's
  wire format.
- **A pure planner** turns the snapshot plus choices into ordinary sync commands (labels,
  projects parents first, sections, tasks parents first, comments, filters). Every command is
  checked against the command schemas before it is planned, and then applied through
  `SyncService.applyAll`, so permissions, limits and the change log are exactly those of the app.
  Per item: new, merge into a writable BokyDo project (the Todoist Inbox is offered your Inbox),
  or leave out; new top-level projects may go into a team. People: the imported account is you;
  others map to a chosen BokyDo user and keep their tasks only where that user is a member;
  nobody is ever invited. Recurring dates keep Todoist's next date and phrase, with the rule
  re-read by BokyDo's parser (a phrase it can't read becomes a one-off date, with a warning).
  Filters BokyDo's language can't parse are left out; ones naming projects or labels that won't
  exist are imported and flagged. Content is flattened to BokyDo's single-line and length limits
  with warnings.
- **Dry run** (`/plan`) returns the counts and warnings the run would produce and writes nothing.
- **Runs are chunked and idempotent.** `/runs` starts a background run (one per user) and
  answers 202; progress is in the `imports` table. Commands are applied 200 per transaction
  (so the global write lock is never held for long), and `import_mappings` (Todoist id → BokyDo
  id) is written in the same transaction. A command the sync engine refuses is skipped and
  reported; the rest carries on, and anything depending on it is refused in turn. Only mappings
  whose BokyDo item still exists count, so a re-run adds what was skipped or deleted since and
  nothing else. A restart marks a running import failed; running it again resumes.

## Consequences

- Completed tasks, attachments (comments get a link to the Todoist file instead), activity,
  reminders and preferences are not imported yet; neither is a Todoist backup file. The web UI
  is a separate slice.
- An import is as strong as the sync engine's checks, which is the point: a malicious answer can
  at worst create items the user could have typed.
- Merging into a shared project adds the tasks for everyone in it; the dry run says how many.
