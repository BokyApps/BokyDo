import { localNow, toMinutes } from '@bokydo/nlp';
import {
  resolvePreferences,
  type NotificationEvent,
  type NotificationPrefs,
  type NotificationType,
} from '@bokydo/shared';
import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client.js';
import {
  notifications,
  projectMembers,
  projects,
  oauthGrants,
  pushSubscriptions,
  tasks,
  users,
} from '../db/schema.js';
import type { Mailer } from '../email/mailer.js';
import {
  allowlistPolicy,
  createOutbound,
  type OutboundFetch,
  type Resolver,
} from '../net/outbound.js';
import type { SettingsService } from '../settings/settings-service.js';
import { clean, contentOf, eventOf, pushMessageOf, type NotificationContent } from './messages.js';
import { unsubscribeToken, type UnsubscribeTopic } from './unsubscribe.js';
import { pushEndpointAllowed, sendPush, type PushMessage, type VapidKeys } from './webpush.js';

/** Notifications not delivered within this long (e.g. a long outage) stay in-app only. */
const STALE_MS = 3600_000;
/** Each user gets at most this many notification emails per hour; the rest stay in-app. */
const EMAILS_PER_HOUR = 20;
/** A digest is sent only within this long after its time (not hours late after downtime). */
const DIGEST_WINDOW_MIN = 180;
const DIGEST_MAX_TASKS = 50;

export interface DeliveryDeps {
  db: Database;
  settings: SettingsService;
  mailer: Mailer;
  vapid: VapidKeys;
  sessionKey: Buffer;
  log: FastifyBaseLogger;
  /** Tests only: stands in for the network when sending push. */
  fetchImpl?: typeof fetch;
  /** Tests only: replaces DNS for the outbound client. */
  resolver?: Resolver;
}

/** Tests only: a `fetch` stand-in shaped like the outbound client. */
function outboundFromFetch(fetchImpl: typeof fetch): OutboundFetch {
  return async (url, init = {}) => {
    const res = await fetchImpl(url, {
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      ...(init.body !== undefined ? { body: init.body } : {}),
    });
    const text = () => res.text();
    return {
      status: res.status,
      headers: Object.fromEntries(res.headers),
      body: (async function* () {})(),
      text,
      json: async () => JSON.parse(await text()) as unknown,
      cancel: () => void res.body?.cancel().catch(() => undefined),
    };
  };
}

/** Quiet hours: `start`–`end` local time, wrapping past midnight when start > end. */
export function inQuietHours(q: NotificationPrefs['quietHours'], localTime: string): boolean {
  if (!q.enabled || q.start === q.end) return false;
  const t = toMinutes(localTime);
  const start = toMinutes(q.start);
  const end = toMinutes(q.end);
  return start < end ? t >= start && t < end : t >= start || t < end;
}

function formatClock(hhmm: string, format: '24h' | '12h'): string {
  if (format === '24h') return hhmm;
  const h = Number(hhmm.slice(0, 2));
  return `${((h + 11) % 12) + 1}:${hhmm.slice(3)}${h < 12 ? 'am' : 'pm'}`;
}

/**
 * Email and Web Push delivery of in-app notifications. Each notification is claimed once from
 * the outbox (`dispatched_at`), then sent according to the recipient's preferences at that
 * moment. At-most-once: a crash mid-send loses that email or push, never duplicates it.
 */
export class Delivery {
  private readonly emailLog = new Map<string, number[]>();

  constructor(private readonly deps: DeliveryDeps) {}

  private get publicUrl(): string | null {
    return this.deps.settings.get('instance.publicUrl');
  }

  get canEmail(): boolean {
    return this.deps.mailer.isConfigured() && this.publicUrl !== null;
  }

