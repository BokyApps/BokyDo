import type { Due } from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLog, calendarFeeds, users } from '../db/schema.js';
import { REQUEST_LOG_OPTIONS, redactUrl } from '../http/log-redaction.js';
import { grantProjectAccess, revokeProjectAccess } from '../sync/membership.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { cmd, id, SyncUser } from '../test/sync.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
const due = (date: string, time: string | null = null, extra: Partial<Due> = {}): Due => ({
  date,
  time,
  timezone: null,
  string: date,
  recurrence: null,
  ...extra,
});

let t: TestApp;
let alice: SyncUser;
let bob: SyncUser;
let aliceHttp: Client;
let bobHttp: Client;
let anon: Client;
const logLines: string[] = [];

beforeEach(async () => {
  logLines.length = 0;
  t = await testApp({
    logger: {
      level: 'info',
      stream: new Writable({
        write(chunk, _enc, done) {
          logLines.push(String(chunk));
          done();
        },
      }),
      ...REQUEST_LOG_OPTIONS,
    },
  });
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
  anon = new Client(t.app);
  await aliceHttp.login('alice', PASSWORD);
  await bobHttp.login('bob', PASSWORD);
});
afterEach(async () => t.close());

async function createFeed(
  client: Client,
  body: Record<string, unknown>,
): Promise<{ id: string; url: string }> {
  const res = await client.post('/api/v1/calendar-feeds', body);
  expect(res.statusCode, res.body).toBe(201);
  return res.json();
}
/** The calendar a feed URL serves, as unfolded lines. */
async function fetchLines(url: string): Promise<string[]> {
  const res = await anon.get(url);
  expect(res.statusCode, res.body).toBe(200);
  return res.body.replaceAll('\r\n ', '').split('\r\n').filter(Boolean);
}
const eventCount = (lines: string[]) => lines.filter((l) => l === 'BEGIN:VEVENT').length;
const summaries = (lines: string[]) =>
  lines.filter((l) => l.startsWith('SUMMARY:')).map((l) => l.slice(8));

