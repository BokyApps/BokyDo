# Threat model

Living document, STRIDE per component. Every deliverable updates it. **v0.4 — F1–F4, W1 (2026-10-04).**

## Assets

| Asset                                                                 | Where                                           | Why it matters                                    |
| --------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------- |
| Task, project and comment content                                     | Postgres                                        | Users' private and team data                      |
| Credentials: password hashes, TOTP secrets, passkeys, API tokens      | Postgres                                        | Account takeover                                  |
| Third-party secrets: SMTP password, AI API keys, OAuth refresh tokens | Postgres, envelope-encrypted                    | Abuse of the user's paid accounts                 |
| `master.key` (KEK), `session.key`                                     | `/data/secrets` (app volume)                    | Decrypts all third-party secrets; forges sessions |
| DB password                                                           | `/data/secrets/db_password`, `pg-secret` volume | Direct DB access                                  |
| Initial admin passphrase                                              | stdout once; Argon2id hash in DB                | Full instance takeover before setup               |

## Trust boundaries

1. Internet / LAN → reverse proxy → app (HTTP)
2. App → Postgres (`internal` Docker network, no egress, not published)
3. App → outbound internet (SMTP, AI providers, webhooks) via the `egress` network
4. Host shell → containers (`docker compose exec`); fully trusted by design
5. (later) Browser ↔ third-party content inside tasks (XSS), LLM ↔ untrusted task text (prompt injection)

## Threats and mitigations

| ID  | STRIDE | Threat                                                                                 | Mitigation                                                                                                                                                      | Status                |
| --- | ------ | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| T1  | S/E    | Attacker reaches a fresh instance before the owner and logs in with a default password | No fixed default: random 6-word EFF passphrase (~77 bits) printed once to logs; forced change at first login; setup gate (F3)                                   | ✅ F2 / F3            |
| T2  | I      | Initial passphrase leaks via logs shipped to a log aggregator                          | One-time, must be changed at first login; banner states this; never logged by the JSON logger                                                                   | ✅ accepted           |
| T3  | I/T    | Secrets hard-coded in compose/image or visible via `docker inspect` env                | Bootstrap generates secrets into volumes; Postgres reads `POSTGRES_PASSWORD_FILE`; app env holds no secrets (smoke-tested)                                      | ✅ F2                 |
| T4  | I      | Postgres container reads the app's master key                                          | Separate `pg-secret` volume with only the DB password (smoke-tested)                                                                                            | ✅ F2                 |
| T5  | T      | Symlink planted in secrets dir redirects a secret write                                | `O_EXCL` temp file + `link()` (fails on existing path/symlink), 0700 dirs, 0400 files                                                                           | ✅ F2 (unit tested)   |
| T6  | E      | Container escape / persistence via writable rootfs                                     | Distroless non-root (uid 65532), read-only rootfs, `cap_drop: ALL`, `no-new-privileges`                                                                         | ✅ F2                 |
| T7  | I      | DB reachable from the network                                                          | Not published; `internal: true` network; scram-sha-256 auth                                                                                                     | ✅ F2                 |
| T8  | I      | Static file server leaks source, dotfiles or traverses paths                           | Serves only the built web root; dotfiles denied; traversal probes return 404 (smoke-tested)                                                                     | ✅ F2                 |
| T9  | I      | Error responses leak stack traces or internals                                         | Central error handler returns `internal_error` for 5xx                                                                                                          | ✅ F2                 |
| T10 | S      | Spoofed `X-Forwarded-For` bypasses rate limits or poisons audit IPs                    | `trustProxy: false` by default; Semgrep rule bans `trustProxy: true`; hop count configured in Admin (F3)                                                        | ✅ F2 / F3            |
| T11 | T      | XSS via injected scripts                                                               | Strict CSP (`script-src 'self'`, no inline), build emits no inline scripts; lint + Semgrep ban `dangerouslySetInnerHTML`                                        | ✅ baseline           |
| T12 | T      | Clickjacking                                                                           | `frame-ancestors 'none'` + `X-Frame-Options: DENY`                                                                                                              | ✅ F2                 |
| T13 | D      | Large bodies or slowloris                                                              | 1 MB body limit, 30 s request timeout, 60 s connection timeout                                                                                                  | ✅ F2                 |
| T14 | T      | Prototype pollution via JSON                                                           | Fastify secure-json-parse rejects `__proto__`/`constructor` (tested)                                                                                            | ✅ F2                 |
| T15 | T      | Malicious dependency release (supply chain)                                            | pnpm: 7-day minimum release age, install scripts allow-listed, exotic subdeps blocked, trust-downgrade check; Actions and images pinned by SHA/digest; Renovate | ✅ F1                 |
| T16 | I      | Host-header injection in generated links                                               | Links must use the configured public URL, never `Host` (rule for F3+)                                                                                           | ⏳ F3                 |
| T17 | I      | HSTS mis-pinned on a plain-HTTP or shared domain                                       | HSTS off until an HTTPS public URL is confirmed                                                                                                                 | ⏳ F3                 |
| T18 | R      | Admin actions not attributable                                                         | Append-only `audit_log` from day one (initial admin, CLI resets)                                                                                                | ✅ F2 (expands in W1) |
| T19 | E      | Concurrent first boots create several admins                                           | Postgres advisory lock (tested with 5 concurrent starts)                                                                                                        | ✅ F2                 |

## Open questions

- Login rate limits are in memory (single replica) and reset on restart. Move to Postgres when multi-replica support lands.

- Backups must include `master.key`, or restored encrypted secrets are unrecoverable. The UX for this lands in W11.
- Losing the `pg-secret` volume while keeping `pg-data` recovers automatically. Losing both DB-password copies needs a documented manual procedure (W13).
