# REST API and connector recipes

BokyDo exposes two ways for an integration to talk to it:

- **`/mcp`** — a Model Context Protocol server (Streamable HTTP) for external AI assistants. See
  [ADR 0009](adr/0009-mcp-server.md).
- **`/api/v1/…`** — a resource-oriented REST API for scripts, custom connectors, and other
  integrations. This document covers the REST API.

Everything is scoped to what the signed-in user or token owner can see. MCP authentication depends
on the instance policy; REST API requests use personal access tokens.

## Authenticating

Create a token in **Settings → API & MCP** and select the permissions it needs. Send it to a REST
client as a bearer token:

```bash
curl -H "Authorization: Bearer $BOKYDO_TOKEN" https://your-instance/api/v1/tasks
```

Tokens are shown once and stored hashed. A token carries a set of **scopes**, and an operation is
allowed only if the token holds every scope it needs:

| Scope            | Allows                                                            |
| ---------------- | ----------------------------------------------------------------- |
| `sync`           | Everything the app itself can do (used by the app)                |
| `tasks:read`     | Read tasks                                                        |
| `tasks:write`    | Add, change, complete and delete tasks                            |
| `projects:read`  | Read projects, sections, labels and filters                       |
| `projects:write` | Add, change and delete projects, sections, labels and filters     |
| `comments:read`  | Read comments                                                     |
| `comments:write` | Add, change and delete comments                                   |
| `habits:read`    | Read your personal habits, progress, streaks and check-in history |
| `habits:write`   | Create, update, delete and check in your personal habits          |

`sync` is full account access and covers all current REST and MCP permissions. Other tokens need
each permission an operation requires. AI features are retired, and new tokens cannot request an
AI scope. Instance administrator routes remain session-only; a bearer token never grants admin
access.

A token missing a scope gets `403 {"error":"insufficient_scope"}`; a bad or unknown token gets
`401`. Anything you cannot see answers `404`, the same as something that does not exist.

A personal access token can also be **limited to some projects** ("Only the projects I choose").
Everything outside them answers `404`, as if it did not exist, on REST and MCP alike. A limited
token can't create projects (`403`), change sharing, or touch labels, filters or settings; tick
sub-projects and the Inbox explicitly if it should reach them. Personal habits are account-wide and cannot be accessed with a project-limited token. Full access (`sync`) can't be
limited. See [ADR 0019](adr/0019-project-limited-tokens.md).

### MCP (Streamable HTTP)

Use the public URL ending in `/mcp`; this is the complete MCP endpoint. MCP authentication follows
the instance policy, which allows sign-in, personal access tokens, or both. Clients that support
OAuth can discover the authorization metadata, use browser sign-in with PKCE, and request the
scopes the user approves. Do not ask users for their password. When the policy allows personal
access tokens, configure one as an `Authorization: Bearer …` credential in the client's secure
credential store.

For a direct protocol check with a personal access token, send JSON-RPC requests as HTTP POST with
`Content-Type: application/json`, `Accept: application/json, text/event-stream`, and the same
`Authorization: Bearer …` header used for REST. For example, initialize a client:

```bash
curl -sS https://your-instance/mcp \
  -H "Authorization: Bearer $BOKYDO_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"my-client","version":"1.0"}}}'
```

MCP uses the same token scopes and project limits as REST. A full-access token can use both
protocols; OAuth tokens remain bound to their requested resource, so an OAuth token issued for
`/mcp` cannot be used with `/api/v1` or vice versa. Instance administrators choose the MCP
authentication policy in **Settings → API & MCP**.

## The contract

The OpenAPI 3.1 document is the source of truth and is generated from the same Zod schemas the
routes use:

- `/api/docs` — a plain HTML index (no JavaScript, so it works under our own CSP)
- `/api/docs/openapi.json` — the machine-readable document

Both are public: a public API that hides its own contract is not much use.

## Operations