describe.skipIf(!TEST_DATABASE_URL)('calendar feeds: managing', () => {
  it('returns the link once, stores only a hash, and lists feeds without it', async () => {
    const feed = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    expect(feed.url).toMatch(/^\/api\/v1\/calendar\/[A-Za-z0-9_-]{43}\.ics$/);
    const token = feed.url.slice('/api/v1/calendar/'.length, -'.ics'.length);

    const rows = await t.db.db.select().from(calendarFeeds);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.tokenId).not.toBe(token);

    const list = (await aliceHttp.get('/api/v1/calendar-feeds')).json();
    expect(list.feeds).toEqual([
      expect.objectContaining({
        id: feed.id,
        kind: 'project',
        targetId: alice.inbox,
        targetName: 'Inbox',
        showDescriptions: false,
        lastUsedAt: null,
      }),
    ]);
    expect(JSON.stringify(list)).not.toContain(token);
  });

  it('mints a fresh 256-bit token every time', async () => {
    const urls = new Set<string>();
    for (let i = 0; i < 5; i++)
      urls.add((await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox })).url);
    expect(urls.size).toBe(5);
  });

  it('only offers projects the user can see and filters they own', async () => {
    const secret = id();
    await bob.ok(cmd('project_add', { id: secret, name: 'Bob only' }));
    const filter = id();
    await bob.ok(cmd('filter_add', { id: filter, name: 'Bob filter', query: 'p1' }));

    const project = await aliceHttp.post('/api/v1/calendar-feeds', {
      kind: 'project',
      targetId: secret,
    });
    expect(project.statusCode).toBe(404);
    const theirFilter = await aliceHttp.post('/api/v1/calendar-feeds', {
      kind: 'filter',
      targetId: filter,
    });
    expect(theirFilter.statusCode).toBe(404);
    expect(project.body).toBe(theirFilter.body);
    expect(await t.db.db.select().from(calendarFeeds)).toHaveLength(0);
  });

  it('rejects malformed requests and unknown fields', async () => {
    for (const body of [
      {},
      { kind: 'project' },
      { kind: 'other', targetId: alice.inbox },
      { kind: 'project', targetId: 'nope' },
      { kind: 'project', targetId: alice.inbox, extra: 1 },
      { kind: 'project', targetId: alice.inbox, showDescriptions: 'yes' },
    ])
      expect((await aliceHttp.post('/api/v1/calendar-feeds', body)).statusCode).toBe(400);
  });

  it('caps the number of feeds per user', async () => {
    for (let i = 0; i < 25; i++)
      await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    const res = await aliceHttp.post('/api/v1/calendar-feeds', {
      kind: 'project',
      targetId: alice.inbox,
    });
    expect(res.statusCode).toBe(429);
  });

  it('revoking a feed kills its link at once, and only the owner can revoke', async () => {
    const feed = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    expect((await bobHttp.delete(`/api/v1/calendar-feeds/${feed.id}`)).statusCode).toBe(404);
    expect((await anon.get(feed.url)).statusCode).toBe(200);

    expect((await aliceHttp.delete(`/api/v1/calendar-feeds/${feed.id}`)).statusCode).toBe(204);
    const gone = await anon.get(feed.url);
    expect(gone.statusCode).toBe(404);
    expect(gone.json()).toEqual({ error: 'not_found' });
    expect((await aliceHttp.delete(`/api/v1/calendar-feeds/${feed.id}`)).statusCode).toBe(404);
  });

  it('rotating gives a new link and retires the old one; only the owner can rotate', async () => {
    const feed = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    expect((await bobHttp.post(`/api/v1/calendar-feeds/${feed.id}/rotate`, {})).statusCode).toBe(
      404,
    );
    expect((await anon.get(feed.url)).statusCode).toBe(200);

    const res = await aliceHttp.post(`/api/v1/calendar-feeds/${feed.id}/rotate`, {});
    expect(res.statusCode).toBe(200);
    const next = res.json();
    expect(next.id).toBe(feed.id);
    expect(next.url).not.toBe(feed.url);
    expect((await anon.get(feed.url)).statusCode).toBe(404);
    expect((await anon.get(next.url)).statusCode).toBe(200);
  });

  it('audits creating, rotating and revoking without recording the link', async () => {
    const feed = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    const rotated = (await aliceHttp.post(`/api/v1/calendar-feeds/${feed.id}/rotate`, {})).json();
    await aliceHttp.delete(`/api/v1/calendar-feeds/${feed.id}`);
    const rows = await t.db.db.select().from(auditLog);
    const actions = rows.map((r) => r.action).filter((a) => a.startsWith('calendar_feed.'));
    expect(actions.sort()).toEqual([
      'calendar_feed.created',
      'calendar_feed.revoked',
      'calendar_feed.rotated',
    ]);
    for (const url of [feed.url, rotated.url]) {
      const token = url.slice('/api/v1/calendar/'.length, -'.ics'.length);
      expect(JSON.stringify(rows)).not.toContain(token);
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)('calendar feeds: the feed', () => {
  it('serves open tasks with a due date as a calendar, and nothing else', async () => {
    const [open, noDue, done, deleted, timed, zoned] = [id(), id(), id(), id(), id(), id()];
    await alice.ok(
      cmd('task_add', { id: open, content: 'Pay rent', due: due('2030-03-01') }),
      cmd('task_add', { id: noDue, content: 'Someday' }),
      cmd('task_add', { id: done, content: 'Done thing', due: due('2030-03-02') }),
      cmd('task_complete', { id: done }),
      cmd('task_add', { id: deleted, content: 'Deleted thing', due: due('2030-03-03') }),
      cmd('task_delete', { id: deleted }),
      cmd('task_add', {
        id: timed,
        content: 'Standup',
        due: due('2030-03-04', '09:30'),
        durationMinutes: 15,
        priority: 1,
        labels: ['work'],
      }),
      cmd('task_add', {
        id: zoned,
        content: 'Call Berlin',
        due: due('2030-03-05', '10:00', { timezone: 'Europe/Berlin' }),
      }),
    );
    const feed = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    const res = await anon.get(feed.url);
    expect(res.headers['content-type']).toBe('text/calendar; charset=utf-8');
    expect(res.headers['cache-control']).toBe('no-store');
    const lines = res.body.replaceAll('\r\n ', '').split('\r\n').filter(Boolean);
    expect(summaries(lines).sort()).toEqual(['Call Berlin', 'Pay rent', 'Standup']);
    expect(lines).toContain('X-WR-CALNAME:Inbox');
    expect(lines).toContain('DTSTART;VALUE=DATE:20300301');
    expect(lines).toContain('DTSTART:20300304T093000');
    expect(lines).toContain('DTEND:20300304T094500');
    expect(lines).toContain('PRIORITY:1');
    expect(lines).toContain('CATEGORIES:work');
    expect(lines).toContain('DTSTART:20300305T090000Z');
    expect(lines).toContain(`UID:${open}@bokydo`);
  });

  it('writes schedule-anchored repeats as rules and completion-anchored ones as one event', async () => {
    const [weekly, afterDone] = [id(), id()];
    await alice.ok(
      cmd('task_add', {
        id: weekly,
        content: 'Water plants',
        due: due('2030-03-04', null, {
          recurrence: { rrule: 'FREQ=WEEKLY;BYDAY=MO', anchor: 'scheduled' },
        }),
      }),
      cmd('task_add', {
        id: afterDone,
        content: 'Haircut',
        due: due('2030-03-06', null, {
          recurrence: { rrule: 'FREQ=MONTHLY', anchor: 'completion' },
        }),
      }),
    );
    const lines = await fetchLines(
      (await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox })).url,
    );
    expect(lines.filter((l) => l.startsWith('RRULE:'))).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    expect(eventCount(lines)).toBe(2);
  });

  it('keeps descriptions out unless the feed was created with them', async () => {
    await alice.ok(
      cmd('task_add', {
        id: id(),
        content: 'Review contract',
        description: 'Clause 4 is the problem',
        due: due('2030-03-01'),
      }),
    );
    const plain = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    const detailed = await createFeed(aliceHttp, {
      kind: 'project',
      targetId: alice.inbox,
      showDescriptions: true,
    });
    expect((await fetchLines(plain.url)).join('\n')).not.toContain('Clause 4');
    expect((await fetchLines(detailed.url)).join('\n')).toContain('Clause 4 is the problem');
  });

  it('cannot be turned into extra calendar structure by task text', async () => {
    // Titles are single-line by validation; descriptions can hold hostile line breaks.
    const evil =
      'Hi\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:pwned\r\nATTENDEE:mailto:x@example.com';
    await alice.ok(
      cmd('task_add', {
        id: id(),
        content: 'Hi; END:VEVENT, \\ done',
        description: evil,
        labels: ['ok'],
        due: due('2030-03-01'),
      }),
    );
    const feed = await createFeed(aliceHttp, {
      kind: 'project',
      targetId: alice.inbox,
      showDescriptions: true,
    });
    const res = await anon.get(feed.url);
    expect(res.body.replaceAll('\r\n', '')).not.toMatch(/[\r\n]/);
    const lines = res.body.replaceAll('\r\n ', '').split('\r\n').filter(Boolean);
    expect(eventCount(lines)).toBe(1);
    expect(lines.some((l) => l.startsWith('ATTENDEE') || l === 'SUMMARY:pwned')).toBe(false);
  });

  it('runs a saved filter as its owner, over what the owner can see', async () => {
    const [mine, theirs, lowPriority] = [id(), id(), id()];
    const filter = id();
    const shared = id();
    await bob.ok(
      cmd('project_add', { id: shared, name: 'Shared' }),
      cmd('task_add', {
        id: theirs,
        projectId: shared,
        content: 'Shared urgent',
        priority: 1,
        due: due('2030-04-02'),
      }),
      cmd('task_add', {
        id: id(),
        content: 'Bob private urgent',
        priority: 1,
        due: due('2030-04-03'),
      }),
    );
    await grantProjectAccess(t.db.db, shared, alice.userId, 'viewer');
    await alice.ok(
      cmd('task_add', { id: mine, content: 'My urgent', priority: 1, due: due('2030-04-01') }),
      cmd('task_add', { id: lowPriority, content: 'Low', due: due('2030-04-04') }),
      cmd('filter_add', { id: filter, name: 'Urgent', query: 'p1' }),
    );
    const feed = await createFeed(aliceHttp, { kind: 'filter', targetId: filter });
    const lines = await fetchLines(feed.url);
    expect(lines).toContain('X-WR-CALNAME:Urgent');
    expect(summaries(lines).sort()).toEqual(['My urgent', 'Shared urgent']);
    expect(lines.join('\n')).toContain('Project: Shared');
    expect(lines.join('\n')).not.toContain('Bob private');
  });

  it('stops serving when its owner loses access to the project', async () => {
    const shared = id();
    await alice.ok(
      cmd('project_add', { id: shared, name: 'Team' }),
      cmd('task_add', {
        id: id(),
        projectId: shared,
        content: 'Team task',
        due: due('2030-05-01'),
      }),
    );
    await grantProjectAccess(t.db.db, shared, bob.userId, 'viewer');
    const feed = await createFeed(bobHttp, { kind: 'project', targetId: shared });
    expect(summaries(await fetchLines(feed.url))).toEqual(['Team task']);

    await revokeProjectAccess(t.db.db, shared, bob.userId);
    expect((await anon.get(feed.url)).statusCode).toBe(404);
    // The owner's list no longer names the project either.
    const listed = (await bobHttp.get('/api/v1/calendar-feeds')).json().feeds[0];
    expect(listed.targetName).toBeNull();
  });

  it('stops serving when the owner is disabled, or the project or filter is deleted', async () => {
    const project = id();
    const filter = id();
    await alice.ok(
      cmd('project_add', { id: project, name: 'Temp' }),
      cmd('filter_add', { id: filter, name: 'F', query: 'p1' }),
    );
    const projectFeed = await createFeed(aliceHttp, { kind: 'project', targetId: project });
    const filterFeed = await createFeed(aliceHttp, { kind: 'filter', targetId: filter });
    const inboxFeed = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    for (const f of [projectFeed, filterFeed, inboxFeed])
      expect((await anon.get(f.url)).statusCode).toBe(200);

    await alice.ok(cmd('project_delete', { id: project }), cmd('filter_delete', { id: filter }));
    expect((await anon.get(projectFeed.url)).statusCode).toBe(404);
    expect((await anon.get(filterFeed.url)).statusCode).toBe(404);

    await t.db.db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, alice.userId));
    expect((await anon.get(inboxFeed.url)).statusCode).toBe(404);
  });

  it('serves an empty calendar for an archived project', async () => {
    const project = id();
    await alice.ok(
      cmd('project_add', { id: project, name: 'Old' }),
      cmd('task_add', {
        id: id(),
        projectId: project,
        content: 'Old task',
        due: due('2030-06-01'),
      }),
    );
    const feed = await createFeed(aliceHttp, { kind: 'project', targetId: project });
    expect(eventCount(await fetchLines(feed.url))).toBe(1);
    await alice.ok(cmd('project_archive', { id: project }));
    expect(eventCount(await fetchLines(feed.url))).toBe(0);
  });

  it('records when a feed was last used', async () => {
    const feed = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    expect((await aliceHttp.get('/api/v1/calendar-feeds')).json().feeds[0].lastUsedAt).toBeNull();
    await anon.get(feed.url);
    expect(
      (await aliceHttp.get('/api/v1/calendar-feeds')).json().feeds[0].lastUsedAt,
    ).not.toBeNull();
  });
});

