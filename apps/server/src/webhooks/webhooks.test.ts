import type { WebhookDeliveryPayload } from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { webhookDeliveries, webhookSubscriptions } from '../db/schema.js';
import type { OutboundFetch, OutboundResponse } from '../net/outbound.js';
import { grantProjectAccess, revokeProjectAccess } from '../sync/membership.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { MAX_SUBSCRIPTIONS_PER_USER } from './webhooks.js';

const PASSWORD = 'violin-pancake-orbit-meadow';

let t: TestApp;
let alice: SyncUser;
let bob: SyncUser;
let aliceHttp: Client;
let bobHttp: Client;

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  alice = new SyncUser(
    t.app.services.sync,
    await createUser(t.db, { username: 'alice', password: PASSWORD }),
  );
  bob = new SyncUser(
    t.app.services.sync,
    await createUser(t.db, { username: 'bob', password: PASSWORD }),
  );
  await alice.run();
  await bob.run();
  aliceHttp = new Client(t.app);
  bobHttp = new Client(t.app);
  await aliceHttp.login('alice', PASSWORD);
  await bobHttp.login('bob', PASSWORD);
  // Like production, where the job's first tick initialises the watermark long before anyone
  // subscribes: activity from before a subscription exists is never delivered.
  await t.app.services.webhooks.enqueue(new Date());
});
afterEach(async () => t.close());

/** Records what the server would post; a 2xx answer like a well-behaved endpoint. */
function captureWebhook(status = 200): {
  posts: { url: string; headers: Record<string, string>; body: string }[];
  fetch: OutboundFetch;
} {
  const posts: { url: string; headers: Record<string, string>; body: string }[] = [];
  const fetch: OutboundFetch = async (url, init = {}) => {
    posts.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : Buffer.from(init.body ?? '').toString(),
    });
    return {
      status,
      headers: {},
      body: [] as never,
      text: async () => '',
      json: async () => ({}),
      cancel: () => undefined,
    } satisfies OutboundResponse;
  };
  return { posts, fetch };
}

