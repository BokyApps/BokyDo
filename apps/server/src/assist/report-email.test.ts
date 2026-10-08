import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { users } from '../db/schema.js';
import type { OutgoingEmail } from '../email/mailer.js';
import { grantProjectAccess } from '../sync/membership.js';
import { captureMail, Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { fakeModel } from '../test/model.js';
import { cmd, id, SyncUser } from '../test/sync.js';

/** Scheduled AI report emails (W9, ADR 0021): written at send time, from what the user sees. */
let t: TestApp;
let model: ReturnType<typeof fakeModel>;
let mail: OutgoingEmail[];

// 2026-10-12 is a Monday.
const MONDAY_0830 = new Date('2026-10-12T08:30:00Z');
const at = (iso: string) => t.app.services.jobs.tick(new Date(iso));

async function person(name: string, report: Record<string, unknown>) {
  const userId = await createUser(t.db, { username: name, password: 'x'.repeat(12) });
  await t.db.db
    .update(users)
    .set({ email: `${name}@example.com`, emailVerifiedAt: new Date() })
    .where(eq(users.id, userId));
  const http = new Client(t.app);
  const { token, session } = await t.app.services.sessions.create(
    { id: userId, username: name, isAdmin: false, mustChangePassword: false },
    { ip: null, userAgent: null, authMethod: 'password' },
  );
  http.cookies.set('bokydo_session', token);
  http.csrfToken = session.csrfToken;
  const sync = new SyncUser(t.app.services.sync, userId);
  await sync.ok(
    cmd('user_update_preferences', {
      timezone: 'UTC',
      notifications: { autoReminder: null, report },
    }),
  );
  const cred = (
    await http.post('/api/v1/ai/credentials', {
      provider: 'openai',
      label: 'mine',
      apiKey: 'sk-test-0123456789',
    })
  ).json() as { id: string };
  await http.put('/api/v1/ai/routing', { reports: { credentialId: cred.id, model: 'gpt' } });
  return { id: userId, http, sync };
}

describe.skipIf(!TEST_DATABASE_URL)('Scheduled AI report emails', () => {
  beforeEach(async () => {
    model = fakeModel();
    t = await testApp({ aiUserFetch: model.fetch });
    await t.app.services.settings.update(
      { 'instance.publicUrl': 'http://bokydo.test', 'instance.defaultTimezone': 'UTC' },
      { userId: null, ip: null },
    );
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    mail = await captureMail(t.app);
  });
  afterEach(async () => t.close());

  it('sends a weekly review once, on the chosen weekday at the chosen time', async () => {
    await person('alice', { enabled: true, kind: 'week', time: '08:00', weekday: 'monday' });
    mail.length = 0;
    model.replies.push('Good week.');
    await t.app.services.jobs.tick(new Date('2026-10-12T07:30:00Z')); // too early
    expect(mail).toHaveLength(0);
    await t.app.services.jobs.tick(MONDAY_0830);
    await t.app.services.jobs.tick(new Date('2026-10-12T09:00:00Z')); // once a day
    await at('2026-10-13T08:30:00Z'); // Tuesday: not the weekday
    expect(mail.map((m) => m.subject)).toEqual(['BokyDo: your weekly review']);
    expect(mail[0]!.text).toContain('Good week.');
    expect(mail[0]!.text).toContain('Written by AI');
    expect(mail[0]!.unsubscribeUrl).toMatch(/\.report\./);
    expect(model.seen).toHaveLength(1);
  });

  it('writes each report from what the user can see at send time', async () => {
    const owner = await person('owner', { enabled: false });
    const bob = await person('bob', { enabled: true, kind: 'day', time: '08:00' });
    const shared = id();
    await owner.sync.ok(
      cmd('project_add', { id: shared, name: 'Shared' }),
      cmd('task_add', {
        id: id(),
        projectId: shared,
        content: 'shared deadline',
        due: { date: '2026-10-12', time: null, timezone: null, string: 'today', recurrence: null },
      }),
    );
    await grantProjectAccess(t.db.db, shared, bob.id, 'editor');
    model.replies.push('Monday plan.', 'Tuesday plan.');
    await t.app.services.jobs.tick(MONDAY_0830);
    expect(model.seen[0]!.user).toContain('shared deadline');
    // Bob loses access; the next day's report doesn't know about it.
    await owner.sync.ok(cmd('project_member_remove', { projectId: shared, userId: bob.id }));
    await at('2026-10-13T08:30:00Z');
    expect(model.seen).toHaveLength(2);
    expect(model.seen[1]!.user).not.toContain('shared deadline');
    expect(mail.filter((m) => m.to === 'bob@example.com').map((m) => m.subject)).toEqual([
      'BokyDo: your plan for today',
      'BokyDo: your plan for today',
    ]);
  });

  it('skips the day quietly when no model is routed, and unsubscribes from the link', async () => {
    const alice = await person('alice', {
      enabled: true,
      kind: 'day',
      time: '08:00',
    });
    await alice.http.put('/api/v1/ai/routing', {});
    mail.length = 0;
    await t.app.services.jobs.tick(MONDAY_0830);
    expect(mail).toHaveLength(0);

    await alice.http.put('/api/v1/ai/routing', {
      reports: {
        credentialId: (await alice.http.get('/api/v1/ai/credentials')).json().credentials[0].id,
        model: 'gpt',
      },
    });
    model.replies.push('Plan.');
    await at('2026-10-13T08:30:00Z');
    expect(mail).toHaveLength(1);
    const token = mail[0]!.unsubscribeUrl!.split('#')[1]!;
    const res = await new Client(t.app).post('/api/v1/notifications/unsubscribe', { token });
    expect(res.statusCode).toBe(200);
    await alice.sync.run();
    expect(alice.sync.last.user.preferences.notifications.report.enabled).toBe(false);
    await at('2026-10-14T08:30:00Z');
    expect(mail).toHaveLength(1);
  });
});
