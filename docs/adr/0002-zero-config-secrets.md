# ADR 0002: Zero-config secrets and the initial admin

- Status: Accepted (2026-10-04); amended 2026-10-05 (no init container)

## Context

Users must not edit `.env` files, yet the stack needs a DB password, an encryption key and a
session key, and there must be a way in for the first admin without a guessable default.

## Decision

- The app generates the DB password, `master.key` and `session.key` in its own volume on first
  start. It publishes a copy of the DB password (and nothing else) into a small `db-secret` volume
  shared with Postgres. Postgres's entrypoint waits for that file, copies it into an in-memory
  tmpfs owned by the postgres user (0400), and reads it via `POSTGRES_PASSWORD_FILE`. Postgres
  never mounts the app volume, so it never sees the app's keys.
- The image creates the `/data` and `/run/bokydo-db` mount points owned by the app user, so fresh
  named volumes inherit that owner and no root step is needed. Compose starts the app before
  Postgres; the app waits (up to two minutes) for the database to accept connections.
- _Amendment (2026-10-05):_ this replaced a one-shot `bootstrap` service (same image, root, no
  network) that wrote one password copy per volume. It worked, but a third container just to
  create a secret made the stack harder to understand. The guarantees are unchanged: no secrets
  in compose or the environment, Postgres can't read the app's keys, existing secrets are never
  replaced, and both copies are checked against each other at every start.
- Secret files are created with `O_EXCL` and `link()` so they're never overwritten or redirected.
- On first start the app creates `admin` with a 6-word EFF-wordlist passphrase (~77 bits) and prints
  it once to stdout. The password must be changed at first login. `bokydo admin reset-password`
  is the break-glass path (host shell access is already full trust).
- Environment variables remain as optional overrides for development and non-compose deployments only.

## Consequences

`docker compose up` is the whole install. Backups must include the app volume's `secrets/` directory.
