import { z } from 'zod';
import { classifyIp, parseIp } from './ip.js';

/**
 * Outgoing webhooks (W10d). A subscription is a user's HTTPS endpoint; it receives one signed
 * POST per matching event in the projects the user can see. Events are the project activity
 * stream, so every payload carries the same snapshot the in-app activity log keeps.
 */
export const webhookEventNames = [
  'task_added',
  'task_updated',
  'task_moved',
  'task_completed',
  'task_uncompleted',
  'task_deleted',
  'comment_added',
  'project_archived',
  'project_unarchived',
] as const;
export type WebhookEventName = (typeof webhookEventNames)[number];

/** A synthetic event a user can send to their endpoint from the settings UI. */
export const WEBHOOK_TEST_EVENT = 'test';
export type WebhookEvent = WebhookEventName | typeof WEBHOOK_TEST_EVENT;

/**
 * The endpoint URL. Everything checkable without DNS is checked here (https, no credentials, no
 * fragment, public IP literals); the outbound client re-checks every resolved address at send
 * time, which is the boundary that actually matters (DNS rebinding included).
 */
export const webhookUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .transform((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Must be a URL such as https://example.com/hook' });
      return z.NEVER;
    }
    if (url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'Webhook URLs must use https' });
      return z.NEVER;
    }
    if (url.username || url.password) {
      ctx.addIssue({ code: 'custom', message: 'Webhook URLs must not contain credentials' });
      return z.NEVER;
    }
    if (url.hash) {
      ctx.addIssue({ code: 'custom', message: 'Webhook URLs must not contain a fragment' });
      return z.NEVER;
    }
    const literal = parseIp(url.hostname);
    if (literal && classifyIp(literal) !== 'public') {
      ctx.addIssue({
        code: 'custom',
        message:
          'Webhook URLs must be on the public internet (private and local addresses are refused)',
      });
      return z.NEVER;
    }
    return value;
  });
export type WebhookUrl = z.output<typeof webhookUrlSchema>;

export const webhookEventsSchema = z
  .array(z.enum(webhookEventNames))
  .min(1, 'Choose at least one event')
  .max(webhookEventNames.length)
  .refine((events) => new Set(events).size === events.length, 'Duplicate events');
export type WebhookEvents = z.output<typeof webhookEventsSchema>;

export const webhookCreateSchema = z
  .object({ url: webhookUrlSchema, events: webhookEventsSchema })
  .strict();
export type WebhookCreate = z.input<typeof webhookCreateSchema>;

export const webhookUpdateSchema = z
  .object({ url: webhookUrlSchema.optional(), events: webhookEventsSchema.optional() })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to update');
export type WebhookUpdate = z.input<typeof webhookUpdateSchema>;

/** A subscription as the list API returns it. The signing secret is never included. */
export interface WebhookSubscriptionInfo {
  id: string;
  url: string;
  events: WebhookEventName[];
  createdAt: string;
  lastDeliveryAt: string | null;
  /** Status of the most recent delivery attempt, if any. */
  lastDeliveryStatus: 'pending' | 'delivered' | 'dropped' | 'failed' | null;
  lastError: string | null;
}

/** The body of every delivery: self-describing, ids first, snapshot in `data`. */
export interface WebhookDeliveryPayload {
  id: string;
  event: WebhookEvent;
  createdAt: string;
  actorId: string | null;
  project: { id: string; name: string | null } | null;
  taskId: string | null;
  /** Present (and true) only when a payload exceeded the size cap and `data` was dropped. */
  truncated?: boolean;
  data: Record<string, unknown>;
}