describe.skipIf(!TEST_DATABASE_URL)('calendar feeds: abuse', () => {
  it('answers every kind of wrong link the same way', async () => {
    const feed = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    const token = feed.url.slice('/api/v1/calendar/'.length, -'.ics'.length);
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    const attempts = [
      `/api/v1/calendar/${flipped}.ics`,
      `/api/v1/calendar/${token}`, // missing .ics
      `/api/v1/calendar/${token}.ICS`,
      `/api/v1/calendar/${token.slice(1)}.ics`,
      `/api/v1/calendar/${token}x.ics`,
      '/api/v1/calendar/not-a-token.ics',
      `/api/v1/calendar/..%2F${token}.ics`,
    ];
    const bodies = new Set<string>();
    for (const url of attempts) {
      const res = await anon.get(url);
      expect(res.statusCode, url).toBe(404);
      bodies.add(res.body);
    }
    expect([...bodies]).toEqual(['{"error":"not_found"}']);
  });

  it('does not accept a feed link as a session or the other way round', async () => {
    const feed = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    const token = feed.url.slice('/api/v1/calendar/'.length, -'.ics'.length);
    const bearer = await anon.request({
      method: 'GET',
      url: '/api/v1/account/sessions',
      headers: { authorization: `Bearer ${token}`, cookie: `bokydo_session=${token}` },
    });
    expect(bearer.statusCode).toBe(401);
    // A session token is not a feed link either.
    const session = aliceHttp.cookies.get('bokydo_session') ?? '';
    expect((await anon.get(`/api/v1/calendar/${session}.ics`)).statusCode).toBe(404);
  });

  it('limits guessing per IP without ever limiting working links', async () => {
    const feed = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    const statuses = new Set<number>();
    for (let i = 0; i < 70; i++)
      statuses.add((await anon.get(`/api/v1/calendar/${'a'.repeat(43)}.ics`)).statusCode);
    expect(statuses).toEqual(new Set([404, 429]));
    const blocked = await anon.get(`/api/v1/calendar/${'b'.repeat(43)}.ics`);
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    // The same IP can still fetch a calendar it has the link for.
    expect((await anon.get(feed.url)).statusCode).toBe(200);
  });

  it('slows a client that polls far more often than any calendar app', async () => {
    const feed = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    let limited: number | null = null;
    for (let i = 1; i <= 130 && limited === null; i++) {
      const res = await anon.get(feed.url);
      if (res.statusCode === 429) limited = i;
    }
    expect(limited).toBe(121);
    // Other feeds are not affected.
    const other = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    expect((await anon.get(other.url)).statusCode).toBe(200);
  });

  it('never writes a feed link to the logs', async () => {
    const feed = await createFeed(aliceHttp, { kind: 'project', targetId: alice.inbox });
    const token = feed.url.slice('/api/v1/calendar/'.length, -'.ics'.length);
    await anon.get(feed.url);
    await anon.get(`${feed.url}?x=1`);
    await anon.get(`/api/v1/calendar/${'z'.repeat(43)}.ics`);
    const logs = logLines.join('');
    expect(logs).toContain('/api/v1/calendar/[redacted]');
    expect(logs).not.toContain(token);
    expect(logs).not.toContain('zzzzzzzzzz');
  });
});

describe('log redaction', () => {
  it('removes the secret from feed paths and leaves other URLs alone', () => {
    expect(redactUrl('/api/v1/calendar/abc.ics')).toBe('/api/v1/calendar/[redacted]');
    expect(redactUrl('/api/v1/calendar/abc.ics?x=1')).toBe('/api/v1/calendar/[redacted]?x=1');
    expect(redactUrl('/api/v1/calendar-feeds')).toBe('/api/v1/calendar-feeds');
    expect(redactUrl('/api/v1/tasks/completed?limit=3')).toBe('/api/v1/tasks/completed?limit=3');
  });
});
