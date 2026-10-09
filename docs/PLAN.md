# BokyDo — Project Plan

> A free, open-source, self-hostable Todoist-class task manager. Web app first (Phase 1), Android app with homescreen widgets second (Phase 2). Security is a first-class requirement, not a final step.

Status: **Draft v1 — 2026-10-04** · Progress: F1 ✅ F2 ✅ F3 ✅ F4 ✅ W1 ✅ W2 ✅ (2026-10-04) · W3 ✅ W4 ✅ (2026-10-05) · W5 ✅ W6 ✅ W7a ✅ W10a ✅ W10c ✅ W11b ✅ W11d ✅ (2026-10-06) · W11e ✅ W12b ✅ A1 ✅ W7b ✅ M1 ✅ W8 server ✅ A3 ✅ W10b ✅ W7c ✅ (2026-10-07) · R2 ✅ W10d ✅ W11c ✅ A2 slice 1 W7d slice 1 W10a project-limited tokens ✅ W11a server+UI W8 UI ✅ W9 assist (2026-10-08) · **Next: W7d ChatGPT, W8 UI/live, W9, A2.** Handoff notes: [§12](#12-status--handoff-for-the-next-contributor)
Owner: Sarel

---

## 0. TL;DR

- **What:** Todoist feature parity (tasks, projects, sections, sub-tasks, labels, filters, natural-language quick add, recurring dates, board/calendar layouts, collaboration, reminders, Ramble voice capture), plus things Todoist doesn't give you: self-hosting, BYOK AI from any provider, a first-class REST API + MCP server, and an Android app that works against *your* server.
- **Stack (recommended):** TypeScript monorepo. Fastify + PostgreSQL + Drizzle on the server, React + Vite on the web, shared packages for the natural-language parser and filter language so they run identically in the browser and on the server. Phase 2: native Kotlin + Jetpack Compose + Glance widgets.
- **Zero env config:** `docker compose up`, open the URL, log in as `admin` with a one-time password printed to the container log, forced password reset, then *everything* (public URL, SMTP, AI providers, registration policy, MFA policy…) is set in the Admin → Settings UI.
- **Security:** OWASP ASVS Level 2 as the target. Every deliverable has a *security gate* (threat-model update, automated scans, deliverable-specific abuse-case tests, manual pentest checklist) that must pass before it's done.
- **Deliverables:** 4 foundation items (F1–F4), 13 web deliverables (W1–W13), 7 Android deliverables (A1–A7). See §8 and §9.

---

## 1. Goals & non-goals

### Goals
1. **Todoist parity** for everything a Pro/Business user touches daily (full matrix in Appendix A).
2. **Self-hosted, zero pre-config.** No `.env` editing. One compose file.
3. **BYOK AI** — instance-wide keys (admin) and per-user keys, any provider, including subscription OAuth where the vendor permits it.
4. **Open integration surface** — REST API, outgoing webhooks, and an MCP server so Claude / ChatGPT / Grok / Hermes / any agent can work with your tasks.
5. **Android app (Phase 2)** with Todoist-style homescreen widgets and reliable reminders **without depending on Google services**.
6. **Secure by default** — MFA and passkeys, hardened defaults, continuous pentesting.

### Non-goals (Phase 1)
- Pixel-perfect Todoist UI copy or any Todoist branding/assets (trademark). We match *capabilities and ergonomics*, not trade dress.
- iOS, desktop wrappers, Wear OS (Phase 3 candidates).
- Jira/Vikunja-level project management (Gantt, custom fields, sprints). The board is Todoist's board: sections as columns.

---

## 2. Key decisions (with recommendations)

D1, D3, D4, D5 (as passphrase), D7 confirmed 2026-10-04.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| D1 | Language/stack | **TypeScript end-to-end** (server + web) ✅ confirmed | The NL quick-add parser and the filter query language must run *as you type* in the browser **and** authoritatively on the server/API/MCP. One implementation in a shared package removes a whole class of "web says Tuesday, server says Wednesday" bugs. Best-in-class libs for WebAuthn (SimpleWebAuthn), OAuth server (`oidc-provider`, OpenID-certified), MCP (official TS SDK), multi-provider AI (Vercel AI SDK). |
| D2 | Database | **PostgreSQL 17** (bundled in compose) | Multi-user collaboration, row-level locking, robust JSON, full-text search, and `pg-boss` job queue → no Redis needed. Fewer moving parts = smaller attack surface. |
| D3 | Android | **Native Kotlin + Compose + Glance** (not Flutter) ✅ confirmed | Widgets are a headline feature and are native-only on Android anyway (Flutter needs native widget code regardless). Native gives Room/WorkManager/AlarmManager/Credential Manager without bridges. |
| D4 | License | **AGPL-3.0** ✅ confirmed | Keeps it free: anyone offering it as a hosted service must publish changes. Same choice as Vikunja. (MIT if you'd rather maximise adoption.) |
| D5 | Default admin | Username `admin`, **random one-time passphrase (6 words from the EFF large wordlist, ≈77 bits) printed to container logs on first boot**, forced reset + MFA enrolment prompt | A fixed default like `admin/admin` is a guaranteed pentest finding (instances get exposed before setup). A log-printed passphrase keeps the "default admin" UX, is easy to type, and has no known default. ✅ confirmed |
| D6 | Registration | Default **invite-only**; admin can switch to open or closed | Safe default for internet-exposed self-hosts. |
| D7 | Android push | **App syncs and schedules reminders itself as local exact alarms; UnifiedPush** only nudges it to sync sooner / shows live events; optional FCM relay build later ✅ confirmed | A self-hosted server can't send FCM to our app without our Firebase credentials. Reminders must not depend on push at all. |
| D8 | IDs | **UUIDv7** everywhere, never sequential ints | Unguessable (defence-in-depth vs IDOR), sortable, safe for client-generated temp IDs. |
| D9 | Name | **BokyDo** (working title) | — |

---

## 3. Architecture

```
                ┌──────────────┐   ┌──────────────┐   ┌───────────────────┐
                │  Web (React) │   │ Android (P2) │   │ Agents: Claude,   │
                │  PWA         │   │ Kotlin/Glance│   │ ChatGPT, Hermes…  │
                └──────┬───────┘   └──────┬───────┘   └─────────┬─────────┘
          cookie session│     OAuth2 PKCE │      OAuth2.1 / PAT  │ (MCP / REST)
                        ▼                 ▼                      ▼
   ┌────────────────────────────────────────────────────────────────────────┐
   │ BokyDo server (Fastify, Node 22)                                        │
   │  ├─ Auth: sessions, TOTP, WebAuthn, OAuth2.1 AS (oidc-provider), PATs   │
   │  ├─ Policy layer (single choke point for authorization)                 │
   │  ├─ Command/Sync API  ── REST v1 (OpenAPI) ── MCP (Streamable HTTP)     │
   │  ├─ Domain: tasks, projects, sections, labels, filters, comments…      │
   │  ├─ Realtime: WebSocket "poke" + SSE fallback                          │
   │  ├─ Jobs (pg-boss): reminders, emails, digests, AI reports, backups    │
   │  ├─ AI gateway: provider registry, credential vault, router, usage     │
   │  └─ Outbound guard: SSRF-safe HTTP client for every outbound call      │
   └───────────────┬───────────────────────────────┬────────────────────────┘
                   ▼                               ▼
            PostgreSQL 17                 /data volume (secrets, attachments,
                                           backups, VAPID keys)
```

### 3.1 Monorepo layout

```
bokydo/
  apps/
    server/          Fastify API, jobs, MCP, OAuth AS
    web/             React + Vite + TanStack Router/Query, Tailwind + Radix
    android/         (Phase 2) Kotlin/Compose/Glance
  packages/
    shared/          Zod schemas, types, command definitions, error codes
    nlp/             Quick-add parser, date grammar, recurrence engine (pure, no I/O)
    filter-query/    Filter language: lexer, parser, AST → SQL builder & in-memory evaluator
    ai/              Provider adapters, capability model, prompt templates, eval fixtures
    sync-client/     Optimistic command queue + cursor sync used by the web app
  docker/            Dockerfile, compose.yml, smoke test
  docs/              PLAN.md, threat-model.md, security/findings.md, api/, adr/
```

### 3.2 Sync model (designed in Phase 1 so Android "just works" in Phase 2)

- **All writes are commands**: `{ type, uuid, temp_id?, args }`, sent in batches. Server applies each in a transaction, **idempotent by `uuid`**, returns `temp_id_mapping` + per-command status. (Same idea as Todoist's Sync API — proven for offline-first clients.)
- **Change log**: every committed change appends to `changes(seq, entity_type, entity_id, audience_scope, op)`. Clients call `GET /sync?cursor=N` and receive only changes in scopes they can currently see. Losing access to a project emits tombstones.
- **Realtime**: WebSocket pushes "cursor advanced" hints only — never data — so the authorization path is always the sync endpoint.
- **Ordering**: fractional indexing (lexo-rank strings) for drag & drop; conflict-free under concurrent reorders.
- **Conflicts**: last-writer-wins per field, with field-level timestamps; completion and deletion win over edits.

### 3.3 Dates, times & recurrence
- Due = `{ date | datetime, timezone | floating, string, rrule?, recurrence_anchor: scheduled|completion }` — mirrors Todoist's "floating" vs "fixed timezone" semantics.
- Separate `deadline` (date) and `duration` fields.
- Recurrence stored as RRULE + the user's original phrase (shown back to them). `every!` → anchor on completion date.
- Heavy DST/timezone test suite (Europe, US, southern hemisphere, half-hour zones, Asia/Phnom_Penh, Africa/Johannesburg).

### 3.4 Zero-config bootstrap
1. The app generates `/data/secrets/*` on first run: DB password, master encryption key (KEK), session signing key, VAPID keypair. It shares only the DB password with Postgres (through a small `db-secret` volume that Postgres waits for), and Postgres reads it via `POSTGRES_PASSWORD_FILE`. Nothing is hard-coded in the compose file, and the stack is just two containers: app and Postgres (ADR 0002).
2. Server runs migrations automatically, creates `admin` with a random one-time **passphrase** (6 EFF-wordlist words, e.g. `crumpet-velvet-anchor-…`), prints it **once** to stdout with a clear banner.
3. Until the admin completes **setup** (new password → optional MFA → public URL confirmation), every other route returns the setup screen; API/MCP are disabled.
4. Lost admin access recovery: `docker compose exec app bokydo admin reset-password <user>` (host shell access = already trusted).

The only things outside the UI are the host port mapping in compose and (recommended) a TLS reverse proxy. Passkeys and web push **require HTTPS** (except on `localhost`); the setup wizard detects plain HTTP and warns. Optional compose profile bundles Caddy for automatic TLS.

### 3.5 Admin → Settings (everything configurable in-app)
| Section | Settings |
|---|---|
| Instance | Name, public URL (drives WebAuthn RP ID, email links, OAuth redirects), trusted proxy hops, default locale/timezone/week start |
| Users & access | Registration mode (closed / invite-only / open), allowed email domains, user management, impersonation **disabled** by design |
| Security | Password policy, MFA enforcement (off / admins / everyone), passkey-only option, session lifetime & idle timeout, login rate limits, optional HIBP breached-password check (outbound, off by default), CORS allowed origins |
| Email | SMTP host/port/TLS mode (implicit/STARTTLS/none-with-warning)/auth/from, "send test email", per-template enable |
| AI | Providers & instance keys, whether users may use instance keys / bring their own, feature → model routing, per-user monthly budgets, data-sharing notice text |
| Notifications | Web push (VAPID auto-generated), UnifiedPush, digest schedule defaults |
| Storage | Attachment size limit, allowed types, local vs S3-compatible |
| Integrations | API on/off, MCP on/off, webhooks on/off, OAuth client management, outbound network allowlist (for Ollama/custom endpoints on private IPs) |
| Backups | Schedule, retention, encryption passphrase, download/restore |
| Android | Digital Asset Links (assetlinks.json) for passkeys, app-link verification |
| Audit | Security audit log viewer & export |

Secrets entered here (SMTP password, API keys, OAuth refresh tokens) are **envelope-encrypted** (per-secret DEK, AES-256-GCM, wrapped by the KEK in `/data/secrets`) and are write-only in the UI (never echoed back).

---

## 4. Natural-language quick add (the heart of the product)

Deterministic parser in `packages/nlp` — **not** an LLM — so it's instant, offline, private and predictable. LLM is an optional fallback ("Smart add") only.

**Tokens to support (Todoist parity):**
| Syntax | Meaning | Examples |
|---|---|---|
| dates/times | due | `tomorrow 5pm`, `next fri`, `in 3 days`, `jan 27`, `27/1`, `end of month`, `this weekend`, `mid march` |
| recurrence | recurring due | `every day`, `every weekday`, `every other week`, `every 2nd mon`, `every last day`, `every jan 27`, `every 3 months starting aug`, `every mon until dec 1`, `every! 3 days` (from completion), `every hour` |
| `#Project` / `#Project/Sub` | project | multi-word via autocomplete |
| `/Section` | section | |
| `@label` | labels (multiple) | |
| `p1`–`p4` | priority | |
| `+name` | assignee (shared projects) | |
| `{date}` | deadline | `{next friday}` |
| `for 45min` / `for 2h` | duration | |
| `!` reminders | reminder | `!30m before`, `!tomorrow 9am` |
| multi-line paste | bulk create | confirm dialog "Add 12 tasks?" |
| URL | auto-title link | fetched through the SSRF-safe outbound client, opt-in |

**UX:** tokens highlight live in the input; clicking a highlight "un-parses" it (literal text); autocomplete for `#`, `/`, `@`, `+`; "Smart date recognition" toggle per user; locale-aware (English first, i18n framework from day one; additional languages are community contributions with corpus tests).

**Quality bar:** ≥1,500-case golden corpus, property-based fuzzing (fast-check), and a **ReDoS gate** (regex linter + timed fuzz: no input ≤ 2 KB may take > 5 ms).

---

## 4a. Appearance: themes and fonts

Selectable themes based on the ten most popular terminal/editor color schemes, plus BokyDo's own light and dark defaults. A theme is a **per-user setting that syncs**, so the web app, Android app and Android widgets all follow it.

| Theme | Variants |
|---|---|
| Catppuccin | Latte (light), Frappé, Macchiato, Mocha |
| Gruvbox | Light, Dark |
| Dracula | Dracula (dark), Alucard (light) |
| Nord | Dark (Polar Night); light uses Snow Storm |
| Tokyo Night | Night, Storm, Moon, Day (light) |
| Solarized | Light, Dark |
| One Dark / One Light | Dark, Light |
| Rosé Pine | Main, Moon, Dawn (light) |
| Everforest | Light, Dark |
| Kanagawa | Wave, Dragon, Lotus (light) |

**How it works**
- `packages/themes`: every theme is a set of semantic tokens (background, surface, text, muted text, border, accent, focus ring, success/warning/danger, and the four priority colors p1–p4) derived from the theme's published palette. One source of truth, exported as CSS custom properties for the web and as a generated Kotlin color scheme for Android (Compose `ColorScheme` + Glance widget colors).
- **Appearance mode**: *System* (pick the theme's light or dark variant from the OS setting), *Light* or *Dark*. Users choose a theme family plus, optionally, a specific variant per mode (e.g. Catppuccin Latte by day, Mocha by night). Themes with only one variant pair with the closest BokyDo default for the other mode.
- **Project and label colors** (the fixed 20-color palette) are adjusted per theme so they keep readable contrast on that theme's background.
- **Accessibility gate**: an automated test checks every theme variant for WCAG 2.2 AA contrast (4.5:1 body text, 3:1 large text/UI components/focus ring, priority flags distinguishable). A theme that fails is tuned, not shipped as-is.
- **Licensing**: these palettes are MIT-licensed (or similar); attributions go in `NOTICE`. Theme names are used descriptively.
- **Delivery**: theme engine + BokyDo light/dark in **W2**; all ten theme families in **W2** as well (they're cheap once tokens exist); Android picks them up in **A2** (app) and **A4** (widgets).

### Fonts

Font choice sits next to theme choice under **Settings → Appearance**, and syncs per user like the theme.

| Option | Why |
|---|---|
| **System** (default) | The OS UI font: native look, nothing to download |
| Inter | Clean, highly legible UI sans |
| IBM Plex Sans | Neutral, slightly technical |
| Atkinson Hyperlegible | Designed for low-vision readers |
| Lexend | Tuned for reading fluency |
| OpenDyslexic | For readers with dyslexia |
| JetBrains Mono | Monospace, for the terminal-theme crowd |
| Fira Code / Fira Mono | Monospace alternative |

- **Self-hosted** WOFF2 files, subset to the scripts we support, served from the app (CSP `font-src 'self'`). No Google Fonts CDN: no third-party requests, works offline and on air-gapped installs. Only the chosen font is loaded.
- **Text size** (small / default / large / larger) and **density** (comfortable / compact) are separate settings, both rem-based so they scale everything consistently. Browser zoom keeps working.
- Fonts are chosen only from SIL Open Font License (or similar) families; attributions go in `NOTICE`.
- **Android**: the same families bundled in the app (subset), plus "System".
- **Delivery**: with the theme engine in **W2**; Android in **A2**. Widgets use the system font (Glance limitation).



## 4b. Time zones

Most people don't know their IANA time-zone name (`Asia/Phnom_Penh`), so nobody should have to type one.

- **Detected by default**: the browser's (or phone's) zone is suggested up front, e.g. "Use detected: Phnom Penh, Cambodia (UTC+7, 21:40 now)".
- **Smart search combobox** wherever a zone is chosen (user preferences, Admin → default time zone, fixed-zone due dates). Matches on:
  - city and country names, including the major cities that share a zone (Johannesburg, Pretoria, Cape Town → `Africa/Johannesburg`; Bangkok, Hanoi, Phnom Penh → UTC+7 zones)
  - common abbreviations (SAST, ICT, CET/CEST, PST/PDT, AEST)
  - UTC offsets typed any way: `+7`, `utc+7`, `GMT+07:00`
  - the IANA name itself, for people who do know it
- Each result shows the friendly name, the current UTC offset, and the current local time, so picking the right one is obvious. Results that share an offset are grouped.
- Data: the zone list comes from the runtime (`Intl.supportedValuesOf('timeZone')`), so it tracks tzdata updates; a small bundled table adds countries, extra city aliases and abbreviations (from tzdata's `zone1970.tab` plus CLDR names). Values are always stored as canonical IANA names.
- **Travel**: when the device's zone differs from the saved one, offer once: "You're in UTC+2 now. Switch your time zone?" (Todoist does this too).
- **Delivery**: the shared combobox in **W2** (user preferences), retrofitted into Admin → Settings → default time zone in the same deliverable; Android uses the same search data in **A2**.

## 5. AI layer (BYOK)

### 5.1 Capability model
Every provider declares capabilities; features ask for a capability, the router picks the configured model.

| Capability | Used by |
|---|---|
| `chat.structured` (JSON schema / tool calls) | Ramble extraction, Task Assist, Filter Assist, Smart add |
| `chat.long` | Reports, summaries, "Ask your tasks" |
| `stt.batch` (`/audio/transcriptions`-style) | Ramble (chunked mode) |
| `audio.realtime` (OpenAI Realtime / Gemini Live) | Ramble (live mode) |
| `embeddings` | Semantic search, duplicate detection |
| `decision` (typed choice + calibrated confidence) | Triage, urgency, routing (see 5.4) |

### 5.2 Providers
| Provider | Auth | Notes |
|---|---|---|
| OpenAI | API key **or** "Sign in with ChatGPT" (OAuth) | ChatGPT-plan usage for open-source/self-hosted tools uses a dynamic client ID and a loopback redirect; we'll implement the "paste the redirect URL back" pattern for a server-side app. Plan usage has restrictions (`stream: true`, `store: false`, no `temperature`). **Experimental flag**, verify ToS at implementation time. |
| xAI / Grok | API key **or** SuperGrok/X Premium OAuth (device-code flow, RFC 8628) | Device flow fits a server app perfectly (show code, user approves on x.ai). **Experimental flag.** Personal only (ADR 0017). |
| Anthropic | API key | |
| Google Gemini | API key | Also offers live audio for Ramble. |
| OpenRouter | API key | Hundreds of models; also a route to Jev. |
| Command Code | API key (Provider API; GOAT plan+) | OpenAI-style `/provider/v1/chat/completions`; Anthropic models via `/provider/v1/messages`; live model list endpoint. |
| OpenCode (Zen) | API key | OpenAI-compatible gateway. |
| Ollama local | none / optional bearer | Base URL e.g. `http://ollama:11434`. Private-network URL → **admin-only** (SSRF). |
| Ollama Cloud | API key | `https://ollama.com/v1`, OpenAI-compatible. |
| Groq / any Whisper-compatible STT | API key | Fast, cheap STT. Also self-hosted `faster-whisper`/`speaches` servers. |
| TypeSafe Jev | API key (or via OpenRouter / Vercel AI Gateway) | Decision capability. |
| **Custom** | base URL + key + extra headers | Dialect: OpenAI-compatible or Anthropic-compatible. |

**Credential scopes:** instance (admin) and user. Admin policy decides whether users can use instance credentials and with what budget. Usage (tokens/seconds/cost estimate) is metered per user and feature.

**Privacy:** each AI feature shows which provider receives what. Collaborators' content is only sent to an AI provider when the *acting user* triggers a feature on a project they can see. Per-workspace switch: "AI may process this workspace's content".

### 5.3 AI features
1. **Ramble** (W9) — voice brain-dump → structured tasks, with live corrections ("actually make that Thursday", "scratch the last one"). Two pipelines:
   - *Chunked* (works with any provider): browser `MediaRecorder` → 3–5 s chunks → STT → incremental extraction where the LLM emits **edit operations** (`add/update/remove` on a draft list) via tool calls → streamed to the UI.
   - *Live*: OpenAI Realtime or Gemini Live with the same tool schema.
   - Draft always lands in a **review panel**; nothing is created until the user confirms (configurable "auto-add" for trusted setups). The extractor receives the user's project/label/collaborator names so `#`/`@`/`+` resolve, and the deterministic NLP parser normalises the dates it outputs.
   - Fallback when no STT provider: browser Web Speech API (with a notice that Chrome sends audio to Google).
2. **Task Assist** — break a task into sub-tasks, make it actionable, suggest due date/priority.
3. **Filter Assist** — "everything urgent for the Lisbon trip that Ana owns" → filter query (validated by the real filter parser before use).
4. **Reports & summaries** — daily/weekly personal digest, project status report, "what did the team finish this week", overdue triage report. On demand or scheduled, delivered in-app and by email.
5. **Ask your tasks** — chat over your data with **read-only** tools by default; write tools require per-action confirmation.
6. **Smart add fallback** — when the deterministic parser leaves an obviously-structured phrase unparsed.

### 5.4 Decision models (Jev and friends) — where they actually fit
Jev returns a typed choice/score/probability with calibrated confidence in ~70–500 ms instead of generating text. That's ideal for small, frequent, *structured* decisions where we want **auto-apply above a confidence threshold, suggest below it**:

| Use case | Question asked | Action |
|---|---|---|
| Inbox triage | "Which project does this task belong to?" (choices = user's projects) | Auto-move ≥ 0.9, suggest chip otherwise |
| Label suggestion | "Which of these labels apply?" | Suggest chips |
| Urgency/priority | "Score 1–4 urgency given text + due date" | Suggest priority |
| Duplicate detection | "Is task A a duplicate of B?" (candidates from embeddings) | Merge prompt |
| Assignee suggestion | "Who on this project should own this?" (choices = members + history) | Suggest |
| Ramble utterance class | "Is this a new task, an edit, or chatter?" | Speeds up live Ramble, fewer LLM calls |
| Notification gating | "Is this comment worth an immediate push vs digest?" | Smarter notifications |
| Agent safety | "Does this MCP write request match the user's stated intent?" | Extra confirmation gate |

Implemented behind the `decision` capability with an **LLM fallback** (structured output with an enum + self-reported confidence) so the features work for users who don't have Jev. Every decision is logged with its confidence so thresholds can be tuned and users can see "why was this auto-moved?".

### 5.5 AI security
- Task text, comments and descriptions from collaborators are **untrusted input** → prompt-injection risk. Mitigations: least-privilege tool sets per feature, read-only by default, confirmations for writes, no cross-user data in context, strict JSON-schema output validation, outputs rendered as text (never HTML).
- Provider credentials never sent to the browser; all calls proxied server-side.
- Outbound calls only via the SSRF-safe client (§7.3).

---

## 6. API, webhooks & MCP

- **REST v1** — resource-oriented, OpenAPI 3.1 generated from Zod schemas, published at `/api/docs`. Plus the **Sync/command endpoint** (used by web and Android).
- **Auth for integrations:**
  - **Personal Access Tokens** — scoped (`tasks:read`, `tasks:write`, `projects:*`, `comments:*`, `ai:use`, …), optional expiry and project restriction, shown once, stored hashed.
  - **OAuth 2.1 Authorization Server** (`oidc-provider`): PKCE mandatory, Dynamic Client Registration, RFC 8414 + RFC 9728 metadata, resource indicators, refresh-token rotation. This is what ChatGPT connectors and Claude custom connectors expect for remote MCP. Consent screen lists scopes; users can revoke apps.
- **MCP server** at `/mcp` (Streamable HTTP). Tools: `search_tasks`, `get_task`, `add_task` (accepts natural language), `update_task`, `complete_task`, `list_projects`, `list_filters`, `run_filter`, `add_comment`, `get_report`, `ramble_text` (text brain-dump → tasks). Tool annotations (`readOnlyHint`, `destructiveHint`) set correctly; destructive tools need write scopes. Returned user content is clearly delimited as data.
- **Outgoing webhooks** — HMAC-SHA256 signed, timestamped, retried with backoff, SSRF-guarded, admin can disable.
- **Docs/recipes:** Claude (Desktop/Code connectors), ChatGPT connectors, Grok, Hermes Agent, n8n, Home Assistant, plain curl.

---

## 7. Security program ("pentest as you go")

### 7.1 Baseline
- Target **OWASP ASVS 4.0.3 Level 2**; checklist tracked in `docs/security/asvs.md`.
- `docs/threat-model.md` (STRIDE per component), updated by every deliverable.
- `docs/security/findings.md` — every finding with severity, status, fix commit. **High/Critical block the deliverable.**
- `SECURITY.md` with responsible-disclosure process; GitHub private vulnerability reporting enabled.

### 7.2 Automated (CI, every PR)
| Check | Tool |
|---|---|
| SAST | Semgrep (+ custom rules: no raw SQL, no `dangerouslySetInnerHTML`, policy check present on every route), CodeQL |
| Dependencies | `osv-scanner`, `npm audit`, Renovate with grouped updates; lockfile-only installs |
| Secrets | gitleaks |
| Container | Trivy (image + compose config), distroless/non-root runtime image, read-only root FS |
| DAST | OWASP ZAP baseline + authenticated API scan against the compose stack, nightly full scan |
| AuthZ matrix | Auto-generated test: for **every** route/command/MCP tool × every role (owner/admin/editor/commenter/viewer/non-member/other-tenant/anonymous) assert allow/deny. New route without a matrix entry fails CI. |
| Parser safety | ReDoS fuzz for `nlp` and `filter-query` |
| Supply chain | SBOM (CycloneDX), signed images (cosign), provenance |

### 7.3 Hardening defaults
- Passwords: Argon2id; breached-password check optional; no composition rules, min length 12.
- Sessions: server-side, `__Host-` cookies, `HttpOnly; Secure; SameSite=Lax`, rotation on login/privilege change, idle + absolute timeouts, list/revoke sessions.
- CSRF: double-submit token on all cookie-authenticated state changes; API tokens never accepted from cookies.
- Strict CSP with nonces, no inline script, `frame-ancestors 'none'`, HSTS when HTTPS, COOP/CORP, Permissions-Policy (mic for this origin only, for Ramble: `microphone=(self)`, since a per-route policy can't work in a single-page app).
- Markdown in descriptions/comments rendered through a sanitiser (allowlist), links `rel="noopener noreferrer nofollow"`.
- Attachments: size/type limits, magic-byte sniffing, stored outside webroot under random names, served with `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff`; images re-encoded for previews; SVG never rendered inline.
- **SSRF-safe outbound client** (single module, used everywhere: AI endpoints, SMTP host, webhooks, link titles, avatars, iCal): scheme allowlist, resolve-then-pin IP, block private/link-local/metadata ranges unless admin-allowlisted, redirect re-validation, timeouts and size caps.
- Rate limits: login, MFA, password reset, invite, AI endpoints, MCP; account lockout with exponential backoff (no permanent lockout DoS).
- Security audit log: logins, MFA changes, token/app grants, role changes, admin setting changes, exports.
- Account enumeration resistance on login/reset/invite.
- Email: header-injection-safe templates, password-reset tokens single-use, 30-min expiry, hashed at rest.

### 7.4 Per-deliverable security gate
Each deliverable in §8 lists its specific abuse cases. A deliverable is **done** only when: threat model updated → automated checks green → listed abuse cases tested (scripted where possible, Burp/ZAP manual otherwise) → findings logged and High/Critical fixed.

### 7.5 Release pentest
Before v1.0: full manual pentest against ASVS L2 + an external review if resources allow; public bug bounty-lite (hall of fame).

---

## 8. Phase 1 — Web app deliverables

Sizes: **S** ≈ days, **M** ≈ 1–2 weeks, **L** ≈ 3–4 weeks, **XL** ≈ 5+ weeks (single dev + Claude Code; indicative only).

### Foundation

#### F1 — Repo, tooling & CI · S
- Monorepo (pnpm workspaces, no Turborepo; see ADR 0001), TS strict, ESLint/Prettier, Vitest, Playwright.
- CI pipeline with all §7.2 checks wired up (initially on empty app).
- `LICENSE` (AGPL-3.0), `SECURITY.md`, `CONTRIBUTING.md`, ADR template, `docs/threat-model.md` v0.
- **Done when:** CI green on a hello-world server + web; all scanners run and report.

#### F2 — Packaging & zero-config bootstrap · M
- Multi-stage Dockerfile (distroless, non-root, read-only FS), `compose.yml` (app, postgres; originally plus a one-shot bootstrap container, folded into the app on 2026-10-05), optional Caddy profile.
- Secret generation, auto-migrations, health/readiness endpoints, structured logs.
- One-time admin passphrase banner (EFF wordlist, CSPRNG); CLI `bokydo admin reset-password`.
- **Security gate:** no default creds anywhere; DB not exposed outside the compose network; secrets files `0600`; container runs as non-root; Trivy clean (no High/Critical).

#### F3 — Setup wizard & Admin Settings framework · M
- Setup flow (§3.4), settings store (typed, versioned, audited), encrypted secret fields, SMTP test-send, public-URL validation.
- **Security gate:** setup routes unreachable after setup; settings endpoints admin-only (authz matrix); secret fields write-only; changing public URL invalidates WebAuthn/OAuth assumptions safely.
- *Done 2026-10-04. Pulled forward from W1 because setup needs a signed-in admin: password login, server-side sessions, CSRF protection, forced first-login password change, login throttling. W1 keeps TOTP, passkeys, recovery codes, session list UI, email password reset, user management and invites.*

#### F4 — Core data model & sync engine · L
- Schema (users, workspaces, projects, sections, tasks, labels, filters, comments, attachments, reminders, activity, changes, notifications, tokens…), UUIDv7, fractional indexing.
- Command API with idempotency + temp IDs, change log, cursor sync, WebSocket pokes, **central policy layer**.
- `packages/sync-client` with optimistic updates + rollback.
- **Security gate:** authz matrix framework in place; cross-tenant read via sync cursor impossible; tombstones on access loss; command replay is idempotent; mass-assignment tests (unknown/forbidden fields rejected by Zod).
- *Done 2026-10-04 (see ADR 0003). Deviations: client-generated UUIDs instead of temp-ID mapping; SSE instead of WebSocket for pokes. Comments, reminders, attachments, activity log and notifications are added by the deliverables that use them (W5/W6).*

### Web features

#### W1 — Authentication & accounts · L
- Login, logout, forced reset, password change, email verification (if SMTP), password reset (SMTP) or admin-issued reset link (no SMTP).
- **TOTP** MFA + 10 single-use recovery codes; **passkeys** (WebAuthn) as passwordless login *and* as second factor; manage multiple passkeys; MFA enforcement policy.
- Sessions list/revoke, "sign out everywhere", new-login email alerts.
- Admin: create/disable users, reset MFA (audited), invites, registration modes.
- **Security gate:** credential stuffing/rate limit tests, MFA bypass attempts (skip step, replay TOTP, race recovery codes), session fixation, CSRF on every form, account enumeration timing, reset-token reuse/expiry, WebAuthn origin/RP-ID mismatch, user-verification flag enforcement.
- *Done 2026-10-04 (ADR 0004). Added beyond the original scope: sudo mode for sensitive changes, sign-in by verified email, `bokydo admin reset-mfa` break-glass, opt-in HIBP check.*

#### W2 — Tasks & projects core UI · XL
- App shell, sidebar (Inbox, Today, Upcoming, Filters & Labels, Favorites, projects tree with sub-projects, colors, archive), list layout.
- Task CRUD, task detail panel, markdown description, sub-tasks (nested, collapsible, progress), sections, priorities, labels, move/duplicate/copy link, complete/uncomplete (with recurring roll-forward), completed tasks view, archive.
- Today (with overdue + "reschedule all"), Upcoming (day strip, week view, drag to reschedule).
- Drag & drop everywhere, multi-select + bulk edit, undo toasts, global search (Postgres FTS), keyboard shortcuts (Todoist-like: `q`, `/`, `g t`, `e`, `t`…), view options (group/sort/filter per view), **theme engine with the ten terminal-theme families from §4a** (system/light/dark modes, synced per user, WCAG AA contrast test per variant), **font, text size and density choices (§4a)**, user preferences (start page, **time zone with detection + smart search (§4b)**, week start, time format, date format, smart date recognition). Admin → default time zone switches to the same smart picker.
- **Security gate:** XSS in every text field (title, description, comment, project/label names) incl. markdown edge cases; IDOR via move/duplicate across projects; bulk endpoints check every item.
- *Done 2026-10-04. Includes the appearance engine (§4a: 11 theme families / 28 variants, 8 fonts, text size, density) and the smart time-zone picker (§4b). Quick add is plain text until W3 adds natural-language parsing; the board and calendar layouts and running filter queries come with W4. A global “completed” view was deferred at the time; it landed after W6 (sidebar entry, `g c`, backed by the same `/api/v1/tasks/completed` endpoint), so today both the global view and per-project completed lists exist.*

#### W3 — Natural-language engine · L
- `packages/nlp` per §4, recurrence engine (RRULE + Todoist semantics incl. `every!`), deadlines, durations, reminders syntax, quick-add with live highlighting and autocomplete, date picker that also accepts NL.
- **Security gate:** ReDoS fuzz; parser never trusted for authz (`#Project` resolves only to projects the user can write to; `+name` only to members).
- *Done 2026-10-05. Quick add highlights tokens as you type, autocompletes `#` `@` `/`, shows chips that can be removed to keep text literal, and confirms multi-line adds; the date picker takes typed dates and recurrences; recurring tasks roll forward on completion (server and optimistic client). Reminder syntax (`!30m`) is parsed by `packages/nlp` but left as text in the app until W6 adds reminders; `+name` resolves once W5 brings members; editing a title in task details doesn't parse dates (quick add and the date picker do); completed occurrences of recurring tasks will show in the W5 activity log. Syntax reference: [docs/quick-add.md](quick-add.md).*

#### W4 — Filters, labels & layouts (incl. Kanban) · L
- `packages/filter-query`: Todoist filter language (`&`, `|`, `!`, `()`, `,` multi-list; `today`, `overdue`, `no date`, `due before:`, `next 7 days`, `p1`, `#`, `##`, `/`, `@`, `no labels`, `assigned to:`, `assigned by:`, `shared`, `search:`, `created before:`, `recurring`, `subtask`, `!subtask`, `deadline:`, `no deadline`, `workspace:` …) → parameterised SQL **and** in-memory evaluator for instant client views.
- Saved filters with colors/favorites; labels view.
- **Board layout**: sections as columns, drag cards between columns/sections, card shows due/deadline/priority/labels/assignee/sub-task count/comment count, add-card per column, collapse columns.
- **Calendar layout** (month/week) for projects and filters.
- **Security gate:** filter → SQL injection fuzzing; filter results always intersected with visible projects; ReDoS.
- *Done 2026-10-05. `packages/filter-query` (parser + in-memory evaluator) and a server SQL compiler kept identical by a differential test; `GET /api/v1/tasks/filter`; saved filters validated on save; live editor with error positions and match counts; favourite filters with counts. Board (projects: sections as columns; filters/labels: columns from the grouping, drops apply priority/date/project) and month/week calendar for projects, filters and labels. Deferred to W5: `shared`, `workspace:`, assignee names, comment counts on cards. Board sub-tasks show as a count rather than nested cards. Reference: [docs/filters.md](filters.md).*

#### W5 — Collaboration · L
- Workspaces (team) + personal space; folders; roles: owner/admin/member/guest at workspace level; project roles: admin / editor / commenter / viewer.
- Invites by email (SMTP) or single-use expiring link; join requests; leave/remove; transfer ownership.
- Assign tasks (`+name`, picker), "assigned to me/others" views, comments with @mentions, emoji reactions, file attachments, activity log per task/project/workspace, in-app notification inbox.
- **Security gate:** full role matrix; invite-link brute force/guessing, reuse, privilege escalation via invite role tampering, removed member token/sync access, attachment access after removal, mention-spam rate limits.
- *Done 2026-10-06. Project sharing with admin/editor/commenter/viewer roles; invitations by username or verified email (in-app, plus an email when SMTP is set up) and one-time 7-day links; leave, remove, transfer ownership. Assignment via `+name` and a picker, with `assigned to:`/`assigned by:` names and `shared` in filters. Comments with @mentions, emoji reactions and file attachments (type sniffed from the bytes, served sandboxed); activity log per project and task; in-app notification inbox with a live unread count; comment counts on board cards. Workspaces appear as "teams": owner/admin/member/guest, folders, per-project visibility (whole team or only people it's shared with), moving projects between teams, `workspace:` in filters. Team access is stored as ordinary project memberships tagged as workspace-granted, so every existing access check covers it. Deviations: no join requests (invite links cover the need); a workspace-level activity log was added after W6 (the team dialog shows it, scoped to the team's projects the caller can see); notifications are in-app only until W6 adds email and push.*

#### W6 — Reminders & notifications · M
- Reminder types: relative to due time, absolute, auto-reminder default; scheduler via pg-boss (exact-minute precision, catch-up after downtime, timezone-correct).
- Channels: in-app, **Web Push** (PWA, VAPID), **email** (SMTP), per-event per-channel user prefs, quiet hours, daily digest email.
- Events: reminder due, assigned, comment/mention, invite, project changes, security alerts.
- **Security gate:** email template injection/header injection; push subscription hijack (endpoint belongs to user); unsubscribe links signed; no task content in push payload unless encrypted (Web Push payload encryption is standard — verify).
- *Done 2026-10-06 (see ADR 0005). Reminders relative to the due time or at a fixed time, `!30m` / `!fri 8am` in quick add, an automatic-reminder preference (default: at the time of the task), DST-correct and fired again for each occurrence of a recurring task; they sync per user so the Android app can schedule them locally. Delivery by in-app inbox, email and Web Push with per-event, per-channel preferences, quiet hours and a daily digest email; signed unsubscribe links. Events: reminders, assignment, mentions, comments, invitations, sharing changes, completion of a task you assigned, security alerts. Deviations: no pg-boss (a Postgres-backed job runner, ADR 0005); Web Push implemented on `node:crypto` (verified against the RFC 8291 vector) instead of a library; push goes only to the browser vendors' push services (UnifiedPush comes with the Android app); quiet hours drop email/push rather than defer it (the inbox keeps everything); "project changes" means sharing changes (role, removal, ownership), not every edit.*

#### W7 — AI provider layer (BYOK) · L
- `packages/ai`: provider registry per §5.2, capability model, router (feature → provider/model), streaming, retries, budgets & usage metering, "test connection" button, live model list fetch.
- Admin + user credential management UIs; OAuth flows: **ChatGPT sign-in** (experimental) and **SuperGrok device flow** (experimental); token refresh jobs.
  *W7d slice 1 done 2026-10-08 (ADR 0017): SuperGrok / X Premium sign-in by device flow (`xai-subscription`), personal only (xAI's terms forbid sharing an account), tokens in the encrypted credential secret, renewal under the row lock before calls, keep-alive job, revoke on removal, admin switch `ai.subscriptionSignIn` (off by default), Settings → AI sign-in panel. Next: ChatGPT (Codex device flow + Responses-API dialect), to be tested by the owner.*
- **Security gate:** SSRF via custom/Ollama base URL (private IPs, DNS rebinding, redirects, IPv6 tricks, metadata endpoints); keys never in logs/errors/responses; per-user keys inaccessible to admins via UI; budget enforcement can't be bypassed by parallel requests.
- *W7a done 2026-10-06 (see ADR 0006): SSRF-safe outbound client (`apps/server/src/net/outbound.ts`, reusable by webhooks and imports), shared IP classification, provider catalog and capability model, owner-bound encrypted credentials (instance and per user), feature routing with per-call ownership/capability checks, usage ledger with lock-serialised monthly budgets, "test connection" / live model list for the OpenAI, Anthropic and Gemini dialects, and the REST routes (`/api/v1/ai/*`, `/api/v1/admin/ai/*`). Admin settings: `ai.userKeys`, `ai.instanceAccess`, `ai.monthlyTokenBudget`, `ai.monthlyAudioMinutes`, `ai.routing`, `network.privateAllowlist`. Deviation: no `packages/ai` (catalog in `packages/shared/src/ai.ts`, key-handling code server-only). For W7b: adapters implement calls through `AiService.run(user, { feature, estimate, run(ctx) })` and must use `ctx.fetch` only; report usage (or throw `AiCallError` with partial usage).*
- *W7b done 2026-10-07 (see ADR 0007): adapters per dialect (OpenAI-compatible, Anthropic, Gemini) for chat with tools and tool results, structured JSON replies (schema mode, JSON-mode fallback, forced tool call, `responseJsonSchema`), opt-in SSE streaming, speech to text (`/audio/transcriptions`, multipart) and embeddings; retries for 408/429/5xx/529 and dropped connections (3 attempts, `Retry-After` up to 20 s); errors as codes without provider bodies; `POST …/credentials/:id/try` (user and admin) makes a real tiny call for the settings UI. For W8/W9: call `ai.chat(user, feature, req, { onText })`, `ai.chatJson(user, feature, { schema, name, … })`, `ai.transcribe(user, feature, { audio, mimeType, durationSeconds })` or `ai.embed(user, texts)`; they meter, enforce budgets and check the feature's capability. Still validate what a reply refers to (ids, access). Deferred: live audio (WebSockets) to W8.*
- *W7c done 2026-10-07 (PR #2, reviewed by Opus): Settings → AI (your keys: add, edit, remove, Test; which model serves each feature, with a Try button that makes a real tiny call; usage this month) and Admin settings → AI (who may use instance keys, monthly budgets, own keys on/off, instance keys and routing, per-user usage). Fixed in review: Test showed "Reachable" for a refused key (the server answers 200 with `ok: false`); feature names in words; every hidden label unique. Checked in a browser and with the axe audit (73 screens, 0 violations).*

#### W8 — Ramble · L
- Mic capture UI (waveform), chunked and live pipelines, live draft list with edit ops, review panel, commit as one batch command, language selection, push-to-talk + keyboard shortcut, Web Speech fallback.
- Also a **text Ramble** (paste a brain-dump) — same extractor, great for API/MCP too.
- **Security gate:** prompt injection via existing task names/collaborator names fed as context; extraction output validated against schema + authz (can't add to projects user can't write); audio never persisted unless the user opts in; max session length & rate limits.
- *W8 server done 2026-10-07 (see ADR 0014): `POST /api/v1/ramble/transcribe` (one audio chunk ≤ 5 MiB / 60 s → text, never stored, metered at least by size), `/ramble/extract` (`{ text, draft }` → edited draft via add/update/remove operations, each task resolved to project/section/date/labels/assignee with issues), `/ramble/commit` (reviewed draft → tasks in one all-or-nothing batch through the sync engine, `SyncService.applyAll`). The model sees only names of projects the user can write to, framed as data; bearer tokens with `ai:use` (commit: `tasks:write`) work, for Android (A5) and API clients. Split out: **W8 UI** (mic capture, waveform, live draft, review panel, push-to-talk, Web Speech fallback; Sonnet) and **W8 live** (Realtime/Gemini Live through a server-side WebSocket relay; Opus). Not yet: subtasks, the MCP `ramble_text` tool.*
- *W8 UI done 2026-10-08 (drafted by a Haiku subagent, reviewed and browser-checked by Opus): Ramble dialog from the sidebar (shown only when `ramble.extract` is available): typed or pasted text, voice as standalone ~4 s recordings transcribed in order (push-to-talk with Space on the mic button, live level meter or a static bar under reduced motion), Web Speech dictation as the fallback behind a notice that the browser vendor gets the audio, extractions one at a time, review with edit, remove, project choice and plain-language issues, all-or-nothing create. Server change: `Permissions-Policy` now allows the microphone for this origin (`microphone=(self)`, T187); it blocked voice entirely before. Checked in Chromium with a fake microphone (chunks, order, CSRF, stop sends the partial chunk, push-to-talk) and axe (no WCAG A/AA violations in the dialog). Not done: live Ramble (own card), a real screen-reader pass.*

#### W9 — AI features & decision models · L
- Task Assist, Filter Assist, Smart add fallback, Reports & summaries (on-demand + scheduled email), Ask your tasks (read-only tools + confirmed writes), decision-capability features (§5.4) with Jev adapter + LLM fallback, confidence thresholds per user, "why?" explanations.
- Eval harness: fixture sets per feature, run against configured models, pass-rate report (so users can pick a model that actually works locally, e.g. small Ollama models).
- **Security gate:** cross-project data leakage in reports (only visible projects), injection → unintended writes, scheduled reports respect revoked access.

- *W9 slice 1 done 2026-10-08 (ADR 0021, T188–T189): `POST /api/v1/assist/task` (clearer title, next steps as sub-tasks, due date and priority, each date re-read by BokyDo's parser; existing and repeated steps dropped) and `/assist/filter` (a sentence to a query the real filter parser accepts, one correction round, the match count and unknown names as a check). Suggestions only: the client applies what the user accepts through sync commands. Slice 2 the same day: `POST /api/v1/assist/ask` (Ask your tasks: the MCP read tools with the user's visibility; write tools only as proposals the user confirms through `/assist/ask/confirm`; 6 rounds; T190). Slice 3a: `POST /api/v1/assist/report` (day, week or project summaries from visible projects only, T191). Slice 3b: scheduled AI report emails (`notifications.report`, daily or weekly, written at send time, migration 0020, T192). Slice 4: `POST /api/v1/assist/triage` (inbox triage: project, labels, priority with confidence and reason; LLM fallback of the decision capability; suggestions only, T193). Next: auto-apply with a decision log, a Jev adapter, eval harness.*

#### W10 — Public API, OAuth AS & MCP · L
- REST v1 + OpenAPI docs, PATs with scopes, OAuth 2.1 AS (DCR, PKCE, metadata, consent, revocation), MCP server (§6), webhooks, recipes for Claude/ChatGPT/Grok/Hermes.
- **Security gate:** scope enforcement per tool/route (matrix), DCR abuse (redirect URI validation, open redirect, client impersonation), token leakage in logs, consent-screen clickjacking, PKCE downgrade, refresh-token reuse detection, webhook SSRF + signature verification docs, MCP tool output injection framing.
- *W10a done 2026-10-06 (see ADR 0008): OAuth 2.1 authorization server (RFC 8414 and RFC 9728 metadata incl. `/.well-known/oauth-protected-resource/mcp`, dynamic registration, `/oauth/authorize` with PKCE S256 only, consent page at `/oauth/consent`, `/oauth/token` with code and refresh-token grants, rotation with reuse detection, RFC 7009 revocation, RFC 8707 audiences `api`/`mcp`), personal access tokens with scopes and expiry (Settings → Apps & tokens, which also lists and removes authorized apps), bearer authentication in the access hook with per-route `config.scopes` (pinned by the authz matrix), and account resets revoking all API access. Admin settings: `api.enabled`, `api.dynamicClientRegistration`. Deviations: in-house instead of `oidc-provider` (no OpenID Connect needed); public clients only; personal-access-token project restriction deferred to W10b. Only `/api/v1/sync` and `/api/v1/sync/events` accept tokens so far (scope `sync`, for Android). For W10b: give each REST route `config: { access: 'user', scopes: [...] }`, use `requireUser(req)` in its handler, and add it to `TOKEN_SCOPES` in the authz matrix. For W10c: authenticate `/mcp` with `apiTokens.authenticate(token, 'mcp')` and answer 401 with `WWW-Authenticate: Bearer resource_metadata="<base>/.well-known/oauth-protected-resource/mcp"`.*
- *W10d (webhooks) done 2026-10-07 (see ADR 0018): per-user subscriptions in Settings → Webhooks (up to 10, session-only management routes, create/rotate behind recent re-auth); events tail the activity log with a watermark (one frozen, signed payload per event and endpoint); HMAC-SHA256 over timestamp+body with a once-shown, envelope-encrypted secret; retries with backoff via the job runner, then dead-letter; public-only delivery through the outbound client; delivery-time access re-check; admin switch `api.webhooksEnabled`; docs/webhooks.md with verification examples. Events not in the activity log (project renames, comment edits) and member_* events are out of scope for v1.*
- *W10c (MCP) done 2026-10-06 (see ADR 0009): stateless Streamable HTTP endpoint `/mcp` (in-house, JSON responses), tools `search_tasks`, `run_filter`, `get_task`, `list_projects`, `list_filters`, `get_report`, `add_task` (natural language), `update_task`, `complete_task`, `add_comment`, each gated by scopes; writes are sync commands; results framed as data. Admin setting `api.mcpEnabled`. Deferred: `ramble_text` (needs W8); webhooks split out as W10d. Connector recipes (Claude, ChatGPT, …) still to write with W10b's docs.*
- *W10b done 2026-10-07 (PR #1, reviewed by Opus): REST v1 for tasks (list with keyset cursor, get, create, update, complete, uncomplete, delete) and projects (list, get, create, update, delete), each with bearer scopes (`tasks:*`, `projects:*`) and writes through the sync engine with bodies derived from the sync command schemas; OpenAPI 3.1 at `/api/docs/openapi.json` (generated from the same Zod schemas, a test checks real responses against it) and a plain index at `/api/docs`; connector recipes for Claude, ChatGPT, Grok and Hermes in `docs/api.md`; threat T125. Split out: per-token project restriction (own card), comment resources.*
- *W10a follow-up done 2026-10-08 (ADR 0019, migration 0018, T181–T182): personal access tokens can be limited to chosen projects (Settings → Apps & tokens). The limit is applied in `visibleProjects`/`projectAccess`/`requireProject`, so REST, MCP, Ramble and the sync command path treat other projects as not found; limited tokens run only project-confined commands (no new projects, sharing, labels, filters, settings) and a backstop rolls back any command that logged a change outside the limit. `sync` can't be limited. Not done: limiting OAuth grants (needs a project picker on the consent screen).*

#### W11 — Parity extras · L
- **Import from Todoist** (user's API token via Todoist Sync API, or backup/CSV) — projects, sections, tasks, labels, filters, comments, recurring rules. Huge for adoption.
- **Granular import:** after connecting, preview what's in the Todoist account and choose what comes over instead of all-or-nothing:
  - pick individual projects (with or without sub-projects), and whether to include completed tasks (and how far back), comments, attachments and activity;
  - pick which labels and saved filters to bring; filters that reference unselected projects/labels are flagged rather than silently broken;
  - per item: import as new, merge into an existing BokyDo project/label of the same name, or skip; choose the destination (personal or a team) for each project;
  - people: map Todoist collaborators to BokyDo users (or leave tasks unassigned); never invite anyone automatically;
  - preferences (time zone, week start, date format, theme-ish settings) as an opt-in;
  - dry-run summary (counts, conflicts, unsupported features such as Todoist-only filter syntax) before anything is written; the import runs as a background job with progress and can be re-run to pick up items skipped the first time (Todoist IDs remembered, so nothing is duplicated).
  *W11a server slice done 2026-10-08 (ADR 0020, migration 0019, T183–T186): `POST /api/v1/import/todoist/connect` (API token used once, never stored), preview with merge suggestions and already-imported markers, `/plan` dry run, `/runs` background run applying sync commands 200 per transaction with Todoist ids remembered in `import_mappings`, so re-runs add only what is missing. Field names checked against Doist's `@doist/todoist-sdk` 11.0.0 (the docs site was unreachable); not yet run against a real account. UI added the same day (Settings → Your data → Import from Todoist: connect, per-project new/add to/skip with a team for new top-level ones, labels, filters, comments, people, dry run required before Import, progress; drafted by a Haiku subagent, reviewed and browser-checked by Opus). Not done: completed tasks, attachments, reminders, preferences, Todoist backup files.*
- Templates: export/import project as CSV (Todoist-compatible format), template gallery.
- Productivity: karma-style points, daily/weekly goals, streaks, vacation mode, productivity view.
  *W11c done 2026-10-08 (reviewed by Opus): `GET /api/v1/productivity` (session-only), karma derived from completions by priority, levels, daily/weekly goals, streaks in the user's zone, vacation as a date range, `/productivity` view. Review fixes: a vacation spanning centuries hung the server (F-038, now bounded and validated), raw SQL replaced by bound parameters.*
- iCal feed per project/filter (secret-tokenised URL, revocable); Google/CalDAV calendar sync as stretch.
- Export everything (JSON/CSV), scheduled encrypted backups + restore (admin), account deletion (GDPR).
  - *W11e done 2026-10-07 (see ADR 0013): Settings → Your data (export ZIP with JSON + formula-guarded CSV + files; account deletion with blockers listed), admin delete in Users, Admin → Backups (schedule, retention, write-only passphrase, back up now, upload, download, delete, restore). Backups: argon2id + AES-256-GCM STREAM chunks; DB snapshot via COPY, instance keys and attachments; sign-in state excluded. Restore: authenticated pass first, automatic pre-restore backup, one transaction that rebuilds the schema at the backup's version, loads data with deferred FKs and applies newer migrations (older backups are upgraded), then keys/files swapped and the process restarts. Migration 0015: `tasks.created_by_id` set null on user deletion (was cascade). Verified by a real Docker restore drill in the smoke test. Not done: audit/activity log retention; restore from the setup wizard UI (the API works before setup).*
- Email-to-project address (stretch, needs inbound mail).
- **Security gate:** import file parsing (zip bombs, CSV injection on export → prefix `=+-@`), Todoist token handling (used for the import session only, never logged, encrypted if kept for re-runs, revocable), imported content treated as untrusted (same validation and limits as sync commands, attachments re-sniffed), import can't write into projects the user can't edit, iCal token entropy/revocation, backup encryption & restore integrity, account deletion completeness.

#### W12 — PWA, accessibility & i18n · M
- Installable PWA, offline read cache + queued writes (reuses sync-client), responsive/mobile web layout.
- WCAG 2.2 AA pass (keyboard-only, screen readers on list/board/drag-drop).
- i18n plumbing + English; translation workflow (Weblate) for community.

#### W13 — Hardening & v1.0 release · M
- Full ASVS L2 review, release pentest (§7.5), load test (10k tasks/user, 50 concurrent users on a 2-vCPU box), backup/restore drill, upgrade-path test from every pre-release, docs site, demo instance with nightly reset.
- **Done when:** zero open High/Critical, docs complete, signed images published.

### Suggested order
```
F1 → F2 → F3 → F4 → W1 → W2 → W3 → W4 → W5 → W6 → W7 → W8 → W9 → W10 → W11 → W12 → W13
                         (W3 parser work can run in parallel with W2;  W7 can start after F4)
```
Milestones: **M1 "usable alone"** (F1–W4: personal Todoist replacement) → **M2 "usable together"** (W5–W6) → **M3 "smart"** (W7–W9) → **M4 "open"** (W10–W11) → **v1.0** (W12–W13).

---

## 9. Phase 2 — Android app deliverables

Native Kotlin, Jetpack Compose, Material 3, Room, WorkManager, Glance. Min SDK 26.

#### A1 — Foundation & auth · M
- Server URL entry + discovery (`/.well-known/bokydo`), OAuth 2.1 PKCE via Custom Tabs (so MFA + passkeys work exactly as on web), tokens in Android Keystore-backed encrypted storage, optional biometric app lock.
- Room schema mirroring the sync model; command queue with temp IDs; WorkManager sync + foreground WebSocket.
- Server side: serve `assetlinks.json` (from Admin → Android settings) for passkeys/app links.
- *Done 2026-10-07 (see ADR 0010): `apps/android` with a pure-JVM `:core` (address rules, discovery checks, PKCE and redirect checks, HTTP client with serialised refresh, sync engine and merge rules; 19 JVM tests) and `:app` (Keystore vault, SQLite store, Custom Tabs sign-in with the first-party client `bkdc_bokydo-android-app-001`, WorkManager sync every 15 min, SSE live sync in the foreground, minimal connect/status screens). Server: `/.well-known/bokydo` discovery, the first-party client seeded on start, `/.well-known/assetlinks.json` from `android.certFingerprints`, consent marks first-party apps as verified. Verified end to end on an API 36 emulator (sign-in, sync, live updates, restart, sign-out revoking the grant, forged and replayed redirects). Deviations: plain SQLite instead of Room (no KSP with AGP 9's built-in Kotlin); SSE, not WebSocket; biometric app lock moved to A2. Build: AGP 9.4.1, Kotlin 2.2.10, Gradle 9.6.0 (wrapper pinned by checksum), JDK 17+; SDK at `~/Android/Sdk` (`local.properties`, gitignored). For A2: build screens on `SqliteStore` + `SyncEngine.enqueue` (commands are the web app's, IDs from `Ids.newId()`), add optimistic local updates.*

#### A2 — Core screens · L
- Inbox, Today, Upcoming, projects (list + board), filters, labels, task detail, comments, search, settings — all offline-capable.
- Quick add with live NLP highlighting. Option: run `packages/nlp` in an embedded JS engine (QuickJS) to keep **one** parser; fall back to server `/parse`. (Decide in A2 spike.)
  *Decided 2026-10-07 (ADR 0016): `packages/nlp` runs in AndroidX `JavaScriptSandbox` (WebView's V8, no native code), bundle generated into `app/src/main/assets/nlp.js` with a CI freshness check; ≈3.4 ms per parse after a ≈0.6 s cold start, output identical to Node's. Plain-text quick add where the sandbox isn't supported; no server `/parse`.*
- Themes and fonts from §4a via a generated Compose `ColorScheme` and bundled font families; follows the user's synced appearance and the system light/dark mode; optional Material You dynamic color as an extra choice.
- Time-zone picker with the same detection and smart search as the web (§4b), plus the travel prompt.
- *Slice 1 done 2026-10-08: app shell (Inbox, Today, Upcoming, Browse, project lists by section) on `:core` `AppState`/`Views` with queued changes shown at once (`Optimistic`, the web reducers' rules for task commands); complete/reopen; quick add parsed by `packages/nlp` in `JavaScriptSandbox` with highlighting, chips that keep a token as text and the web's commands (`:core` `QuickAdd`), `assets/nlp.js` generated by `pnpm --filter @bokydo/nlp build:android` and checked in CI. Verified on an API 36 emulator (offline add/complete, recurring, live updates, hostile text). Next slices: task detail, comments, labels, filters, search, board; then themes/fonts, time-zone picker and biometric lock.*

#### A3 — Notifications · M
- **Reminders scheduled locally** with exact alarms (`SCHEDULE_EXACT_ALARM`/`USE_EXACT_ALARM` justification), re-armed on boot/timezone change/sync — works offline and without any push service.
- Live events (assignments, mentions): **UnifiedPush** (ntfy etc.) + WebSocket while open; FCM via optional relay as a later "Play" flavour.
- Notification actions: complete, snooze, reschedule, reply to comment.
- *Done 2026-10-07 (see ADR 0015): reminders computed on the device with the server's rules (`:core` `Reminders`, DST tested against the server) and set as one exact alarm for the next one, re-armed after sync, boot, clock/zone changes and updates; actions Complete (queued `task_complete`) and Snooze 15 min / 1 h. UnifiedPush spoken directly (AND_3, no library): distributor choice on the home screen, RFC 8291 decryption on the device (`:core` `WebPush`, tested against the RFC example), token-checked receiver. Server: push routes accept the app's `sync` token, registrations bound to the OAuth grant (migration 0016) and removed with it; the synced user carries `timeZone`. Verified on an API 36 emulator: offline reminder on time, Complete while offline then synced, registration through a test distributor, a server-encrypted message shown, spoofed and tampered messages dropped, snooze, reboot re-arm, sign-out cleanup. Deferred to A2: reschedule and reply-to-comment actions (need task screens); WebSocket while open is the existing SSE live sync.*

#### A4 — Homescreen widgets & system integration · L
- **Task list widget** (resizable; configurable to Inbox/Today/Upcoming/any project/filter; tap-to-complete checkboxes; scroll; add button; transparency; uses the user's theme from §4a or a per-widget theme override).
- **Quick add widget** (1×1 / 4×1), **Ramble widget** (one-tap voice), **Today counter** (1×1).
- Quick Settings tile, launcher app shortcuts, share target ("share to BokyDo" → new task with link), Assistant/App Actions where feasible.

#### A5 — Ramble on Android · M
- Stream audio to server Ramble endpoint; optional on-device `SpeechRecognizer` for STT with server-side extraction; review sheet.

#### A6 — Security hardening · M
- MobSF static/dynamic scan, OWASP MASVS L1 (+ selected L2 controls), no secrets in backups (`allowBackup` rules), screenshot protection option, network security config (user-added CAs **opt-in** per server for homelab TLS), exported components audit, intent spoofing tests on widgets/share target.

#### A7 — Release · S
- Reproducible builds, F-Droid metadata, GitHub releases (signed APK), Play Store listing later.

---

## 10. Phase 3 candidates
iOS app (+ widgets), Wear OS (Ramble on wrist), desktop (Tauri) with global quick-add hotkey, location-based reminders, two-way Google/CalDAV calendar sync, email-to-project, browser extension, more NLP languages, SSO/OIDC login (Authentik/Keycloak/Google) — *SSO could move into Phase 1 if you want it, it's ~M size on top of W1.*

---

## 11. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Subscription OAuth (ChatGPT/SuperGrok) terms or flows change | Feature breaks or violates ToS | Ship behind "experimental" flag, isolate in adapters, always offer API-key path |
| NLP parser long tail | Users feel "it's not Todoist" | Big corpus early (W3), telemetry-free "report misparse" button that files a local issue with the phrase |
| Scope (Todoist is huge) | Never ships | Milestones M1–M4 are each independently useful; parity matrix tracks honestly |
| Prompt injection via shared content | Unintended actions | Read-only by default, confirmations, least-privilege tools (§5.5) |
| Android background limits (OEM battery killers) | Missed reminders | Exact alarms + "dontkillmyapp" guidance screen + reliability self-test |
| Self-hosters on plain HTTP | Passkeys/push silently fail | Setup wizard detection + Caddy profile |

---

## 12. Status & handoff (for the next contributor)

*Updated 2026-10-07, after A1.* Everything needed to pick up where work stopped.

**Done:** F1–F4, W1–W6, W7a, W10a, W10c, W11b, W11d, W11e, W12b, A1 (each has a *Done* note in §8 with deviations). Repo: `BokyApps/BokyDo`, branch `main`, all pushed. Every deliverable's security gate is logged in `docs/security/findings.md` (gate log) and `docs/threat-model.md` (T1–T88, T95–T124, T140–T146 (W10b holds T125+)); design decisions are in `docs/adr/0001`–`0006` and `0008`–`0013`.

**Next, in order:** W7b–W7d (adapters, settings UI, subscription sign-in) → W8 → W9 → W10 → W11 (now incl. granular Todoist import) → W12 → W13, then Android A1–A7 (§9).

**Open items:**
- Push delivery was verified by tests (RFC 8291 vector, real decryption) but not in a real browser (the dev browser blocks notification permission). Check on a real HTTPS install.
- Push goes to the browser vendors' push services and to the hosts in the admin setting `push.allowedHosts` (M1, ADR 0005 update), through the SSRF-safe outbound client. For A3: UnifiedPush endpoints get the same Web Push (RFC 8291/8292) messages as browsers; `/api/v1/push/subscriptions` is still session-only and ties a subscription to a session, so the Android app needs a token-friendly variant tied to its OAuth grant (likely a migration).
- Multi-replica would need LISTEN/NOTIFY pokes and shared rate limiters (ADR 0003); jobs already use `SKIP LOCKED`.

**Open work, classified** (*added 2026-10-06*). Model tiers:
- **Opus 5.5** — security-critical or cross-cutting design: auth/OAuth, crypto, secrets, SSRF-safe outbound calls, prompt-injection boundaries, data migration/restore, release hardening. Also does the security gate for any deliverable.
- **Sonnet** — well-specified work inside existing patterns: endpoints with tests, UI pages, adapters, smoke checks, and reviewing DeepSeek output.
- **DeepSeek 4.1 Flash** — small, mechanical, low-risk work with clear acceptance tests and no security decisions: dependency bumps, doc edits, string extraction, CSV formats, UI polish, test fixtures. Its output is always reviewed (diff read + `pnpm check` + smoke test) by Sonnet or Opus before it's committed.

| ID | Task | Model | Blockers | Can run alongside |
|---|---|---|---|---|
| R1 ✅ | Finish the review of the DeepSeek change (global Completed view + COEP `require-corp`, F-008): one thumbnail check with COEP on, then commit and push | Sonnet | **Done 2026-10-06**: thumbnails render with COEP on (`crossOriginIsolated`, no console errors); committed | Everything |
| R2 ✅ | F-029: pnpm override `source-map-js: ^1.2.2`, re-run osv-scanner, mark fixed | DeepSeek | **Done 2026-10-08**: override, osv-scanner clean, ignore removed | Everything |
| R3 ✅ | Completed-tasks paging skips tasks that share a completion timestamp (parent + sub-tasks, ms-truncated cursor): use a `(completed_at, id)` cursor, scoped to visible projects, plus a test | Sonnet | **Done 2026-10-06** (F-034): opaque `<completed_at>_<id>` cursor, strict validation, regression + mutation-checked tests | Everything |
| R4 | Verify Web Push in a real browser on an HTTPS install (enable, test push, click-through, sign-out removes it) | Sonnet (guided) | Needs an HTTPS deployment and a person with a real browser | Everything |
| W7a ✅ | `packages/ai` core: SSRF-safe outbound HTTP client (private IPs, DNS rebinding, redirects, IPv6, metadata), credential storage (envelope-encrypted, per-user keys hidden from admins), router, budgets/metering | Opus | **Done 2026-10-06** (ADR 0006; catalog lives in `packages/shared/src/ai.ts`, not a new package) | W10a, W11b–W11e, W12a |
| W7b ✅ | Provider adapters on top of W7a (OpenAI-compatible, Anthropic, Gemini, Ollama, …), streaming, retries, live model list, "test connection" | Sonnet | **Done 2026-10-07** (ADR 0007) | W10, W11 |
| W7c ✅ | Admin + user AI settings UI | DeepSeek (Sonnet review) | **Done 2026-10-07** (PR #2) | Anything server-side |
| W7d | Subscription sign-in: ChatGPT sign-in and SuperGrok device flow (experimental), token refresh jobs | Opus | SuperGrok slice done 2026-10-08 (ADR 0017); ChatGPT next, owner tests it | W10, W11 |
| W8 🟡 | Ramble: mic capture, chunked/live pipelines, live draft edits, text Ramble, schema + authz validation of extracted tasks | Opus (extractor, injection, authz) + Sonnet (UI) | **Server done 2026-10-07** (ADR 0014), **UI done 2026-10-08**; live pipeline open | W10, W11, W12 |
| W9 🟡 | AI features and decision models (Task/Filter Assist, reports, Ask your tasks with confirmed writes, eval harness) | Opus (tool design, injection, cross-project leakage) + Sonnet (individual features, eval fixtures) | **Task/Filter Assist, Ask your tasks, reports (on demand and by email), inbox triage (suggest-only) done 2026-10-08** (ADR 0021); auto-apply, Jev adapter, eval harness open | W10, W11, W12 |
| W10a ✅ | OAuth 2.1 authorization server (DCR, PKCE, consent, revocation, refresh-token reuse detection) and PATs with scopes | Opus | **Done 2026-10-06** (ADR 0008, migration 0013); project-limited tokens 2026-10-08 (ADR 0019, migration 0018) | W7, W11, W12 |
| W10b ✅ | REST v1 + OpenAPI docs, scope matrix tests | Sonnet | **Done 2026-10-07** (PR #1) | W7, W11 |
| W10c ✅ | MCP server | Opus | **Done 2026-10-06** (ADR 0009) | W11, W12 |
| W10d ✅ | Outgoing webhooks: per-user subscriptions to task/project/comment events, HMAC-SHA256 signed and timestamped, retries with backoff via the job runner, delivery only through the W7a outbound client (users' webhooks public-only), admin switch, docs for verifying signatures | Sonnet (Opus review of signing and SSRF) | **Done 2026-10-07** (ADR 0016, migration 0017, T166–T170): activity-log watermark, signed at-least-once deliveries, Settings → Webhooks | Everything |
| W11a 🟡 | Granular Todoist import (API token or backup/CSV, preview, per-item choices, dry run, background job, re-runnable) | Opus (untrusted input, token handling) + Sonnet (UI) | **Server and UI done 2026-10-08** (ADR 0020, migration 0019); completed tasks, attachments, backup files and a run on a real account open | W7, W10, W12 |
| W11b ✅ | Templates: CSV export/import (Todoist format, CSV-injection-safe) and gallery | Sonnet; CSV mapping can go to DeepSeek | **Done 2026-10-06** (ADR 0012, T115–T120): Todoist-format CSV import (preview, new or existing project) and export, nine-template gallery; import is ordinary sync commands | Everything |
| W11c ✅ | Productivity: karma, goals, streaks, vacation mode, productivity view | DeepSeek (Sonnet review) | **Done 2026-10-08** (reviewed; F-038 fixed) | Everything |
| W11d ✅ | iCal feed per project/filter (secret, revocable URL) | Sonnet | **Done 2026-10-06** (ADR 0011, T108–T114): secret hashed-at-rest links per project or saved filter (shown once, reset, revoke), access re-checked per fetch, settings → Calendar | Everything |
| W11e ✅ | Export everything, scheduled encrypted backups + restore, account deletion | Opus | **Done 2026-10-07** (ADR 0013, migration 0015) | W7b–c, W11b–d, W12 |
| W11f | Email-to-project (stretch) | Sonnet | Inbound mail decision (owner) | Everything |
| W12a | PWA: installable, offline read cache + queued writes, code splitting (F-023) | Sonnet | Best after UI churn from W7–W11 settles; caching must not break the push service worker | W10, W11 |
| W12b ✅ | WCAG 2.2 AA pass (keyboard, screen readers, drag-drop) | Sonnet | **Done 2026-10-07** ([docs/accessibility.md](accessibility.md)): axe and keyboard audit passes (`docker/a11y-audit.mjs`, repeat after big UI changes); real screen-reader testing still open for W13 | Everything |
| W12c | i18n plumbing + English string extraction; Weblate setup | DeepSeek for extraction (Sonnet review), Sonnet for plumbing | Do after most UI exists (late W11) to avoid churn | Server work |
| W13 | Hardening and v1.0: full ASVS L2 review, release pentest, load test, backup/restore drill, upgrade-path tests, docs site, demo instance, signed images | Opus (review/pentest) + Sonnet (load test, docs, release plumbing) | All of W7–W12 | — |
| M1 ✅ | Admin-managed push allow-list for UnifiedPush/self-hosted push | Sonnet | **Done 2026-10-07** (`push.allowedHosts`, ADR 0005 update) | A1, A2 |
| M2 | Multi-replica support (LISTEN/NOTIFY pokes, shared rate limiters) | Opus | Owner decision to support it; not needed for v1 | Everything |
| A1 ✅ | Android foundation and auth: discovery, OAuth PKCE via Custom Tabs, Keystore token storage, Room + sync client, background sync | Opus | **Done 2026-10-07** (ADR 0010; SQLite instead of Room) | Web W11–W12 |
| A2 | Android core screens, themes, time-zone picker, quick add (parser decided: ADR 0016, `JavaScriptSandbox`) | Sonnet | A1 | A4 later screens, web work |
| A3 ✅ | Android notifications: local exact-alarm reminders, UnifiedPush, actions | Opus | **Done 2026-10-07** (ADR 0015, migration 0016) | A2, A4 |
| A4 | Widgets, Quick Settings tile, shortcuts, share target | Sonnet | A1–A2 | A3, A5 |
| A5 | Ramble on Android | Sonnet | W8, A1 | A4 |
| A6 | Android security hardening (MobSF, MASVS) | Opus | A1–A5 | — |
| A7 | Android release: reproducible builds, F-Droid, signed APKs | Sonnet; metadata to DeepSeek | A6 | — |

**Running work in parallel.** Put each concurrent task in its own git worktree or branch, merge one at a time, and run `pnpm check` after each merge. Two agents must not edit the same migration sequence at once: only one task adds a Drizzle migration at a time, and the other rebases and renumbers. Good pairings:
- Now: **W11a Todoist import** (Opus) ‖ **A2 Android screens** (Sonnet) ‖ **W7c settings UI** (DeepSeek) ‖ **W8 Ramble** (Opus + Sonnet, unblocked by W7b); **R2** (DeepSeek) on/after 2026-10-07. (R1, R3, W7a, W7b, W10a, W10c, W11b, W11d, W11e, W12b and A1 are done and on main.)
- **W7a** (Opus) ‖ **W11c productivity** or **W11b templates** (DeepSeek/Sonnet). These touch no AI, auth or crypto code.
- **W10a OAuth AS** (Opus) ‖ **W7b adapters** (Sonnet) ‖ **W7c settings UI** (DeepSeek).
- **W11a Todoist import** or **W11e backups** (Opus) ‖ **W11d iCal**, **W12b accessibility** (Sonnet) ‖ **W12c string extraction** (DeepSeek).
- Android **A1** (Opus) can start as soon as W10a lands, alongside the remaining web deliverables.

**How to work (the process used so far):**
- Toolchain: Node 22, pnpm 12, Docker. `pnpm install`, then `pnpm check` (format, lint, typecheck, all tests) must pass. Server integration tests need a throwaway Postgres 17 container and `BOKYDO_TEST_DATABASE_URL` pointing at it (the tests skip without it).
- Run Prettier only from the repo root (`pnpm format`): run inside a sub-package it ignores the root `.prettierignore` and rewrites generated files.
- Scripted text edits must assert their anchor exists (Prettier re-pads tables and reflows code; see F-024). Insert table rows by row prefix, then grep for them.
- Per deliverable: build in slices (one commit each), then a gate: smoke checks in `docker/smoke-test.sh` (use `PORT=… MAILPIT_PORT=…` to avoid clashes), Semgrep, gitleaks, osv-scanner and Trivy with the pinned images from `.github/workflows/security.yml`, a browser walkthrough on a throwaway compose project, then docs: §8 *Done* note, threat-model rows, findings + gate-log row, ASVS, and an ADR for significant design choices.
- New `/api` routes must declare `config.access` and be added to `apps/server/src/authz-matrix.test.ts`. Replies from routes that write must be sent after the transaction commits (F-028). Writes that aren't sync commands go through `SyncService.write`.
- Mutation-check new tests (break the code, confirm a test fails) for security-relevant logic.
- Before every push: gitleaks over git history; no `.claude`, `.env`, keys or secret dirs tracked; commits use the GitHub no-reply address; no local paths, personal emails or test passwords in tracked files. Never commit walkthrough credentials.
- Upgrading a running instance: dump the database first, `docker compose up -d --build`, check health and that data is intact; remove dangling BokyDo images afterwards (repeat, since each removal exposes parent layers).

**Code map (where things live):** `packages/shared` (model, command schemas, preferences, settings, `csv.ts` and `template.ts`: CSV and Todoist-format templates), `packages/nlp` (quick add, dates, recurrence, `zonedInstant`), `packages/filter-query`, `packages/sync-client` (optimistic reducers, state), `packages/themes`; `apps/server/src` — `sync/` (engine, handlers, policy), `workspaces/`, `projects/` (invites), `attachments/`, `notifications/`, `reminders/`, `delivery/` (outbox, email, Web Push, digest), `jobs/` (runner), `calendar/` (iCal writer, feed routes), `auth/`, `admin/`, `settings/`, `http/` (access control, headers); `apps/web/src` — `pages/`, `components/`, `lib/` (`lib/templates/`: import planner, exporter, gallery); `apps/web/public/sw.js` (push service worker).

---

## Appendix A — Todoist feature parity matrix

| Todoist feature | BokyDo | Deliverable |
|---|---|---|
| Inbox, Today, Upcoming | ✅ | W2 |
| Projects, sub-projects, colors, favorites, archive | ✅ | W2 |
| Sections | ✅ | W2 |
| Sub-tasks (nested) | ✅ | W2 |
| Priorities p1–p4 | ✅ | W2 |
| Labels (personal & shared) | ✅ | W2/W4 |
| Task descriptions (markdown) | ✅ | W2 |
| Due dates/times, floating vs fixed timezone | ✅ | W3 |
| Recurring dates incl. `every!` | ✅ | W3 |
| Deadlines | ✅ | W3 |
| Task duration | ✅ | W3 |
| Natural-language quick add (`#`, `/`, `@`, `p1`, `+`, `{}`, `!`) | ✅ | W3 |
| Multi-line paste → many tasks | ✅ | W3 |
| Filters + query language, saved filters | ✅ | W4 |
| List / Board / Calendar layouts | ✅ | W2/W4 |
| View options (group, sort, filter) | ✅ | W2 |
| Reminders (relative, absolute, auto) | ✅ | W6 |
| Location reminders | ⏳ Phase 3 | — |
| Comments, attachments, reactions | ✅ | W5 |
| Sharing, assigning, roles, workspaces/teams, folders | ✅ | W5 |
| Activity log | ✅ | W5 |
| Notifications (in-app, email, push) | ✅ | W6 |
| Ramble (voice → tasks, live edits) | ✅ | W8 |
| AI Assist (break down, filter assist) | ✅ | W9 |
| Productivity / karma / goals / vacation mode | ✅ | W11 |
| Templates (import/export, gallery) | ✅ | W11 |
| Import / export / backups | ✅ | W11 |
| Calendar feed / calendar sync | ✅ feed / ⏳ 2-way sync | W11 / Phase 3 |
| Email tasks to a project | ⏳ stretch | W11 |
| Keyboard shortcuts | ✅ | W2 |
| Themes, dark mode | ✅ **plus** 10 terminal-theme families (Catppuccin, Gruvbox, Dracula, Nord, Tokyo Night, Solarized, One Dark, Rosé Pine, Everforest, Kanagawa) on web, Android and widgets | W2 / A2 / A4 |
| Font choice, text size | ➕ Beyond Todoist: 8 self-hosted font families incl. accessibility fonts, size and density | W2 / A2 |
| Time zone setting, travel detection | ✅ plus smart search by city, country, abbreviation or offset | W2 / A2 |
| Search | ✅ (+ semantic) | W2/W9 |
| REST/Sync API, webhooks | ✅ | W10 |
| Integrations marketplace | ➖ replaced by API + MCP + webhooks | W10 |
| Android app + widgets + Quick Settings tile + share | ✅ | A1–A4 |
| Wear OS / iOS / desktop apps | ⏳ Phase 3 | — |
| 2FA | ✅ (TOTP **+ passkeys**) | W1 |
| **Beyond Todoist:** self-host, BYOK AI any provider, MCP server, decision-model triage, local-first reminders without Google | ✅ | W7–W10, A3 |

## Appendix B — Sources consulted
- Todoist Ramble: https://www.todoist.com/help/articles/dictate-to-add-tasks-with-ramble-P1Raq7vVF · https://www.producttalk.org/building-todoist-ramble-how-doist-turned-voice-braindumps-into-real-time-task-capture/
- Jev decision model: https://www.firecrawl.dev/blog/what-is-jev · https://www.mindstudio.ai/blog/jev-use-cases-automation
- Sign in with ChatGPT for third-party/self-hosted tools: https://thenewstack.io/sign-in-with-chatgpt/ · https://dev.to/hassann/sign-in-with-chatgpt-for-developers-the-oauth-flow-plan-usage-and-what-it-means-for-your-api-bill-48f7
- xAI SuperGrok OAuth (device flow): https://docs.openclaw.ai/providers/xai
- Command Code Provider API: https://commandcode.ai/docs/provider
- Ollama Cloud OpenAI compatibility: https://docs.ollama.com/api/openai-compatibility
