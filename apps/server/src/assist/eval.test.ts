import type { EvalResponse } from '@bokydo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { fakeModel } from '../test/model.js';
import { cmd, id, SyncUser } from '../test/sync.js';

let t: TestApp;
let model: ReturnType<typeof fakeModel>;

describe.skipIf(!TEST_DATABASE_URL)('Eval harness', () => {
  let http: Client;

  beforeEach(async () => {
    model = fakeModel();
    t = await testApp({ aiUserFetch: model.fetch });
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    const userId = await createUser(t.db, { username: 'alice', password: 'x'.repeat(12) });
    http = new Client(t.app);
    const { token, session } = await t.app.services.sessions.create(
      { id: userId, username: 'alice', isAdmin: false, mustChangePassword: false },
      { ip: null, userAgent: null, authMethod: 'password' },
    );
    http.cookies.set('bokydo_session', token);
    http.csrfToken = session.csrfToken;
    // Alice's own data must never reach an eval prompt.
    await new SyncUser(t.app.services.sync, userId).ok(
      cmd('project_add', { id: id(), name: 'Secret client' }),
    );
    const cred = (
      await http.post('/api/v1/ai/credentials', {
        provider: 'openai',
        label: 'mine',
        apiKey: 'sk-test-0123456789',
      })
    ).json() as { id: string };
    await http.put('/api/v1/ai/routing', {
      'assist.filter': { credentialId: cred.id, model: 'small' },
    });
  });
  afterEach(async () => t.close());

  const answer = (query: string) => JSON.stringify({ query, explanation: 'x' });

  it('scores the routed model on synthetic cases only', async () => {
    model.replies.push(
      answer('today | overdue'),
      answer('#Work & p1'),
      answer('@phone & no date'),
      answer('#Lisbon trip & assigned to: ana'),
    );
    const res = await http.post('/api/v1/assist/eval', { feature: 'assist.filter' });
    expect(res.statusCode).toBe(200);
    const out = res.json() as EvalResponse;
    expect(out).toMatchObject({ feature: 'assist.filter', passed: 4, total: 4 });
    expect(model.seen).toHaveLength(4);
    for (const sent of model.seen) {
      expect(sent.user).toContain('Lisbon trip');
      expect(sent.user).not.toContain('Secret client');
    }
  });

  it('reports what a weak model got wrong, case by case', async () => {
    model.replies.push(
      answer('today'), // misses overdue
      answer('(('),
      answer('(('), // invalid twice: no valid answer
      answer('@phone & no date'),
      answer('#Lisbon trip'),
    );
    const out = (await http.post('/api/v1/assist/eval', { feature: 'assist.filter' })).json()
      .cases as EvalResponse['cases'];
    expect(out.map((c) => [c.passed, c.detail])).toEqual([
      [false, '“today” lacks overdue, |'],
      [false, 'no valid answer after a correction'],
      [true, null],
      [false, '“#Lisbon trip” lacks assigned to: ana'],
    ]);
  });

  it('needs a routed model, a session, and a known feature', async () => {
    const res = await http.post('/api/v1/assist/eval', { feature: 'assist.task' });
    expect(res.statusCode).toBe(409);
    expect(model.seen).toHaveLength(0);
    expect((await http.post('/api/v1/assist/eval', { feature: 'reports' })).statusCode).toBe(400);
  });
});
