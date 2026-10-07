# Webhooks

Outgoing webhooks let your own services react to what happens in BokyDo: for each event you
choose, BokyDo sends one signed `POST` request to your `https` endpoint. Manage them under
**Settings → Webhooks**; each user may register up to 10 endpoints.

Delivery rules:

- Events are delivered for the projects you can **currently** see. Lose access and deliveries for
  that project stop immediately.
- Endpoints must be public `https` addresses. BokyDo connects only to the public internet —
  private, loopback and cloud-metadata addresses are refused, redirects are never followed.
- Deliveries are retried with backoff (1 min, 5 min, 15 min, 1 h, 6 h, 24 h, 24 h) and then
  dead-lettered after 8 attempts. A `test` event can be sent from the settings at any time.
- Delivery is at-least-once: deduplicate on the `X-BokyDo-Delivery` header.
- At most 500 deliveries per endpoint per hour; excess is deferred, not dropped.

## Events

| Event                | When                                               | `data` snapshot keys                              |
| -------------------- | -------------------------------------------------- | ------------------------------------------------- |
| `task_added`         | A task is created                                  | `title`, `parentId`                               |
| `task_updated`       | A task's fields change                             | `title`, `fields`, `from?`, `assigneeId?`, `due?` |
| `task_moved`         | A task moves to another project, section or parent | `title`, `from`, `to`                             |
| `task_completed`     | A task (or occurrence) is completed                | `title`, `occurrence?`, `next?`                   |
| `task_uncompleted`   | A task is reopened                                 | `title`                                           |
| `task_deleted`       | A task is deleted                                  | `title`, `subtasks`                               |
| `comment_added`      | A comment is posted                                | `title`, `excerpt` (first 140 chars)              |
| `project_archived`   | A project is archived                              | —                                                 |
| `project_unarchived` | A project is unarchived                            | —                                                 |

Every payload is the same shape:

```json
{
  "id": "0192f6c4-…",
  "event": "task_added",
  "createdAt": "2026-10-07T09:15:00.000Z",
  "actorId": "0192…",
  "project": { "id": "0192…", "name": "Work" },
  "taskId": "0192f6c4-…",
  "data": { "title": "Ship the release" }
}
```

## Verifying signatures

When you add an endpoint, BokyDo generates a **signing secret** and shows it once (store it like
a password; you can rotate it any time — the old secret stops working immediately). Every request
carries:

| Header               | Value                                                 |
| -------------------- | ----------------------------------------------------- |
| `X-BokyDo-Event`     | Event name, e.g. `task_added` (or `test`)             |
| `X-BokyDo-Delivery`  | Delivery id — deduplicate on this                     |
| `X-BokyDo-Timestamp` | Unix seconds                                          |
| `X-BokyDo-Signature` | `sha256=<hex>`: HMAC-SHA256 of `"{timestamp}.{body}"` |

Verify like this (Node.js):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

const expected =
  "sha256=" +
  createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
const ok =
  expected.length === signature.length &&
  timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
```

Always compare in constant time, and reject deliveries whose timestamp is more than five minutes
old (or in the future) so a captured request cannot be replayed later. Use the **raw** request
body — parse JSON only after the signature checks out.

## Limits and operations

- 10 endpoints per user, 64 KiB maximum payload (larger snapshots are sent as ids-only with
  `truncated: true`), 10 s timeout per delivery, response bodies are ignored.
- Admins can switch webhooks off instance-wide (Admin → Settings). While off, nothing is queued;
  events are not delivered retroactively when switched back on.
