# ADR 0016: Outgoing webhooks

- Status: Accepted (2026-10-07)

## Context

W10d (PLAN §8): users should be able to subscribe their own services to task, project and comment
events. BokyDo already had the two hard parts: an SSRF-safe outbound HTTP client with a
public-only policy for anything a user configures (`net/outbound.ts`, ADR 0006) and a
Postgres-backed job runner for retries (ADR 0005). The open design questions were the event
source, the delivery semantics, and how the signing secret is stored.

## Decision

- **Event source: the activity log with a watermark.** Every task/project/comment event is
  already written to the `activity` table inside the command's transaction, with the actor and a
  small snapshot (`activity/log.ts`). A `webhook_state` row records how far the `webhooks` job has
  read; a single transaction per batch advances the watermark over exactly the deliveries it
  queued. No sync-engine changes, no missed or double-delivered events, and the payload data is
  the same snapshot the in-app activity log keeps. Events the log does not record (project renames,
  comment edits) are out of scope for v1.
- **Fan-out by current membership.** For each activity row, subscriptions of the project's current
  enabled members match; a subscription only receives events that happened after it was created
  (`created_at <= activity.at`). Access is re-checked at delivery time, so a delivery queued
  before a member loses access is dropped, not sent (the calendar-feed rule, T110).
- **At-least-once with frozen payloads.** One `webhook_deliveries` row per (event, subscription)
  pair holds the complete JSON payload; retries re-send it byte-identically. Success is a 2xx;
  everything else (including redirects and timeouts, which the outbound client raises as reason
  codes) retries on a backoff schedule (1m/5m/15m/1h/6h/24h/24h) and then dead-letters. Receivers
  deduplicate on `X-BokyDo-Delivery`.
- **Signing: HMAC-SHA256 over `"{timestamp}.{body}"`** (Stripe-style), with a 256-bit per-endpoint
  secret shown once. The secret must be usable by the server on every delivery, so it is stored
  envelope-encrypted (ADR 0002) with the subscription id and owner as associated data — unlike
  feed tokens, which only need verifying and are stored as HMACs. Rotation replaces the secret.
- **Public-only, always.** User endpoints go through `createOutbound(PUBLIC_ONLY)` regardless of
  the admin's private-network allow-list (mirroring user AI credentials). Entry validation refuses
  non-https URLs, credentials in the URL, fragments and non-public IP literals; the outbound
  client is the real boundary at send time (DNS rebinding included). Responses are never read
  beyond the status; reason codes only in logs and the UI, never URLs or response bodies.
- **Management is session-only** (`/api/v1/webhooks*`, like calendar feeds, not part of the token
  REST API); create and rotate require recent re-authentication because a webhook is a standing
  data-export channel, like a personal access token. Admin switch: `api.webhooksEnabled`; while
  off, nothing is queued and the watermark advances (no retroactive flood on re-enable).
- **Flood control:** 10 subscriptions per user, 500 deliveries per endpoint per hour (excess
  deferred, lossless), 64 KiB payload cap (oversized snapshots become ids-only + `truncated`),
  10 s timeout, bounded batches in the job.

## Consequences

- Webhook payloads expose task content to whatever endpoint the user points at; that is the
  feature. It is covered by the session/re-auth gate, the audit log (URLs excluded, as they can
  carry credentials) and the threat-model rows T166–T170.
- A future REST/token surface for webhook management can reuse the service unchanged; the
  management routes are deliberately thin.
- Possible follow-ups (not v1): per-project subscription filters, a security email when a webhook
  is created, member_* event types.
