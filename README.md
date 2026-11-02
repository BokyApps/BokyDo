# BokyDo

A free, open-source, self-hostable task manager with the features of Todoist: natural-language quick
add, projects, boards, filters, collaboration, Ramble voice capture, bring-your-own-key AI, a REST API
and an MCP server. An Android app with homescreen widgets follows in Phase 2.

> **Status:** early development. See [docs/PLAN.md](docs/PLAN.md) for the roadmap.
> Quick add syntax: [docs/quick-add.md](docs/quick-add.md) · Filters: [docs/filters.md](docs/filters.md).

## Run it

```bash
docker compose up -d
```

Open <http://localhost:8080> and create your admin account on the signup page. You choose the
username and password; no account or password is generated at startup. Everything else (public
URL, email, registration policy, MFA policy) is configured in the app.

Lost your password? `docker compose exec app bokydo admin reset-password <username>`
Lost your phone and recovery codes? `docker compose exec app bokydo admin reset-mfa <username>`
Set a wrong public URL and can't save anything? `docker compose exec app bokydo admin clear-public-url`

Lost both copies of the database password, or lost the app volume? See
[docs/recovery.md](docs/recovery.md) for the tested recovery procedure.

For anything beyond `localhost`, put BokyDo behind an HTTPS reverse proxy. Passkeys and push
notifications only work over HTTPS.

## Develop

Requirements: Node 22, pnpm 12, Docker.

```bash
pnpm install
pnpm check                     # format, lint, typecheck, unit tests
docker/smoke-test.sh           # full stack + security gate
```

Integration tests need a Postgres database: set `BOKYDO_TEST_DATABASE_URL`.

## Security

Security is a first-class requirement. See [SECURITY.md](SECURITY.md) to report a vulnerability and
[docs/threat-model.md](docs/threat-model.md) for the design.

## License

[AGPL-3.0](LICENSE). The passphrase wordlist is the EFF Large Wordlist (CC BY 3.0 US), see [NOTICE](NOTICE).
