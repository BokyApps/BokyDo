import type { Due } from '@bokydo/shared';
import { localNow } from '@bokydo/nlp';
import { eq } from 'drizzle-orm';
import { createDecipheriv, createECDH, hkdfSync, type ECDH } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { notifications, pushSubscriptions, users } from '../db/schema.js';
import type { OutgoingEmail } from '../email/mailer.js';
import { grantProjectAccess } from '../sync/membership.js';
import { captureMail, Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
let t: TestApp;
let mail: OutgoingEmail[];
let pushes: { url: string; headers: Record<string, string>; body: Buffer; status: number }[];
let pushStatus: number;
type Person = { sync: SyncUser; http: Client; id: string };
let alice: Person;
let bob: Person;
let project: string;

const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
  pushes.push({
    url: String(url),
    headers: init?.headers as Record<string, string>,
    body: Buffer.from(init?.body as Uint8Array),
    status: pushStatus,
  });
  return new Response(null, { status: pushStatus });
}) as typeof fetch;

async function person(name: string, timezone = 'UTC'): Promise<Person> {
  const userId = await createUser(t.db, { username: name, password: PASSWORD });
  await t.db.db
    .update(users)
    .set({ email: `${name}@example.com`, emailVerifiedAt: new Date() })
    .where(eq(users.id, userId));
  const http = new Client(t.app);
  await http.login(name, PASSWORD);
  const sync = new SyncUser(t.app.services.sync, userId);
  await sync.ok(
    cmd('user_update_preferences', { timezone, notifications: { autoReminder: null } }),
  );
  return { sync, http, id: userId };
}

