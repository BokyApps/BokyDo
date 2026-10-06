# ADR 0006: Calendar feeds (iCal subscriptions)

- Status: Accepted (2026-10-06)

## Context

W11d lets a person see their tasks in a calendar app. Calendar apps subscribe to a plain
`https://…/feed.ics` URL and poll it; many of them are hosted services (Google Calendar fetches
from Google's servers) that cannot hold a BokyDo session cookie, cannot do OAuth against BokyDo,
and cannot send custom headers. Whatever authorizes the fetch has to be in the URL.

## Decision

- **The URL is the credential (a capability link).** Each feed has a 256-bit random token in its
  path, `/api/v1/calendar/<token>.ics`. This is the same trade Todoist, Google and others make for
  subscribable calendars. To keep it safe:
  - only an HMAC of the token is stored (purpose-bound, keyed with `session.key`), so a database
    leak does not hand out working links, and a session token is never a feed link or the reverse;
  - the link is shown once, when it is created or reset, and never returned by the list;
  - revoking is deleting the row and resetting swaps the token, both effective on the next
    request (no caching, no grace period);
  - request logs redact the path (`/api/v1/calendar/[redacted]`) through logger options shared by
    the server and the tests, and `Referrer-Policy: no-referrer` is already on every response.
- **Access is judged at fetch time, as the owner, now.** A feed stores a target (a project or a
  saved filter) and an owner, not a snapshot of what the owner could see. Each fetch re-checks the
  owner's membership of the project (or runs the saved filter over what the owner can see now) and
  that the owner is not disabled. Losing access, deleting the target or disabling the account all
  end the feed without anyone remembering to clean it up.
- **One answer for every failure.** A malformed, unknown, revoked, rotated or no-longer-allowed
  link gets the same 404, so a link reveals nothing about why it failed. Failed guesses are
  rate-limited per IP; working links are never counted per IP, because hosted calendar services
  fetch for many users from shared addresses. Each feed has its own hourly cap instead.
- **Minimal disclosure by default.** The event carries title, time, project name, labels,
  priority and a link back to the task. Descriptions are included only when the owner chose that
  for the feed, because the feed leaves the instance (to a calendar app and, for hosted ones, its
  servers).
- **Tasks are events, written defensively.** One VEVENT per open task with a due date (completed
  and deleted tasks are not included; there is no VTODO because most calendar apps ignore it).
  Every text value is escaped and folded, so task text can never add properties or events.
  Times follow the task: all-day stays all-day; a floating time stays floating; a fixed zone is
  written as the exact UTC instant, except for repeating tasks, which keep their `TZID` so each
  occurrence follows daylight saving. We do not write VTIMEZONE blocks: Google, Apple and
  Thunderbird understand IANA names, and writing our own tables would be a source of bugs.
- **Repeats: only what can be said truthfully.** Schedule-anchored series are written as an
  RRULE, with UNTIL in the form RFC 5545 requires for the start type. Completion-anchored series
  ("every! …") have no fixed future, so the feed shows only the current occurrence. BokyDo clamps
  "every 31st" to the end of short months where RFC 5545 skips them, so those months can differ in
  a calendar app.
- **No new dependency.** The writer is about 150 lines and is tested against an independent
  parser (ical.js) during the walkthrough as well as by unit tests.

## Consequences

- Anyone holding a link sees titles and dates until it is reset or deleted. The settings screen
  says so, and the threat model records it as residual (T83).
- Hosted calendar apps cache what they fetched; resetting a link does not recall that copy.
- The limits are per process (in-memory), like the other limiters (ADR 0003); a multi-replica
  deployment would move them to Postgres.
- Two-way sync (CalDAV, Google Calendar API) is not covered; it needs a different trust model and
  is Phase 3 in the plan.
