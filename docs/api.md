# REST API and connector recipes

BokyDo exposes two ways for an integration to talk to it:

- **`/mcp`** — a Model Context Protocol server (Streamable HTTP) for AI assistants. See
  [ADR 0009](adr/0009-mcp-server.md).
- **`/api/v1/…`** — a resource-oriented REST API for everything else: scripts, n8n, Home
  Assistant, a custom connector. This document covers the REST API.

Everything is scoped to what the token's owner can see. Both surfaces authenticate the same way.

## Authenticating

Create a token in **Settings → Apps & tokens** (or authorize an app over OAuth 2.1, which is what
assistants use). Send it as a bearer token:

```bash
curl -H "Authorization: Bearer $BOKYDO_TOKEN" https://your-instance/api/v1/tasks
```

Tokens are shown once and stored hashed. A token carries a set of **scopes**, and an operation is
allowed only if the token holds every scope it needs:

| Scope            | Allows                                                        |
| ---------------- | ------------------------------------------------------------- |
| `sync`           | Everything the app itself can do (used by the app)            |
| `tasks:read`     | Read tasks                                                    |
| `tasks:write`    | Add, change, complete and delete tasks                        |
| `projects:read`  | Read projects, sections, labels and filters                   |
| `projects:write` | Add, change and delete projects, sections, labels and filters |
| `comments:read`  | Read comments                                                 |
| `comments:write` | Add, change and delete comments                               |
| `ai:use`         | Use AI features, which may spend money                        |

A token missing a scope gets `403 {"error":"insufficient_scope"}`; a bad or unknown token gets
`401`. Anything you cannot see answers `404`, the same as something that does not exist.

## The contract

The OpenAPI 3.1 document is the source of truth and is generated from the same Zod schemas the
routes use:

- `/api/docs` — a plain HTML index (no JavaScript, so it works under our own CSP)
- `/api/docs/openapi.json` — the machine-readable document

Both are public: a public API that hides its own contract is not much use.

## Operations

| Method | Path                            | Scope           | Notes                                                                                                   |
| ------ | ------------------------------- | --------------- | ------------------------------------------------------------------------------------------------------- |
| GET    | `/api/v1/tasks`                 | `tasks:read`    | Newest first. `projectId`, `completed=true`, `limit` (≤ 100) and the opaque `cursor` from `nextCursor`. |
| GET    | `/api/v1/tasks/{id}`            | `tasks:read`    | One task.                                                                                               |
| POST   | `/api/v1/tasks`                 | `tasks:write`   | Create one. The same fields as the `task_add` sync command, minus the id, which the server assigns.     |
| PATCH  | `/api/v1/tasks/{id}`            | `tasks:write`   | Change only the fields you send.                                                                        |
| POST   | `/api/v1/tasks/{id}/complete`   | `tasks:write`   | Completes it; a recurring task rolls forward to its next occurrence and stays open.                     |
| POST   | `/api/v1/tasks/{id}/uncomplete` | `tasks:write`   | Reopens a completed task.                                                                               |
| DELETE | `/api/v1/tasks/{id}`            | `tasks:write`   | Deletes it and answers `204`.                                                                           |
| GET    | `/api/v1/projects`              | `projects:read` | Every project you can see.                                                                              |
| GET    | `/api/v1/projects/{id}`         | `projects:read` | One project.                                                                                            |

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
`tasks:write` answers `403 insufficient_scope`. Still to come in W10b: project and comment writes,
and the per-token project restriction deferred from W10a.

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

### Hermes Agent (and other OpenAI-compatible agent frameworks)

Agent frameworks that take an OpenAI-style tool list want the OpenAPI document rather than an MCP
URL: fetch `https://your-instance/api/docs/openapi.json`, register it as a tool source, and give it
a bearer token. If the framework prefers MCP, use `https://your-instance/mcp`.

### Plain curl or a script

```bash
# Everything you can see, then only one project's open tasks
curl -s -H "Authorization: Bearer $BOKYDO_TOKEN" 'https://your-instance/api/v1/projects'
curl -s -H "Authorization: Bearer $BOKYDO_TOKEN" \
  "https://your-instance/api/v1/tasks?projectId=$PROJECT_ID&completed=false"
```

### n8n / Home Assistant

Both can call a REST API with an `Authorization: Bearer …` header. Set the base URL to
`https://your-instance/api/v1` and, for n8n, import `/api/docs/openapi.json` as the node's
definition.

## Security notes

- Tokens are never sent to the browser and never appear in logs or error bodies.
- Grant the narrowest scope that does the job; `sync` is the whole account.
- Revoking a token or removing someone from a project takes effect immediately: the next request
  re-checks project access, so history does not leak after access is lost.
