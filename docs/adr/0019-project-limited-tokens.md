# ADR 0019: Personal access tokens limited to some projects

- Status: Accepted (2026-10-08)

## Context

ADR 0008 deferred limiting a personal access token to chosen projects (PLAN §6). Done badly it is
worse than not having it: a token that says "only Work" but can still write to Home gives false
confidence. A bearer token reaches four surfaces: the sync endpoint and its event stream (scope
`sync`), the REST routes (`tasks:*`, `projects:*`), Ramble (`ai:use`, `tasks:write`) and `/mcp`.
Every other `/api` route is session-only. Writes on all of them go through the sync engine, where
authorization comes from project membership, not from the token.

## Decision

- **Storage.** `api_tokens.project_ids` (jsonb, migration 0018): null means every project the
  user can see, as before. Only personal access tokens set it. At creation every id must be a
  project the user can see (400 otherwise), 1 to 100 of them. The settings form offers "All my
  projects" or "Only the projects I choose" (Inbox included); the token list shows the limit.
- **One scope value, threaded through the existing choke points.** The token principal carries
  `projectIds`; `callerScope(req)` hands it to the routes. `visibleProjects`, `projectAccess`
  and `requireProject` take it and treat anything outside it exactly like a project the user
  isn't a member of (`not_found`, no existence leak). `requireProject` takes it as a required
  argument, so every command handler states its scope. REST reads and writes, MCP tools (via
  `projectIndex`, `searchTasks`, `runFilter`), Ramble's context and its batch commit all pass it.
- **Commands: an allowlist, then a backstop.** A limited caller may only run commands confined
  to existing projects (tasks, sections, comments, reactions, reminders, and updating, archiving
  or deleting a project). Creating or moving projects, sharing and transfers, labels, filters,
  preferences, workspaces and notifications are `forbidden`. The table is a
  `Record<CommandType, boolean>`, so a new command type does not compile until someone decides.
  After each handler, if the command logged a change in any project outside the scope, its
  savepoint is rolled back with `not_found`. The change log is how clients learn about writes,
  so this catches what a handler forgot to check, such as deleting an allowed project whose
  sub-project is not allowed.
- **No limited `sync`.** `sync` is the whole account (settings, labels, notifications,
  invitations, the event stream, push registrations), so a token can't have both. Creation
  refuses it, and the access hook refuses a limited token on `sync` routes even if one were
  stored.
- **MCP** hides account-wide tools (`list_filters`) from limited tokens.

## Consequences

- A limited token can't create projects, including sub-projects of allowed ones; sub-projects
  have to be chosen explicitly (no inheritance, so the set never grows by itself). Deleting or
  archiving a project with a sub-project outside the set fails.
- Project names and ids are only checked when the token is made. A project that is later deleted
  or unshared simply disappears from what the token can see.
- Label names on tasks are still the user's own names (labels are referenced by name). Ramble's
  extractor still hears the user's label names so it can match them, but never other projects.
- OAuth grants are not limited by project yet; the consent screen would need a project picker.
