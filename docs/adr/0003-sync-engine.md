# ADR 0003: Sync engine

- Status: Accepted (2026-10-04)

## Context

Web (optimistic UI), Android (offline-first) and API/MCP clients all mutate the same data. Shared
projects mean a user's view changes when someone else edits, moves, deletes or unshares things.
Authorization must hold for every read, including incremental ones.

## Decision

- **Commands, not CRUD.** Clients send batches of `{type, uuid, args}` to `POST /api/v1/sync`.
  Each command runs in its own transaction with a savepoint, is validated by a strict per-type
  schema, and is recorded in `processed_commands`. Replaying a UUID returns the first result
  (offline retries are safe).
- **Client-generated IDs** (UUIDs) for new entities instead of temp-ID mapping. Uniqueness is
  enforced by the primary key; a collision is a `conflict` and never overwrites anything.
- **Change log as markers only.** `changes(seq, entity_type, entity_id, project_id | user_id)`
  holds no data. A sync re-reads each marked entity and re-checks visibility _now_ through the
  policy layer; anything not visible becomes a removal. This one rule covers deletes, moves into
  projects the user can't see, unsharing, and project deletion. A user's scopes are the projects
  they have a membership row for (including deleted ones, so deletions reach them) plus
  user-scoped markers (labels, filters, per-user favorites, access grants/revocations).
- **Global write lock.** Every writer takes `pg_advisory_xact_lock('bokydo:sync-write')`, so
  committed `seq` values always form a prefix and a reader can never skip a change committed
  later with a lower number. Reads run at REPEATABLE READ (one snapshot for head + data).
  Throughput is ample for self-hosted instances; per-user request/command limits stop one user
  from monopolising the lock.
- **Full vs incremental.** `cursor: null`, a future cursor or an unparsable one gets a full
  snapshot (incomplete tasks plus tasks completed in the last 7 days). Otherwise only marked
  entities are returned.
- **Access grants** write a user-scoped `project_access` marker: the next sync pulls the whole
  project, because older markers predate the user's access.
- **Live updates via SSE** (`GET /api/v1/sync/events`): data-free `poke` events telling the client
  to sync. Same-origin cookie auth, sessions re-validated every heartbeat, streams closed on
  logout/password change, at most 10 streams per user.
- **Client** (`@bokydo/sync-client`): `view = confirmed + replay(pending commands)`. Rejected
  commands drop out of the replay (that's the rollback); commands queued during a round trip are
  rebased onto the new server state.

## Consequences

- One authorization path for all reads; the change log can't leak across scopes.
- The cursor is a global sequence number, so it reveals roughly how much activity the instance
  sees. Accepted (low value to an attacker; could be encrypted later).
- Multi-replica deployments will need LISTEN/NOTIFY for pokes and a shared rate limiter.
