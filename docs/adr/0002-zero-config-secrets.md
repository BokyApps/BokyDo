# ADR 0002: Zero-config secrets and the initial admin

- Status: Accepted (2026-10-04)

## Context

Users must not edit `.env` files, yet the stack needs a DB password, an encryption key and a
session key, and there must be a way in for the first admin without a guessable default.

## Decision

- A one-shot `bootstrap` service (same image, root, no network) generates the DB password and writes
  one copy to each consumer's own volume, owned by that consumer's uid (app 65532, Postgres 999).
  Postgres reads it via `POSTGRES_PASSWORD_FILE`.
- The app generates `master.key` and `session.key` in its own volume on first start.
- Secret files are created with `O_EXCL` and `link()` so they're never overwritten or redirected.
- On first start the app creates `admin` with a 6-word EFF-wordlist passphrase (~77 bits) and prints
  it once to stdout. The password must be changed at first login. `bokydo admin reset-password`
  is the break-glass path (host shell access is already full trust).
- Environment variables remain as optional overrides for development and non-compose deployments only.

## Consequences

`docker compose up` is the whole install. Backups must include the app volume's `secrets/` directory.