| Method | Path                            | Scope            | Notes                                                                                                   |
| ------ | ------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/tasks`                 | `tasks:read`     | Newest first. `projectId`, `completed=true`, `limit` (≤ 100) and the opaque `cursor` from `nextCursor`. |
| GET    | `/api/v1/tasks/{id}`            | `tasks:read`     | One task.                                                                                               |
| POST   | `/api/v1/tasks`                 | `tasks:write`    | Create one. The same fields as the `task_add` sync command, minus the id, which the server assigns.     |
| PATCH  | `/api/v1/tasks/{id}`            | `tasks:write`    | Change only the fields you send.                                                                        |
| POST   | `/api/v1/tasks/{id}/complete`   | `tasks:write`    | Completes it; a recurring task rolls forward to its next occurrence and stays open.                     |
| POST   | `/api/v1/tasks/{id}/uncomplete` | `tasks:write`    | Reopens a completed task.                                                                               |
| DELETE | `/api/v1/tasks/{id}`            | `tasks:write`    | Deletes it and answers `204`.                                                                           |
| GET    | `/api/v1/projects`              | `projects:read`  | Every project you can see.                                                                              |
| GET    | `/api/v1/projects/{id}`         | `projects:read`  | One project.                                                                                            |
| POST   | `/api/v1/projects`              | `projects:write` | Create one (`name` required; `color`, `viewStyle`, `parentId`, `folderId`, `visibility` optional).      |
| PATCH  | `/api/v1/projects/{id}`         | `projects:write` | Change name, colour, view, folder or visibility.                                                        |
| DELETE | `/api/v1/projects/{id}`         | `projects:write` | Deletes it and answers `204`.                                                                           |

Reads page with an opaque cursor rather than an offset, so a task that moves while you page cannot
be skipped or repeated:

```bash
# First page
curl -s -H "Authorization: Bearer $BOKYDO_TOKEN" \
  'https://your-instance/api/v1/tasks?projectId=…&limit=50'
# → {"tasks":[…],"nextCursor":"0199…"}
# Next page
curl -s -H "Authorization: Bearer $BOKYDO_TOKEN" \
  'https://your-instance/api/v1/tasks?projectId=…&limit=50&cursor=0199…'
```

A write answers with the task as it now is, so you never have to guess what the server did with it —
including a recurring task, which comes back open at its next date rather than completed:

```bash
# Create it
curl -s -X POST -H "Authorization: Bearer $BOKYDO_TOKEN" -H 'content-type: application/json' \
  -d '{"projectId":"…","content":"Water the plants","due":{"date":"2026-01-01","time":null,"timezone":null,"string":"every day","recurrence":{"rrule":"FREQ=DAILY","anchor":"scheduled"}}}' \
  https://your-instance/api/v1/tasks
# → 201 {"task":{"id":"0199…","isCompleted":false,…}}

# Change one field, then complete it
curl -s -X PATCH -H "Authorization: Bearer $BOKYDO_TOKEN" -H 'content-type: application/json' \
  -d '{"priority":1}' https://your-instance/api/v1/tasks/0199…
curl -s -X POST -H "Authorization: Bearer $BOKYDO_TOKEN" \
  https://your-instance/api/v1/tasks/0199…/complete
