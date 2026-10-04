# Contributing

1. Read [docs/PLAN.md](docs/PLAN.md) and the relevant ADRs in [docs/adr](docs/adr).
2. `pnpm install`, then `pnpm check` must pass. Changes to the server, Docker or compose files must
   also pass `docker/smoke-test.sh`.
3. New routes, commands and MCP tools need authorization tests. A route without an authz matrix entry
   fails CI once the matrix lands in F4.
4. Security-relevant changes update [docs/threat-model.md](docs/threat-model.md).
5. Dependencies: only add one when it clearly pays for itself. pnpm refuses releases younger than
   7 days and install scripts that aren't allow-listed in `pnpm-workspace.yaml`.

By contributing you agree your contributions are licensed under AGPL-3.0.