/** A browser push subscription whose payloads the test can decrypt. */
function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${id()}`) {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = Buffer.alloc(16, 9);
  return {
    ecdh,
    auth,
    json: {
      endpoint,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
      expirationTime: null,
    },
  };
}

function decrypt(body: Buffer, ua: ECDH, auth: Buffer): Record<string, unknown> {
  const salt = body.subarray(0, 16);
  const asPublic = body.subarray(21, 86);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ua.computeSecret(asPublic), auth, info, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
  const data = body.subarray(86);
  const d = createDecipheriv('aes-128-gcm', cek, nonce, { authTagLength: 16 });
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  return JSON.parse(plain.subarray(0, plain.length - 1).toString()) as Record<string, unknown>;
}

const deliver = (at = new Date()) => t.app.services.jobs.tick(at);
const assign = (taskId: string, to: Person) =>
  alice.sync.ok(cmd('task_update', { id: taskId, assigneeId: to.id }));
const due = (date: string, time: string | null): Due => ({
  date,
  time,
  timezone: null,
  string: date,
  recurrence: null,
});

beforeEach(async () => {
  pushes = [];
  pushStatus = 201;
  t = await testApp({ fetchImpl: fakeFetch });
  await t.app.services.settings.update(
    { 'instance.publicUrl': 'http://bokydo.test' },
    { userId: null, ip: null },
  );
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  mail = await captureMail(t.app);
  alice = await person('alice');
  bob = await person('bob');
  project = id();
  await alice.sync.ok(cmd('project_add', { id: project, name: 'Launch' }));
  await grantProjectAccess(t.db.db, project, bob.id, 'editor');
  mail.length = 0; // sign-in alerts etc.
});
afterEach(async () => t.close());

describe.skipIf(!TEST_DATABASE_URL)('delivery: email', () => {
  it('emails per the recipient’s preferences, with a signed unsubscribe link', async () => {
    const task = id();
    await alice.sync.ok(cmd('task_add', { id: task, projectId: project, content: 'Ship' }));
    await assign(task, bob);
    await deliver();
    expect(mail).toHaveLength(1);
    expect(mail[0]).toMatchObject({ to: 'bob@example.com' });
    expect(mail[0]!.subject).toBe('BokyDo: alice assigned “Ship” to you');
    expect(mail[0]!.text).toContain(`http://bokydo.test/task/${task}`);
    expect(mail[0]!.unsubscribeUrl).toMatch(
      /^http:\/\/bokydo\.test\/unsubscribe#[0-9a-f-]+\.assigned\./,
    );

    // Comments don't email by default; turning it on does.
    await alice.sync.ok(cmd('comment_add', { id: id(), taskId: task, content: 'First' }));
    await deliver();
    expect(mail).toHaveLength(1);
    await bob.sync.ok(
      cmd('user_update_preferences', {
        notifications: { channels: { commented: { email: true } } },
      }),
    );
    await alice.sync.ok(cmd('comment_add', { id: id(), taskId: task, content: 'Second' }));
    await deliver();
    expect(mail.map((m) => m.subject)).toContain('BokyDo: alice commented on “Ship”');
    expect(mail.at(-1)!.text).toContain('Second');
  });

  it('holds back email and push in quiet hours, except reminders', async () => {
    // Quiet from the top of the last hour to two hours from now (UTC), on the real clock: delivery
    // runs two minutes ahead, which must still be inside the window at, say, 10:59.
    const now = localNow('UTC');
    const soon = localNow('UTC', new Date(Date.now() + 60_000));
    const hour = (h: number) =>
      `${String((Number(now.time.slice(0, 2)) + h + 24) % 24).padStart(2, '0')}:00`;
    await bob.sync.ok(
      cmd('user_update_preferences', {
        notifications: {
          quietHours: { enabled: true, start: hour(-1), end: hour(2) },
          channels: { reminder: { email: true } },
        },
      }),
    );
    const task = id();
    await alice.sync.ok(
      cmd('task_add', {
        id: task,
        projectId: project,
        content: 'Quiet',
        // A minute from now, so the reminder is still ahead when it's set.
        due: due(soon.date, soon.time),
      }),
    );
    await assign(task, bob);
    await bob.sync.ok(
      cmd('reminder_add', { id: id(), taskId: task, type: 'relative', minutesBefore: 0 }),
    );
    await deliver(new Date(Date.now() + 120_000));
    expect(mail.map((m) => m.subject)).toEqual(['BokyDo: Reminder: “Quiet”']);
    // Everything is still in the inbox.
    await bob.sync.run();
    expect(bob.sync.last.notifications.map((n) => n.type).sort()).toEqual(['assigned', 'reminder']);
  });

  it('never sends stale notifications or ones about projects the user has left', async () => {
    const a = id();
    const b = id();
    await alice.sync.ok(
      cmd('task_add', { id: a, projectId: project, content: 'Old' }),
      cmd('task_add', { id: b, projectId: project, content: 'Gone' }),
    );
    await assign(a, bob);
    await t.db.db
      .update(notifications)
      .set({ createdAt: new Date(Date.now() - 2 * 3600_000) })
      .where(eq(notifications.userId, bob.id));
    await assign(b, bob);
    await alice.sync.ok(cmd('project_member_remove', { projectId: project, userId: bob.id }));
    await deliver();
    // Only the removal itself (it has no project link) is sent.
    expect(mail.map((m) => m.subject)).toEqual(['BokyDo: alice removed you from “Launch”']);
  });

  it('unsubscribes one kind of email from the link, and rejects forged links', async () => {
    const task = id();
    await alice.sync.ok(cmd('task_add', { id: task, projectId: project, content: 'X' }));
    await assign(task, bob);
    await deliver();
    const token = mail[0]!.unsubscribeUrl!.split('#')[1]!;
    const anon = new Client(t.app);
    const forged = token.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
    expect(
      (await anon.post('/api/v1/notifications/unsubscribe', { token: forged })).statusCode,
    ).toBe(400);
    const otherUser = `${alice.id}${token.slice(token.indexOf('.'))}`;
    expect(
      (await anon.post('/api/v1/notifications/unsubscribe', { token: otherUser })).statusCode,
    ).toBe(400);
    const securityToken = token.replace('.assigned.', '.security.');
    expect(
      (await anon.post('/api/v1/notifications/unsubscribe', { token: securityToken })).statusCode,
    ).toBe(400);
    const res = await anon.post('/api/v1/notifications/unsubscribe', { token });
    expect(res.statusCode).toBe(200);
    await bob.sync.run();
    expect(bob.sync.last.user.preferences.notifications.channels.assigned).toEqual({
      email: false,
      push: true,
    });
    // A foreign Origin can't trigger it (it's still a CSRF-checked public route).
    anon.origin = 'https://evil.example';
    expect((await anon.post('/api/v1/notifications/unsubscribe', { token })).statusCode).toBe(403);
  });

  it('caps notification emails per user per hour', async () => {
    for (let i = 0; i < 25; i++) {
      const task = id();
      await alice.sync.ok(cmd('task_add', { id: task, projectId: project, content: `T${i}` }));
      await assign(task, bob);
    }
    await deliver();
    expect(mail).toHaveLength(20);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('delivery: push', () => {
  it('pushes an encrypted, VAPID-signed message to the user’s browsers', async () => {
    const b = browser();
    expect((await bob.http.post('/api/v1/push/subscriptions', b.json)).statusCode).toBe(201);
    const task = id();
    await alice.sync.ok(cmd('task_add', { id: task, projectId: project, content: 'Secret plans' }));
    await assign(task, bob);
    await deliver();
    expect(pushes).toHaveLength(1);
    const p = pushes[0]!;
    expect(p.url).toBe(b.json.endpoint);
    expect(p.headers).toMatchObject({ 'content-encoding': 'aes128gcm', urgency: 'normal' });
    expect(p.headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]{87}$/);
    // The push service only sees ciphertext.
    expect(p.body.includes(Buffer.from('Secret'))).toBe(false);
    expect(decrypt(p.body, b.ecdh, b.auth)).toEqual({
      title: 'alice assigned “Secret plans” to you',
      body: '',
      url: `/task/${task}`,
      tag: task,
    });
  });

  it('refuses endpoints outside the known push services (SSRF)', async () => {
    for (const endpoint of [
      'https://169.254.169.254/latest/meta-data/',
      'http://fcm.googleapis.com/fcm/send/x',
      'https://internal.lan/push',
      'https://fcm.googleapis.com.evil.example/x',
    ]) {
      const res = await bob.http.post('/api/v1/push/subscriptions', {
        ...browser().json,
        endpoint,
      });
      expect(res.statusCode, endpoint).toBe(400);
    }
    const bad = browser().json;
    bad.keys.p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
    expect((await bob.http.post('/api/v1/push/subscriptions', bad)).statusCode).toBe(400);
    expect(await t.db.db.select().from(pushSubscriptions)).toEqual([]);
  });

  it('moves an endpoint to whoever registers it last, and drops it on sign-out', async () => {
    const shared = browser();
    await alice.http.post('/api/v1/push/subscriptions', shared.json);
    await bob.http.post('/api/v1/push/subscriptions', shared.json);
    const rows = await t.db.db.select().from(pushSubscriptions);
    expect(rows.map((r) => r.userId)).toEqual([bob.id]);
    await bob.http.post('/api/v1/auth/logout', {});
    expect(await t.db.db.select().from(pushSubscriptions)).toEqual([]);
  });

  it('removes subscriptions the push service says are gone', async () => {
    await bob.http.post('/api/v1/push/subscriptions', browser().json);
    pushStatus = 410;
    const res = await bob.http.post('/api/v1/push/test', {});
    expect(JSON.parse(res.body)).toEqual({ sent: 0 });
    expect(await t.db.db.select().from(pushSubscriptions)).toEqual([]);
  });

  it('only deletes your own subscription', async () => {
    const b = browser();
    await bob.http.post('/api/v1/push/subscriptions', b.json);
    const res = await alice.http.request({
      method: 'DELETE',
      url: '/api/v1/push/subscriptions',
      payload: { endpoint: b.json.endpoint },
    });
    expect(res.statusCode).toBe(204);
    expect(await t.db.db.select().from(pushSubscriptions)).toHaveLength(1);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('delivery: new notification sources', () => {
  it('notifies invitees in-app and by email, and assigners when work is done', async () => {
    const carol = await person('carol');
    mail.length = 0;
    await alice.http.post(`/api/v1/projects/${project}/invites`, {
      identifier: 'carol',
      role: 'editor',
    });
    await carol.sync.run();
    expect(carol.sync.last.notifications[0]).toMatchObject({ type: 'invited', projectId: null });
    const task = id();
    await alice.sync.ok(cmd('task_add', { id: task, projectId: project, content: 'Deploy' }));
    await assign(task, bob);
    await bob.sync.ok(cmd('task_complete', { id: task }));
    await alice.sync.run();
    expect(alice.sync.last.notifications[0]).toMatchObject({ type: 'completed', taskId: task });
    await deliver();
    expect(mail.map((m) => m.subject)).toContain('BokyDo: alice invited you to “Launch”');
  });

  it('records security alerts in-app without a second email', async () => {
    await alice.http.post('/api/v1/auth/password', {
      currentPassword: PASSWORD,
      newPassword: 'quartz-lantern-gravel-ribbon',
    });
    // The in-app alert is recorded in the background: wait for it, not for a fixed time.
    await expect
      .poll(async () => {
        await alice.sync.run();
        return alice.sync.last.notifications[0];
      })
      .toMatchObject({
        type: 'security',
        data: { event: 'password_changed', message: 'Your password was changed' },
      });
    const before = mail.length;
    await deliver();
    expect(mail.length).toBe(before);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('delivery: daily digest', () => {
  it('sends once a day at the chosen local time, listing what is due', async () => {
    await bob.sync.ok(
      cmd('user_update_preferences', {
        timezone: 'Asia/Phnom_Penh',
        notifications: { digest: { enabled: true, time: '07:00' } },
      }),
    );
    await alice.sync.ok(
      cmd('task_add', {
        id: id(),
        projectId: project,
        content: 'Overdue thing',
        due: due('2030-01-14', null),
      }),
      cmd('task_add', {
        id: id(),
        projectId: project,
        content: 'Standup',
        due: due('2030-01-15', '09:30'),
      }),
      cmd('task_add', {
        id: id(),
        projectId: project,
        content: 'Later',
        due: due('2030-01-20', null),
      }),
    );
    const other = id();
    await alice.sync.ok(
      cmd('task_add', {
        id: other,
        projectId: project,
        content: 'Alice only',
        due: due('2030-01-15', null),
      }),
    );
    await assign(other, alice);
    mail.length = 0;
    await deliver(new Date('2030-01-14T23:59:00Z')); // 06:59 local
    expect(mail).toEqual([]);
    await deliver(new Date('2030-01-15T00:05:00Z')); // 07:05 local
    await deliver(new Date('2030-01-15T00:06:00Z'));
    const digests = mail.filter((m) => m.to === 'bob@example.com');
    expect(digests).toHaveLength(1);
    expect(digests[0]!.subject).toBe('BokyDo: 2 tasks for today');
    expect(digests[0]!.text).toContain('Overdue (1)');
    expect(digests[0]!.text).toContain('09:30 Standup  (Launch)');
    expect(digests[0]!.text).not.toContain('Alice only');
    expect(digests[0]!.text).not.toContain('Later');
    // The next day, hours after the window (e.g. the server was down), it's skipped.
    await deliver(new Date('2030-01-16T05:00:00Z'));
    expect(mail.filter((m) => m.to === 'bob@example.com')).toHaveLength(1);
  });
});