async function createWebhook(
  client: Client,
  body: Record<string, unknown>,
): Promise<{ id: string; secret: string }> {
  const res = await client.post('/api/v1/webhooks', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}

const URL_OK = 'https://hooks.example.com/bokydo';

/** Job body from app.ts: drain the queue. */
async function runWebhooks(now = new Date()): Promise<void> {
  for (let i = 0; i < 50; i++) if ((await t.app.services.webhooks.enqueue(now)) < 500) break;
  for (let i = 0; i < 20; i++) if ((await t.app.services.webhooks.dispatch(now)) < 100) break;
}

describe.skipIf(!TEST_DATABASE_URL)('webhooks: managing subscriptions', () => {
  it('returns the secret once, lists subscriptions without it, and audits the create', async () => {
    const created = await createWebhook(aliceHttp, {
      url: URL_OK,
      events: ['task_added', 'comment_added'],
    });
    expect(created.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(created.id).toBeDefined();

    const list = await aliceHttp.get('/api/v1/webhooks');
    expect(list.statusCode).toBe(200);
    const body = list.json() as { webhooks: { id: string; url: string; events: string[] }[] };
    expect(body.webhooks).toHaveLength(1);
    expect(body.webhooks[0]!.url).toBe(URL_OK);
    expect(body.webhooks[0]!.events).toEqual(['task_added', 'comment_added']);
    expect(JSON.stringify(body)).not.toContain(created.secret);

    const rows = await t.db.db.select().from(webhookSubscriptions);
    expect(JSON.stringify(rows)).not.toContain(created.secret);
    expect(JSON.stringify(rows)).toContain('dek');

    const audits = await t.db.db.select().from((await import('../db/schema.js')).auditLog);
    const entry = audits.find((a) => a.action === 'webhook.created');
    expect(entry?.targetId).toBe(created.id);
  });

  it('validates the URL and events strictly', async () => {
    for (const url of [
      'http://hooks.example.com/x',
      'https://user:pass@hooks.example.com/x',
      'https://hooks.example.com/x#frag',
      'https://127.0.0.1/x',
      'https://[::1]/x',
      'https://10.0.0.5/x',
      'not a url',
      `${'x'.repeat(2100)}`,
    ]) {
      const res = await aliceHttp.post('/api/v1/webhooks', {
        url,
        events: ['task_added'],
      });
      expect(res.statusCode, url).toBe(400);
      expect((res.json() as { error: string }).error).toBe('validation_failed');
    }
    for (const events of [[], ['nope'], ['task_added', 'task_added'], 'task_added']) {
      const res = await aliceHttp.post('/api/v1/webhooks', { url: URL_OK, events });
      expect(res.statusCode, String(events)).toBe(400);
    }
    // Hostname URLs pass entry validation; the outbound client is the boundary at send time.
    const res = await aliceHttp.post('/api/v1/webhooks', {
      url: 'https://internal.corp.lan/hook',
      events: ['task_added'],
    });
    expect(res.statusCode).toBe(201);
  });

  it('rotates the secret, updates, and deletes — only for the owner', async () => {
    const hook = await createWebhook(aliceHttp, { url: URL_OK, events: ['task_added'] });
    const forged = new Client(t.app);
    await forged.login('bob', PASSWORD);

    const rotated = await bobHttp.post(`/api/v1/webhooks/${hook.id}/rotate`);
    expect(rotated.statusCode).toBe(404);

    const byOwner = await aliceHttp.post(`/api/v1/webhooks/${hook.id}/rotate`);
    expect(byOwner.statusCode).toBe(200);
    expect((byOwner.json() as { secret: string }).secret).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const patched = await aliceHttp.patch(`/api/v1/webhooks/${hook.id}`, {
      events: ['comment_added'],
    });
    expect(patched.statusCode).toBe(204);
    const [row] = await t.db.db.select().from(webhookSubscriptions);
    expect(row?.events).toEqual(['comment_added']);

    const removed = await bobHttp.delete(`/api/v1/webhooks/${hook.id}`);
    expect(removed.statusCode).toBe(404);
    const gone = await aliceHttp.delete(`/api/v1/webhooks/${hook.id}`);
    expect(gone.statusCode).toBe(204);
    expect((await t.db.db.select().from(webhookSubscriptions)).length).toBe(0);
  });

  it('caps subscriptions per user and refuses work while the admin switch is off', async () => {
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER; i++)
      await createWebhook(aliceHttp, { url: `${URL_OK}/${i}`, events: ['task_added'] });
    const over = await aliceHttp.post('/api/v1/webhooks', {
      url: `${URL_OK}/over`,
      events: ['task_added'],
    });
    expect(over.statusCode).toBe(429);
    expect((over.json() as { error: string }).error).toBe('limit_exceeded');

    await t.app.services.settings.update(
      { 'api.webhooksEnabled': false },
      { userId: null, ip: null },
    );
    const disabled = await aliceHttp.post('/api/v1/webhooks', {
      url: `${URL_OK}/x`,
      events: ['task_added'],
    });
    expect(disabled.statusCode).toBe(409);
    expect((disabled.json() as { error: string }).error).toBe('webhooks_disabled');
  });

  it('requires recent re-authentication to create and rotate', async () => {
    await t.db.db.execute(`update sessions set reauthenticated_at = now() - interval '1 hour'`);
    const stale = await aliceHttp.post('/api/v1/webhooks', {
      url: URL_OK,
      events: ['task_added'],
    });
    expect(stale.statusCode).toBe(403);
    expect((stale.json() as { error: string }).error).toBe('reauth_required');
  });

  it('requires recent re-authentication to point a webhook at a new URL, not to change events', async () => {
    const hook = await createWebhook(aliceHttp, { url: URL_OK, events: ['task_added'] });
    await t.db.db.execute(`update sessions set reauthenticated_at = now() - interval '1 hour'`);
    const moved = await aliceHttp.patch(`/api/v1/webhooks/${hook.id}`, {
      url: 'https://attacker.example.net/collect',
    });
    expect(moved.statusCode).toBe(403);
    expect((moved.json() as { error: string }).error).toBe('reauth_required');
    const [row] = await t.db.db
      .select()
      .from(webhookSubscriptions)
      .where(eq(webhookSubscriptions.id, hook.id));
    expect(row?.url).toBe(URL_OK);
    expect(
      (await aliceHttp.patch(`/api/v1/webhooks/${hook.id}`, { events: ['task_completed'] }))
        .statusCode,
    ).toBe(204);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('webhooks: delivery', () => {
  it('delivers a signed task event and the signature verifies', async () => {
    const hook = await createWebhook(aliceHttp, { url: URL_OK, events: ['task_added'] });
    const { posts, fetch } = captureWebhook();
    t.app.services.webhooks.fetch = fetch;

    const taskId = id();
    const projectId = id();
    await alice.ok(
      cmd('project_add', { id: projectId, name: 'Webhook project' }),
      cmd('task_add', { id: taskId, projectId, content: 'Ship it' }),
    );

    await runWebhooks();
    expect(posts).toHaveLength(1);
    const post = posts[0]!;
    expect(post.url).toBe(URL_OK);
    expect(post.headers['x-bokydo-event']).toBe('task_added');
    expect(post.headers['x-bokydo-delivery']).toBeDefined();
    const ts = post.headers['x-bokydo-timestamp']!;
    const sig = post.headers['x-bokydo-signature']!;
    const expected = createHmac('sha256', hook.secret).update(`${ts}.${post.body}`).digest('hex');
    expect(sig).toBe(`sha256=${expected}`);

    const payload = JSON.parse(post.body) as WebhookDeliveryPayload;
    expect(payload.event).toBe('task_added');
    expect(payload.taskId).toBe(taskId);
    expect(payload.data).toMatchObject({ title: 'Ship it' });
    expect(payload.project?.name).toBe('Webhook project');

    const [row] = await t.db.db.select().from(webhookDeliveries);
    expect(row?.status).toBe('delivered');
    expect(row?.attempts).toBe(0);
    // The sent body is exactly the frozen payload.
    expect(JSON.stringify(row?.payload)).toBe(post.body);
  });

  it('respects the per-subscription event filter', async () => {
    await createWebhook(aliceHttp, { url: URL_OK, events: ['task_completed'] });
    const { posts, fetch } = captureWebhook();
    t.app.services.webhooks.fetch = fetch;
    const projectId = id();
    await alice.ok(
      cmd('project_add', { id: projectId, name: 'Filter project' }),
      cmd('task_add', { id: id(), projectId, content: 'One' }),
    );
    await runWebhooks();
    expect(posts).toHaveLength(0);

    const task = [...alice.tasks.values()][0]!;
    await alice.ok(cmd('task_complete', { id: task.id }));
    await runWebhooks();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.headers['x-bokydo-event']).toBe('task_completed');
  });

  it('delivers only to members who can currently see the project', async () => {
    const projectId = id();
    await alice.ok(cmd('project_add', { id: projectId, name: 'Shared' }));
    const bobWebhook = await createWebhook(bobHttp, { url: URL_OK, events: ['task_added'] });
    const { posts, fetch } = captureWebhook();
    t.app.services.webhooks.fetch = fetch;

    await grantProjectAccess(t.db.db, projectId, bob.userId, 'viewer');
    await alice.ok(cmd('task_add', { id: id(), projectId, content: 'Shared task' }));
    await runWebhooks();
    expect(posts).toHaveLength(1);

    // A queued delivery whose owner loses access before it is sent is dropped, and events
    // after the loss are never queued for them at all.
    const taskId = id();
    await alice.ok(cmd('task_add', { id: taskId, projectId, content: 'Second' }));
    await t.app.services.webhooks.enqueue(new Date()); // queue it…
    await revokeProjectAccess(t.db.db, projectId, bob.userId); // …then lose access
    await t.app.services.webhooks.dispatch(new Date());
    expect(posts).toHaveLength(1);
    const rows = await t.db.db.select().from(webhookDeliveries);
    const queued = rows.find((r) => r.payload.taskId === taskId);
    expect(queued?.status).toBe('dropped');

    // Later events in that project are not queued for Bob any more.
    await alice.ok(cmd('task_add', { id: id(), projectId, content: 'Third' }));
    await runWebhooks();
    expect(posts).toHaveLength(1);
    expect((await t.db.db.select().from(webhookDeliveries)).length).toBe(2);

    // Bob's subscription itself is untouched and still listed.
    const list = await bobHttp.get('/api/v1/webhooks');
    expect((list.json() as { webhooks: unknown[] }).webhooks).toHaveLength(1);
    expect(bobWebhook.id).toBeDefined();
  });

  it("never queues one project's events for members of another project in the same batch", async () => {
    const shared = id();
    const secret = id();
    await alice.ok(cmd('project_add', { id: shared, name: 'Shared' }));
    await alice.ok(cmd('project_add', { id: secret, name: 'Private' }));
    await grantProjectAccess(t.db.db, shared, bob.userId, 'viewer');
    await createWebhook(bobHttp, { url: URL_OK, events: ['task_added'] });
    const { posts, fetch } = captureWebhook();
    t.app.services.webhooks.fetch = fetch;
    // Both events land in one enqueue batch.
    await alice.ok(cmd('task_add', { id: id(), projectId: shared, content: 'Visible' }));
    await alice.ok(cmd('task_add', { id: id(), projectId: secret, content: 'Not for Bob' }));
    await runWebhooks();
    const rows = await t.db.db.select().from(webhookDeliveries);
    expect(rows.map((r) => r.payload.project?.id)).toEqual([shared]);
    expect(posts).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('Not for Bob');
  });

  it('retries with backoff, then dead-letters after the last attempt', async () => {
    await createWebhook(aliceHttp, { url: URL_OK, events: ['task_added'] });
    const { posts, fetch } = captureWebhook(500);
    t.app.services.webhooks.fetch = fetch;
    const projectId = id();
    await alice.ok(cmd('project_add', { id: projectId, name: 'Retry' }));
    await alice.ok(cmd('task_add', { id: id(), projectId, content: 'Retry me' }));

    let now = new Date();
    await runWebhooks(now);
    const row = async () => (await t.db.db.select().from(webhookDeliveries))[0]!;
    const first = await row();
    expect(first.attempts).toBe(1);
    expect(first.status).toBe('pending');
    expect(first.nextAttemptAt!.getTime()).toBeGreaterThan(now.getTime());
    expect(first.lastError).toBe('http_500');

    // Drive the schedule to exhaustion: each attempt is due at the previous nextAttemptAt.
    for (let attempt = 2; attempt <= 8; attempt++) {
      now = (await row()).nextAttemptAt!;
      await runWebhooks(now);
    }
    const dead = await row();
    expect(dead.status).toBe('failed');
    expect(dead.attempts).toBe(8);
    expect(posts.length).toBe(8);
  });

  it('delivers a signed test event on demand, rate limited', async () => {
    const hook = await createWebhook(aliceHttp, { url: URL_OK, events: ['task_added'] });
    const { posts, fetch } = captureWebhook();
    t.app.services.webhooks.fetch = fetch;

    const res = await aliceHttp.post(`/api/v1/webhooks/${hook.id}/test`);
    expect(res.statusCode).toBe(202);
    await runWebhooks();
    expect(posts).toHaveLength(1);
    const payload = JSON.parse(posts[0]!.body) as WebhookDeliveryPayload;
    expect(payload.event).toBe('test');
    expect(payload.project).toBeNull();

    const foreign = await bobHttp.post(`/api/v1/webhooks/${hook.id}/test`);
    expect(foreign.statusCode).toBe(404);
  });

  it('skips delivery entirely while the admin switch is off', async () => {
    const hook = await createWebhook(aliceHttp, { url: URL_OK, events: ['task_added'] });
    const { posts, fetch } = captureWebhook();
    t.app.services.webhooks.fetch = fetch;
    await t.app.services.settings.update(
      { 'api.webhooksEnabled': false },
      { userId: null, ip: null },
    );
    const projectId = id();
    await alice.ok(cmd('project_add', { id: projectId, name: 'Off' }));
    await alice.ok(cmd('task_add', { id: id(), projectId, content: 'While off' }));

    // Events during the outage are skipped, not queued for later.
    await runWebhooks();
    expect(posts).toHaveLength(0);
    expect((await t.db.db.select().from(webhookDeliveries)).length).toBe(0);

    const res = await aliceHttp.post(`/api/v1/webhooks/${hook.id}/test`);
    expect(res.statusCode).toBe(409);
    await runWebhooks();
    expect(posts).toHaveLength(0);
    expect(hook.id).toBeDefined();
  });

  it('never delivers events that predate the subscription', async () => {
    // The enqueue job can lag behind a write: activity first, subscription second, then one
    // enqueue pass. The subscription must not hear about the earlier event.
    const projectId = id();
    await alice.ok(cmd('project_add', { id: projectId, name: 'History' }));
    await alice.ok(cmd('task_add', { id: id(), projectId, content: 'Before' }));
    await createWebhook(aliceHttp, { url: URL_OK, events: ['task_added'] });
    const { posts, fetch } = captureWebhook();
    t.app.services.webhooks.fetch = fetch;
    await runWebhooks();
    expect(posts).toHaveLength(0);
    expect((await t.db.db.select().from(webhookDeliveries)).length).toBe(0);

    // …but the next event, after the subscription existed, is delivered.
    await alice.ok(cmd('task_add', { id: id(), projectId, content: 'After' }));
    await runWebhooks();
    expect(posts).toHaveLength(1);
    expect((JSON.parse(posts[0]!.body) as WebhookDeliveryPayload).data).toMatchObject({
      title: 'After',
    });
  });
});
