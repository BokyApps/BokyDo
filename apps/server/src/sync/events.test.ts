import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { EventBus } from './events.js';
import { grantProjectAccess } from './membership.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
let t: TestApp;
let base: string;
let alice: SyncUser;
let bobClient: Client;
let carol: SyncUser;
let shared: string;

/** Open an SSE stream and collect what arrives. */
function openStream(cookie: string) {
  const received: string[] = [];
  let ended = false;
  const ready = new Promise<number>((resolve, reject) => {
    const req = http.get(`${base}/api/v1/sync/events`, { headers: { cookie } }, (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => received.push(chunk));
      res.on('end', () => (ended = true));
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    streams.push(req);
  });
  return {
    ready,
    text: () => received.join(''),
    get ended() {
      return ended;
    },
  };
}
const streams: http.ClientRequest[] = [];
const waitFor = async (cond: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 20));
  }
  return true;
};
const cookieOf = (c: Client) => [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');

beforeEach(async () => {
  t = await testApp();
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  const aliceId = await createUser(t.db, { username: 'alice', password: PASSWORD });
  const bobId = await createUser(t.db, { username: 'bob', password: PASSWORD });
  const carolId = await createUser(t.db, { username: 'carol', password: PASSWORD });
  alice = new SyncUser(t.app.services.sync, aliceId);
  carol = new SyncUser(t.app.services.sync, carolId);
  await alice.run();
  await carol.run();
  shared = id();
  await alice.ok(cmd('project_add', { id: shared, name: 'Shared' }));
  await grantProjectAccess(t.db.db, shared, bobId, 'editor');
  await t.app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  bobClient = new Client(t.app);
  await bobClient.login('bob', PASSWORD);
});
afterEach(async () => {
  for (const s of streams.splice(0)) s.destroy();
  await t.close();
});

describe.skipIf(!TEST_DATABASE_URL)('sync events (SSE)', () => {
  it('refuses anonymous streams', async () => {
    expect(await openStream('').ready).toBe(401);
  });

  it('pokes members of a changed project, and only them', async () => {
    const bob = openStream(cookieOf(bobClient));
    expect(await bob.ready).toBe(200);
    expect(await waitFor(() => bob.text().includes(': connected'))).toBe(true);

    await carol.ok(cmd('task_add', { id: id(), content: 'unrelated' }));
    expect(await waitFor(() => bob.text().includes('event: poke'), 300)).toBe(false);

    await alice.ok(cmd('task_add', { id: id(), projectId: shared, content: 'for bob' }));
    expect(await waitFor(() => bob.text().includes('event: poke'))).toBe(true);
    // A poke never carries data.
    expect(bob.text()).not.toContain('for bob');
  });

  it('ends the stream when the session logs out', async () => {
    const bob = openStream(cookieOf(bobClient));
    await bob.ready;
    await bobClient.post('/api/v1/auth/logout');
    expect(await waitFor(() => bob.ended)).toBe(true);
  });

  it('caps concurrent streams per user', async () => {
    const opened = Array.from({ length: EventBus.MAX_STREAMS_PER_USER }, () =>
      openStream(cookieOf(bobClient)),
    );
    expect(await Promise.all(opened.map((s) => s.ready))).toEqual(
      Array(EventBus.MAX_STREAMS_PER_USER).fill(200),
    );
    expect(await openStream(cookieOf(bobClient)).ready).toBe(429);
  });
});

describe.skipIf(!TEST_DATABASE_URL)('sync over HTTP', () => {
  it('syncs with CSRF protection and validates the envelope', async () => {
    const ok = await bobClient.post('/api/v1/sync', { cursor: null, commands: [] });
    expect(ok.statusCode).toBe(200);
    expect(
      ok
        .json()
        .projects.map((p: { name: string }) => p.name)
        .sort(),
    ).toEqual(['Inbox', 'Shared']);

    const tooMany = Array.from({ length: 101 }, () => cmd('task_add', { id: id(), content: 'x' }));
    for (const body of [
      { commands: tooMany },
      { commands: [{ type: 'user_delete', uuid: id(), args: {} }] },
      { commands: [{ type: 'task_add', uuid: 'not-a-uuid', args: {} }] },
      { cursor: '-1' },
      { cursor: '1e9' },
      { extra: true },
    ]) {
      expect(
        (await bobClient.post('/api/v1/sync', body)).statusCode,
        JSON.stringify(body).slice(0, 60),
      ).toBe(400);
    }
    expect((await bobClient.post('/api/v1/sync', {}, { csrf: false })).json()).toEqual({
      error: 'csrf_failed',
    });
  });
});
