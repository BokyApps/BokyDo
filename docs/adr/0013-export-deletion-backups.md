# ADR 0013: Data export, account deletion, and encrypted backups with restore

- Status: Accepted (2026-10-07)

## Context

W11e covers data portability and erasure for users (GDPR articles 20 and 17) and disaster
recovery for admins: "export everything, scheduled encrypted backups + restore, account
deletion". Its security gate asks for backup encryption, restore integrity and complete
deletion. Everything stays configurable in the app (no env, no CLI-first), and the instance
already has the pieces to build on: a job runner, envelope encryption and an attachment store.

## Decision

### Export

- `GET /api/v1/account/export` streams a ZIP: `export.json` (everything the user can see: all
  tasks including completed ones, projects, sections, comments, labels, filters, reminders,
  teams, folders, notifications, settings), `tasks.csv` (spreadsheet cells guarded against
  formulas) and the attachment files under sanitised names. No secrets at all: no password hash,
  TOTP secret, passkey keys, API keys or tokens, only their names and dates.
- It needs a recent password or passkey check (it's a bulk copy) and is limited to 5 an hour.
  The ZIP is written by our own small streaming writer (deflate, data descriptors), so exports of
  any size never sit in memory.

### Account deletion

- Deletion is refused while other people rely on something the user owns: shared projects, or
  teams with other members. The user transfers or deletes those first (GitHub and Todoist work
  the same way). The last administrator can't delete their account. Nothing is transferred
  automatically, which avoids surprising anyone with new ownership.
- Otherwise it is one transaction: the user row goes, and the foreign keys remove what was only
  theirs (projects and tasks, labels, filters, reminders, sessions, passkeys, tokens, app grants,
  AI keys, push subscriptions, notifications). Teams where they were the only member go too.
- In projects that live on, their tasks and comments stay, with no author. Migration 0015 changes
  `tasks.created_by_id` to `SET NULL`; it used to `CASCADE`, which would have deleted their
  tasks in other people's projects. Assignments lapse, and collaborators' devices are told
  through the change log. Attachment files of deleted projects go with the hourly purge.
- It needs a recent sign-in and the username typed. Admins can delete other accounts with the
  same checks. The audit log keeps `account.deleted` with the id only, and a verified address
  gets a notice.

### Backups and restore

- **What:** the database (one `REPEATABLE READ` snapshot, `COPY` per table), the instance keys
  (`master.key`, `session.key`, `vapid.key`, without which encrypted settings and AI keys are
  useless) and the attachment files. Sign-in state is left out (sessions, flows, OAuth codes and
  grants, API tokens, push subscriptions). After a restore everyone signs in again and tokens
  are re-issued, so a restore can't revive a revoked credential and clients start clean.
- **Format:** `BOKYDOBK`, a JSON header, then the payload in AES-256-GCM chunks of 64 KiB. The key
  comes from the admin's passphrase via argon2id (64 MiB, 3 passes). The chunks follow the STREAM
  construction: nonce = random prefix ‖ counter ‖ last-flag, and the header hash is associated
  data, so reordering, truncation, appending and header edits all fail. Inside is a small record
  format (named entries of length-prefixed frames with an end marker). Untrusted KDF parameters
  in a header are bounded before any work. Files are 0600 in `<data>/backups`, kept to a retention
  count, and downloadable for off-site copies.
- **When:** Admin → Backups sets daily or weekly backups after a given hour, how many to keep, and
  the passphrase (write-only, stored envelope-encrypted, never in backups). There is also "back
  up now", plus upload, download and delete. Downloading, deleting, uploading and restoring need
  a recent sign-in. The routes work during first-run setup, so a fresh server can be restored.
  Scheduled backups run in the background, not inside the job tick.
- **Restore:**
  1. A full authenticated pass over the file, catching a wrong passphrase, tampering, truncation
     and a schema from a different lineage or a newer version before anything changes.
  2. A `pre-restore-…` backup of the current state.
  3. One database transaction: drop the schema; replay this server's migrations up to the
     backup's version; load every table with foreign keys deferred, then checked; continue the
     serial sequences; apply this server's newer migrations. Older backups are upgraded on the
     way in.
  4. After commit, the attachments (staged meanwhile) and the keys are swapped in, with the old
     ones kept aside, and the process exits; Docker restarts it with the restored keys.
     Any failure before the commit changes nothing.

## Consequences

- Backups on the same disk don't survive losing it. The UI says to download copies.
- Losing the passphrase means losing the backups; changing it doesn't re-encrypt older ones.
- Restoring signs everyone out and requires re-creating API tokens and app connections.
- A backup from a newer BokyDo can't be restored on an older one (refused, not attempted).
- Deleting an account can be blocked by shared ownership. That's deliberate: the user (or the
  owners) must decide what happens to shared work.
