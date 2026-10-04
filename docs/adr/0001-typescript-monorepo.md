# ADR 0001: TypeScript monorepo with pnpm workspaces

- Status: Accepted (2026-10-04)

## Context

The quick-add parser and filter language must run identically in the browser (live highlighting,
instant views) and on the server (API, MCP, sync). The Android app comes later and talks to the API.

## Decision

TypeScript for server and web in one pnpm workspace: `apps/server` (Fastify, Drizzle, Postgres),
`apps/web` (React, Vite, Tailwind), shared logic in `packages/*`. Plain pnpm workspace scripts, no
Turborepo, to keep the dependency and supply-chain surface small. TypeScript is pinned to 6.0 until
typescript-eslint supports the TS 7 native compiler.

Workspace packages export their TS source under a `bokydo-source` condition (dev and test) and
compiled `dist/` by default (production).

## Consequences

One language and shared Zod schemas across API, MCP and web. Android (Kotlin) can't reuse the
parser directly; options are evaluated in A2.
