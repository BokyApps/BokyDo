# ADR 0017: Subscription sign-in — personal, device flow, experimental

- Status: Accepted (2026-10-08)

## Context

Many people already pay for an AI subscription (SuperGrok / X Premium, ChatGPT Plus/Pro) and
have no API key. W7d lets them use it for their own BokyDo AI features. These sign-ins are not
the providers' documented developer APIs: they are the flows the providers' own command-line
tools use, which many third-party agents now use too, and they may change without notice.

Terms (checked 2026-10-08): xAI's consumer terms (updated 2026-09-11) don't restrict
third-party apps or automated use, but say "You may not share your account credentials or make
your account available to anyone else". OpenAI opened "Sign in with ChatGPT" to third-party
tools in 2026, but it has the same rule against sharing an account.

## Decision

- **Personal only.** A subscription sign-in is always a user's own credential. It can't be added
  through the key form, as an instance credential or by an admin for someone else, and nobody
  else's features can be routed to it. One instance-wide sign-in would make one person's account
  available to everyone, which the terms forbid.
- **Device flow (RFC 8628), server side.** The server asks the provider for a code, the user
  approves it on the provider's own site, and the server polls for the tokens. Nothing comes
  back through the browser, so there is no redirect to intercept and no loopback URL to fake.
  The page shows the code and a link, and the link is used only if it is an https page on the
  provider's own domain. Flows are kept in memory (they last minutes), one per user, and belong
  to the user who started them. The browser asks for the result, but the server only polls the
  provider at the provider's interval and backs off on `slow_down`.
- **xAI.** The public client of xAI's Grok CLI against `auth.x.ai` (published discovery:
  device, token and revoke endpoints) asks only for `openid profile email offline_access
grok-cli:access api:access`. It does not ask for API-key, billing or workspace scopes. The
  access token is a bearer for `https://api.x.ai/v1`, so the existing OpenAI-dialect adapter
  works unchanged. The catalog entry is `xai-subscription`.
- **Tokens.** Tokens are kept like keys: the access token, the refresh token and the expiry are
  stored in the credential's AEAD-encrypted secret, bound to the row and its owner. They are
  never returned or logged; the account email (from the ID token, for display only) becomes the
  label. `hasKey` means "signed in".
- **Renewal.** Before a call, a token that expires within 5 minutes is renewed under the
  credential's row lock. Concurrent calls therefore renew once: providers rotate refresh tokens,
  and reusing an old one can end the sign-in. `invalid_grant` drops the tokens and marks the
  credential signed out (audited). The feature then counts as not set up, so the instance route
  can serve it, and the user can sign in again in place (same id, label and routes). An hourly
  job renews sign-ins that have been idle for 3 days, so rarely used routes don't lapse.
- **Leaving.** Removing the credential also revokes the refresh token at the provider (RFC 7009,
  best effort). Deleting the account removes the credentials, but they are not revoked.
- **Experimental switch.** `ai.subscriptionSignIn` is off by default. An admin turns it on (it
  also needs `ai.userKeys`). Turning it off stops existing sign-ins being used and blocks new
  ones. Rate limits are 5 sign-in starts per 10 minutes and 60 polls a minute per user.
- **ChatGPT** is the next slice. It uses Codex's device flow (which needs device-code sign-in
  enabled in the user's ChatGPT security settings) and a Responses-API dialect for the Codex
  backend. It will be built the same way.

## Consequences

- People can use AI with a subscription they already have and no key, and only for themselves.
- If a provider changes or closes the flow, sign-in breaks. API keys keep working, and the admin
  can switch the feature off.
- With more than one server replica, a sign-in in progress could be polled on a replica that
  didn't start it. BokyDo runs as one replica (M2 is not planned).
- The client id belongs to xAI's own tool. If xAI starts requiring registered third-party
  clients, it becomes a setting.
