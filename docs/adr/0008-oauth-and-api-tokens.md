# ADR 0008: API access — OAuth 2.1 authorization server and personal access tokens

- Status: Accepted (2026-10-06)

## Context

The REST API, the MCP endpoint and the Android app need to act for a user without a browser
session (PLAN §6, W10, A1). MCP connectors such as Claude and ChatGPT expect an OAuth 2.1
server with dynamic client registration (RFC 7591), PKCE and the RFC 8414 / RFC 9728 metadata;
scripts and tools such as n8n want personal access tokens. The plan named `oidc-provider`.

## Decision

- **A narrow in-house authorization server, not `oidc-provider`.** We need authorization-code
  - PKCE and refresh tokens for API access only, not OpenID Connect sign-in: no ID tokens,
    JWKS, signing keys, front-channel sessions or a second cookie layer. `oidc-provider` is Koa-
    based, brings all of that, and would run its own interaction and session model beside ours
    (passwords, TOTP, passkeys, re-authentication). The in-house server is about 600 lines on
    primitives we already trust (`tokenId` keyed hashes, the job runner, the access hook) and
    is covered end to end and by mutation testing.
- **Opaque tokens, hashed at rest.** Access tokens (`bkd_at_…`, 1 hour), refresh tokens
  (`bkd_rt_…`, single-use, 30-day idle expiry) and personal access tokens (`bkd_pat_…`) are
  256-bit random. Only an HMAC (session key, per kind) is stored. Prefixes let secret scanners
  spot leaks and stop a refresh token being used as a bearer token. Validation is a database
  lookup, so revocation takes effect immediately.
- **Public clients only, PKCE S256 mandatory.** No client secrets: every client (dynamic or,
  later, admin-registered) uses PKCE. `plain` is refused. Authorization codes last 60 seconds
  and work once; presenting one again revokes everything issued from it, and so does a failed
  exchange. Responses carry `iss` (RFC 9207).
- **Redirect URIs:** https anywhere, http only to loopback (any port, RFC 8252), or a
  reverse-domain private-use scheme for mobile apps. No fragments or credentials, exact
  matching. Until the client and redirect URI check out, errors are a plain page, never a
  redirect.
- **Dynamic registration is open by default** (MCP connectors need it; Admin → Settings can
  turn it off) and grants nothing on its own. Names are unverified, so the consent screen says
  so and puts the redirect host first. Registration is limited to 20 an hour per IP and 1,000
  pending clients, and clients nobody authorizes are deleted after a day.
- **Consent happens in the web app**, behind the normal sign-in. `/oauth/authorize` stores the
  request and sends the browser to `/oauth/consent#<handle>`. The handle sits in the fragment,
  and in sessionStorage across sign-in. The decision is a CSRF-protected session API call. The
  user can untick scopes but never add them. Framing is blocked by the CSP and
  X-Frame-Options.
- **Grants are token families.** Refresh tokens rotate. Reusing one revokes the whole grant, so
  the attacker and the real client both lose access and the user must re-authorize (OAuth 2.1
  §4.3.1). Parallel refreshes with the same token count as reuse, so clients must serialise
  refreshes.
- **Audiences (RFC 8707).** A grant is for the API or for `/mcp`. MCP tokens never get `sync`.
  The API refuses MCP tokens; personal access tokens work for both.
- **Routes opt in to tokens.** A route accepts a bearer token only if it declares
  `config.scopes`, and the token must hold all of them. Admin and public routes can't opt in
  (registration throws), and session-only account routes (tokens, apps, MFA, passwords)
  never do, so a token can't mint or widen tokens. When an `Authorization` header is present,
  cookies are ignored, so there is nothing for CSRF to ride on. The authz-matrix test pins
  which routes accept tokens and with which scopes. W10a opens only the sync endpoint and its
  event stream (scope `sync`, the app's own full access, used by Android). W10b maps the REST
  routes to the granular scopes.
- **Account resets end API access.** Everything that revokes all sessions also revokes all
  personal access tokens and grants: a password change or reset (including from the CLI), an
  admin disabling the user or resetting their two-factor. Disabled users' tokens are refused.
  Creating a personal access token needs a recent password or passkey check, and like
  authorizing an app, it sends the user a security alert.

## Consequences

- Personal access tokens can be limited to some projects since ADR 0019 (2026-10-08).
- Browser-based OAuth clients can't call the token endpoint cross-origin (no CORS). The
  expected clients (MCP connectors' servers, native and CLI apps, Android) don't need it.
- One instance, one issuer: OAuth needs the public URL set and changes if it changes.
- The Android app must refresh tokens one at a time. Two concurrent refreshes look like a
  stolen token and sign the app out.