  /** Claim and deliver pending notifications; returns how many were claimed. */
  async dispatch(now: Date, batch = 100): Promise<number> {
    const { db } = this.deps;
    const pending = db
      .select({ id: notifications.id })
      .from(notifications)
      .where(isNull(notifications.dispatchedAt))
      .orderBy(asc(notifications.createdAt))
      .limit(batch)
      .for('update', { skipLocked: true });
    const claimed = await db
      .update(notifications)
      .set({ dispatchedAt: now })
      .where(inArray(notifications.id, pending))
      .returning();
    if (claimed.length === 0) return 0;

    const userIds = [...new Set(claimed.map((n) => n.userId))];
    const actorIds = [...new Set(claimed.map((n) => n.actorId).filter((x): x is string => !!x))];
    const people = await db
      .select({
        id: users.id,
        username: users.username,
        email: users.email,
        verified: users.emailVerifiedAt,
        disabled: users.disabledAt,
        preferences: users.preferences,
      })
      .from(users)
      .where(inArray(users.id, [...new Set([...userIds, ...actorIds])]));
    const byId = new Map(people.map((p) => [p.id, p]));
    const memberships = new Set(
      (
        await db
          .select({ projectId: projectMembers.projectId, userId: projectMembers.userId })
          .from(projectMembers)
          .where(inArray(projectMembers.userId, userIds))
      ).map((m) => `${m.projectId}:${m.userId}`),
    );

    for (const n of claimed) {
      const user = byId.get(n.userId);
      if (!user || user.disabled) continue;
      if (now.getTime() - n.createdAt.getTime() > STALE_MS) continue;
      // Same rule as the in-app list: nothing about projects they can no longer see.
      if (n.projectId && !memberships.has(`${n.projectId}:${n.userId}`)) continue;
      const prefs = resolvePreferences(user.preferences);
      const type = n.type as NotificationType;
      const event = eventOf(type);
      const channels = prefs.notifications.channels[event];
      const local = localNow(
        prefs.timezone ?? this.deps.settings.get('instance.defaultTimezone'),
        now,
      );
      // Reminders were asked for at that time; security alerts can't wait.
      const quiet =
        event !== 'reminder' &&
        event !== 'security' &&
        inQuietHours(prefs.notifications.quietHours, local.time);
      if (quiet) continue;
      const content = contentOf(
        {
          type,
          data: n.data as Record<string, unknown>,
          taskId: n.taskId,
          projectId: n.projectId,
        },
        n.actorId ? (byId.get(n.actorId)?.username ?? null) : null,
      );
      try {
        // Security emails are sent directly by the notifier (always, to the right address).
        if (channels.email && event !== 'security' && user.email && user.verified)
          await this.email(user.id, user.email, event, content, now);
        if (channels.push)
          await this.push(user.id, pushMessageOf(content, n.taskId ?? n.id), {
            urgency: event === 'reminder' || event === 'security' ? 'high' : 'normal',
          });
      } catch (err) {
        this.deps.log.warn({ err, notification: n.id }, 'notification delivery failed');
      }
    }
    return claimed.length;
  }

  private underEmailBudget(userId: string, now: Date): boolean {
    const recent = (this.emailLog.get(userId) ?? []).filter((t) => now.getTime() - t < 3600_000);
    if (recent.length >= EMAILS_PER_HOUR) return false;
    recent.push(now.getTime());
    this.emailLog.set(userId, recent);
    return true;
  }

  private footer(userId: string, topic: UnsubscribeTopic): { text: string; unsubscribe: string } {
    const base = this.publicUrl ?? '';
    const unsubscribe = `${base}/unsubscribe#${unsubscribeToken(this.deps.sessionKey, userId, topic)}`;
    return {
      unsubscribe,
      text: [
        '',
        '—',
        `Change which emails you get: ${base}/settings/notifications`,
        `Stop emails like this: ${unsubscribe}`,
      ].join('\n'),
    };
  }

