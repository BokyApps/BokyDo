# ADR 0006: AI provider core — outbound requests, credentials, routing and budgets

- Status: Accepted (2026-10-06)

## Context

W7 lets admins and users bring their own AI provider keys (PLAN §5). That means the server
makes HTTP requests to addresses people type in (custom endpoints, a local Ollama), stores
third-party API keys, decides which key and model serve each feature, and has to stop one
user from running up the instance's bill. Webhooks (W10) and the Todoist import (W11) will
also call out to user-chosen URLs. W7a builds that core; provider adapters (chat, streaming,
speech-to-text), the settings UI and subscription sign-in follow in W7b–W7d.

## Decision

- **One SSRF-safe outbound client** (`apps/server/src/net/outbound.ts`) on `node:http(s)`, not
  `fetch`. The socket's `lookup` hook resolves the name, checks _every_ address, and hands the
  connection exactly the checked address, so there is no second lookup to rebind. IP literals
  are checked before connecting (the WHATWG URL parser has already turned `2130706433` or
  `0x7f.1` into dotted quads). Redirects are never followed; responses are size-capped and
  time-limited; compression isn't negotiated; proxy variables are ignored; errors carry a
  reason code only.
- **Address classes, shared with the browser** (`packages/shared/src/ip.ts`): _public_;
  _private_ (RFC 1918, CGNAT, IPv6 ULA), reachable only through an admin allow-list; and
  _blocked_ (loopback, link-local and metadata addresses, unspecified, multicast,
  documentation, reserved, 6to4/Teredo), never reachable. IPv4-mapped and NAT64 addresses are
  judged by the IPv4 address they reach. IPv6 outside 2000::/3 is blocked by default.
- **Two policies.** Users' own credentials get public-internet-only and https-only. Instance
  credentials (admin-managed) may also reach the private networks in Admin → Settings
  `network.privateAllowlist` (CIDRs, or hostnames such as `ollama` whose private addresses are
  then allowed). Loopback stays blocked for everyone: in the Docker deployment it is the app
  itself, never a model server.
- **Credentials** live in `ai_credentials`, scoped to an owner (a user, or none = instance).
  The API key and any custom headers are envelope-encrypted together (ADR 0002's master key)
  with the row id _and_ owner as associated data, so a ciphertext moved to another row or
  owner doesn't decrypt. Keys are write-only: responses show `hasKey` and header names, never
  values. There is no route that lists or touches another user's credentials, admins
  included.
- **Routing.** Each feature needs a capability (§5.1). A user's own route (stored on the user)
  wins when own keys are allowed; otherwise the instance route, if `ai.instanceAccess` lets
  this user use it (`off` / `admins` / `everyone`). Ownership and capability are re-checked at
  every call, so a stale or forged routing entry can't borrow someone else's key. `decision`
  falls back to structured chat for providers without a decision model.
- **Metering and budgets** use one ledger, `ai_usage`. Every call first inserts a `reserved`
  row with its worst-case cost, then settles it to what it actually used (or `failed`). For
  instance credentials the budget check and insert run under a per-user advisory lock, so
  parallel requests are serialised and can't overspend together. Reservations count for 15
  minutes, so a crashed call stops holding budget. Months are UTC. Own keys are metered but
  never budgeted, and admins only see usage on instance keys.
- **No `packages/ai` yet.** The plan named one. The catalog, capabilities and schemas sit in
  `packages/shared/src/ai.ts` (the web UI needs them), and everything that touches keys or the
  network is server-only (`apps/server/src/ai/`). A separate package can be split out if a
  second consumer appears.

## Consequences

- A local Ollama works once the admin allow-lists it, for instance credentials only. Users who
  want a self-hosted model need it on the public internet over https, or an admin route.
- Hostname allow-list entries trust DNS for that name; CIDR entries are stricter. Both can only
  open private ranges, never loopback, link-local or metadata addresses.
- The budget can be exceeded by at most one call's misestimate (a provider reporting more
  tokens than reserved); the next call is then refused.
- "Test connection" lists the provider's models. That doubles as the live model list for the
  routing UI and gives the SSRF client an end-to-end path that the smoke test exercises.