```

Writes go through the same command layer the app uses, so every authorization and validation rule
applies unchanged: writing into a project you cannot see answers `404`, and a token without
`projects:write` answers `403 insufficient_scope`. Comment REST resources are still to come; use the MCP `add_comment` tool or the sync endpoint
for comments.

## Personal habits

MCP exposes `list_habits`, `get_habit`, `add_habit`, `update_habit`, `delete_habit` and
`set_habit_check_in`. Habit tools use `habits:read` and `habits:write`; `sync` covers both.
Sign-in clients request the required scopes and the user reviews them on the consent screen.
Habits belong to the authenticated user and remain separate from tasks. Project-limited tokens
cannot access these account-wide tools, even if they carry habit scopes.

The same habit operations are available through REST:

| Method | Path                                   | Scope          | Body                                                                            |
| ------ | -------------------------------------- | -------------- | ------------------------------------------------------------------------------- |
| GET    | `/api/v1/habits`                       | `habits:read`  | —                                                                               |
| POST   | `/api/v1/habits`                       | `habits:write` | `{ "name": "Read", "period": "week", "target": 3 }` (optional stable UUID `id`) |
| PATCH  | `/api/v1/habits/{id}`                  | `habits:write` | Any of `name`, `period`, `target`                                               |
| DELETE | `/api/v1/habits/{id}`                  | `habits:write` | —                                                                               |
| PUT    | `/api/v1/habits/{id}/check-ins/{date}` | `habits:write` | `{ "completed": true }` or `false`                                              |

Daily targets are 1; weekly targets are 1–7. Check-ins use the owner's local date, reject future
or invalid dates, and repeating the same completed state never increments it twice. Summaries
include current progress, streak and 14 days of history. A stable creation UUID makes retries
safe; another user's habit always appears not found.

## Live updates and browser notifications

Task writes from the app, REST and MCP publish live update hints. Open app tabs pull the latest
authorized state after hints and reconnect, on focus/online, and periodically if a stream is
blocked. Personal habit writes also refresh open habit views.

Settings → Notifications offers Google-free desktop notifications **while BokyDo is open**.
The device/account opt-in uses local display and never registers with a push provider. Initial
and offline cached unread notices are not replayed; new notices follow event preferences and
quiet hours, with the existing reminder/security exceptions. Multiple open tabs deduplicate
notices. Optional closed-tab delivery uses standard Web Push through the browser's provider:
Brave selects Google; Firefox uses Mozilla. A website cannot replace Brave's background provider.

## Recipes

The recipes below differ only in how each product wants to be told about a remote server. Where a
product's wording changes between releases, trust its own UI over the exact label here.

You need two URLs, with `https://your-instance` replaced by the public URL from **Admin →
Settings** (a plain-HTTP instance will not work for assistants, and passkeys/push need HTTPS too):

- MCP: `https://your-instance/mcp`
- REST: `https://your-instance/api/v1` (contract at `https://your-instance/api/docs/openapi.json`)

### Claude (Desktop / Code custom connector)

Claude takes a remote MCP server URL. Add a custom connector with
`https://your-instance/mcp`; Claude discovers the OAuth metadata, opens the consent screen, and
you pick the scopes to grant. Nothing else to configure.

### ChatGPT (connector)

ChatGPT connectors also expect a remote MCP server over OAuth. Point it at
`https://your-instance/mcp` and approve the consent screen. If your build of ChatGPT only accepts
an OpenAPI-based Action instead, import `https://your-instance/api/docs/openapi.json` and
authenticate with a bearer token ("API key" in the Action auth settings).

> Both of these are the _assistant_ side. BokyDo's own **Sign in with ChatGPT / SuperGrok**
> subscription sign-in is a separate, experimental feature (W7d) and is not needed for connectors.

### Grok

Grok is pointed at the MCP endpoint the same way as the others:
`https://your-instance/mcp`. Keep the granted scopes to the minimum you need — for a read-only
assistant, grant `tasks:read` and `projects:read` only.

### Plain curl or a script

```bash
# Everything you can see, then only one project's open tasks
curl -s -H "Authorization: Bearer $BOKYDO_TOKEN" 'https://your-instance/api/v1/projects'
curl -s -H "Authorization: Bearer $BOKYDO_TOKEN" \
  "https://your-instance/api/v1/tasks?projectId=$PROJECT_ID&completed=false"
```

### REST integrations

REST integrations can use an `Authorization: Bearer …` header. Set the base URL to
`https://your-instance/api/v1` and use `/api/docs/openapi.json` as the API definition when needed.

## External AI clients

Built-in AI, Assist, reports, and Ramble are retired for now. Their routes return `404`,
no provider calls or AI jobs run, and new tokens cannot request the retired `ai:use` scope.
Existing encrypted provider credentials are preserved but unused.

Use an external MCP client instead. Sign-in or personal access token support depends on the
instance's MCP authentication policy. Personal access token permissions, project limits, expiry,
and revocation apply to both MCP and REST. Settings → API & MCP provides a connection prompt and
the service URLs. Natural-language quick add remains available and uses the local date/priority
parser.

## Security notes

- A personal token is shown in the browser once when you create it; only its hash is stored.
  Provider credentials are never sent to the browser, and secrets never appear in logs or error bodies.
- Grant the narrowest scope that does the job; `sync` is the whole account.
- Revoking a token or removing someone from a project takes effect immediately: the next request
  re-checks project access, so history does not leak after access is lost.
- For server-to-server push instead of polling, see [webhooks.md](webhooks.md): signed event
  deliveries to your own https endpoints, managed under Settings → Webhooks.