  private async email(
    userId: string,
    to: string,
    event: NotificationEvent,
    c: NotificationContent,
    now: Date,
  ) {
    if (!this.canEmail || event === 'security' || !this.underEmailBudget(userId, now)) return;
    const name = clean(this.deps.settings.get('instance.name'), 60);
    const { text, unsubscribe } = this.footer(userId, event);
    await this.deps.mailer.send({
      to,
      subject: `${name}: ${c.title}`,
      text:
        [
          c.title,
          ...(c.detail ? ['', c.detail] : []),
          '',
          `Open it: ${this.publicUrl}${c.path}`,
          text,
        ].join('\n') + '\n',
      unsubscribeUrl: unsubscribe,
    });
  }

  /** Whether a device may register this push endpoint (vendor services + the admin's list). */
  acceptsPushEndpoint(endpoint: string): boolean {
    return pushEndpointAllowed(endpoint, this.deps.settings.get('push.allowedHosts'));
  }

  /**
   * The client push is sent with. Vendor services are public; an admin-listed push host may also
   * be on a private network (a self-hosted ntfy), so its name is allowed to resolve to private
   * addresses, as are the instance's private-network allow-list entries. Loopback, link-local and
   * metadata addresses stay unreachable whatever the lists say.
   */
  private pushFetch(): OutboundFetch {
    if (this.deps.fetchImpl) return outboundFromFetch(this.deps.fetchImpl);
    const hosts = this.deps.settings
      .get('push.allowedHosts')
      .filter((h) => !h.startsWith('*.'))
      .map((h) => h.replace(/:\d+$/, ''));
    const policy = allowlistPolicy([
      ...this.deps.settings.get('network.privateAllowlist'),
      ...hosts,
    ]);
    return createOutbound(policy, this.deps.resolver);
  }

  /** Send to every device the user enabled push on; dead subscriptions are removed. */
  async push(
    userId: string,
    message: PushMessage,
    opts: { urgency?: 'high' | 'normal' } = {},
  ): Promise<number> {
    const { db } = this.deps;
    // An app's subscription stops with its grant, even before housekeeping removes it.
    const rows = await db
      .select({ sub: pushSubscriptions, grantRevokedAt: oauthGrants.revokedAt })
      .from(pushSubscriptions)
      .leftJoin(oauthGrants, eq(oauthGrants.id, pushSubscriptions.grantId))
      .where(eq(pushSubscriptions.userId, userId));
    const stale = rows.filter((r) => r.grantRevokedAt).map((r) => r.sub.id);
    if (stale.length)
      await db.delete(pushSubscriptions).where(inArray(pushSubscriptions.id, stale));
    const subs = rows.filter((r) => !r.grantRevokedAt).map((r) => r.sub);
    let sent = 0;
    const subject = this.publicUrl ?? 'https://bokydo.invalid';
    const fetch = this.pushFetch();
    const extraHosts = this.deps.settings.get('push.allowedHosts');
    for (const sub of subs) {
      const result = await sendPush(sub, message, this.deps.vapid, subject, {
        ...opts,
        fetch,
        extraHosts,
      });
      if (result === 'sent') {
        sent++;
        await db
          .update(pushSubscriptions)
          .set({ lastSuccessAt: new Date(), failures: 0 })
          .where(eq(pushSubscriptions.id, sub.id));
      } else if (result === 'gone' || sub.failures >= 9) {
        await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, sub.id));
      } else {
        await db
          .update(pushSubscriptions)
          .set({ failures: sub.failures + 1 })
          .where(eq(pushSubscriptions.id, sub.id));
      }
    }
    return sent;
  }

  /** Daily digest emails for users whose local digest time has come; returns how many sent. */
  async digests(now: Date): Promise<number> {
    if (!this.canEmail) return 0;
    const { db } = this.deps;
    const candidates = await db
      .select({
        id: users.id,
        email: users.email,
        preferences: users.preferences,
        lastDigestOn: users.lastDigestOn,
      })
      .from(users)
      .where(
        and(
          isNull(users.disabledAt),
          sql`${users.emailVerifiedAt} is not null`,
          sql`${users.preferences}->'notifications'->'digest'->>'enabled' = 'true'`,
        ),
      );
    let sent = 0;
    for (const u of candidates) {
      const prefs = resolvePreferences(u.preferences);
      const local = localNow(
        prefs.timezone ?? this.deps.settings.get('instance.defaultTimezone'),
        now,
      );
      const since = toMinutes(local.time) - toMinutes(prefs.notifications.digest.time);
      if (!u.email || u.lastDigestOn === local.date || since < 0 || since > DIGEST_WINDOW_MIN)
        continue;
      // Claim the day first: a failed send is skipped, never repeated every tick.
      const claimed = await db
        .update(users)
        .set({ lastDigestOn: local.date })
        .where(
          and(
            eq(users.id, u.id),
            or(isNull(users.lastDigestOn), sql`${users.lastDigestOn} <> ${local.date}`),
          ),
        )
        .returning({ id: users.id });
      if (claimed.length === 0) continue;
      const due = await this.digestTasks(u.id, local.date);
      if (due.length === 0) continue;
      try {
        await this.sendDigest(u.id, u.email, local.date, due, prefs.timeFormat);
        sent++;
      } catch (err) {
        this.deps.log.warn({ err }, 'digest email failed');
      }
    }
    return sent;
  }

  /** Open tasks due today or earlier, unassigned or assigned to the user, in live projects. */
  private async digestTasks(userId: string, today: string) {
    return this.deps.db
      .select({
        content: tasks.content,
        dueDate: tasks.dueDate,
        due: tasks.due,
        project: projects.name,
        isInbox: projects.isInbox,
      })
      .from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .innerJoin(
        projectMembers,
        and(eq(projectMembers.projectId, tasks.projectId), eq(projectMembers.userId, userId)),
      )
      .where(
        and(
          isNull(tasks.deletedAt),
          eq(tasks.isCompleted, false),
          isNull(projects.deletedAt),
          eq(projects.isArchived, false),
          lte(tasks.dueDate, today),
          or(isNull(tasks.assigneeId), eq(tasks.assigneeId, userId)),
        ),
      )
      .orderBy(asc(tasks.dueDate), sql`${tasks.due}->>'time' asc nulls last`)
      .limit(DIGEST_MAX_TASKS + 1);
  }

  private async sendDigest(
    userId: string,
    to: string,
    today: string,
    due: Awaited<ReturnType<Delivery['digestTasks']>>,
    timeFormat: '24h' | '12h',
  ) {
    const line = (t: (typeof due)[number]) => {
      const time = t.due?.time ? `${formatClock(t.due.time, timeFormat)} ` : '';
      return `  • ${time}${clean(t.content, 200)}  (${t.isInbox ? 'Inbox' : clean(t.project, 60)})`;
    };
    const shown = due.slice(0, DIGEST_MAX_TASKS);
    const overdue = shown.filter((t) => (t.dueDate ?? '') < today);
    const todays = shown.filter((t) => t.dueDate === today);
    const name = clean(this.deps.settings.get('instance.name'), 60);
    const { text, unsubscribe } = this.footer(userId, 'digest');
    const body = [
      `Your day (${today})`,
      ...(overdue.length ? ['', `Overdue (${overdue.length})`, ...overdue.map(line)] : []),
      ...(todays.length ? ['', `Today (${todays.length})`, ...todays.map(line)] : []),
      ...(due.length > DIGEST_MAX_TASKS ? ['', '…and more.'] : []),
      '',
      `Open Today: ${this.publicUrl}/today`,
      text,
    ];
    await this.deps.mailer.send({
      to,
      subject: `${name}: ${due.length > DIGEST_MAX_TASKS ? `${DIGEST_MAX_TASKS}+` : due.length} task${due.length === 1 ? '' : 's'} for today`,
      text: body.join('\n') + '\n',
      unsubscribeUrl: unsubscribe,
    });
  }
}
