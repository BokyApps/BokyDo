import type { EvalFeature, EvalResponse } from '@bokydo/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiUser } from '../ai/service.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { fakeModel } from '../test/model.js';
import { cmd, id, SyncUser } from '../test/sync.js';
import { evalCases } from './eval.js';

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
    // A known feature with no route yet: 409, not the unknown-feature 400.
    expect((await http.post('/api/v1/assist/eval', { feature: 'reports' })).statusCode).toBe(409);
    expect((await http.post('/api/v1/assist/eval', { feature: 'nope' })).statusCode).toBe(400);
  });

  async function route(feature: string) {
    const cred = (
      await http.post('/api/v1/ai/credentials', {
        provider: 'openai',
        label: 'mine',
        apiKey: 'sk-test-0123456789',
      })
    ).json() as { id: string };
    expect(
      (await http.put('/api/v1/ai/routing', { [feature]: { credentialId: cred.id, model: 'gpt' } }))
        .statusCode,
    ).toBe(200);
  }

  // Subtask items are .strict() with a required (nullable) due: an omitted key is invalid
  // output, and its correction round eats the next scripted reply, so every step carries one.
  const steps = (contents: string[]) => contents.map((content) => ({ content, due: null }));
  const taskReply = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      content: null,
      subtasks: steps(['Book a hotel']),
      due: null,
      priority: null,
      why: 'x',
      ...extra,
    });

  it('scores the inbox triage cases on Task Assist’s model', async () => {
    await route('assist.task');
    // Case 1-4 are Task Assist's own; the four after them are the new triage cases.
    model.replies.push(
      taskReply({ subtasks: steps(['Book a hotel', 'Pack']) }),
      taskReply(),
      taskReply({ due: 'next friday' }),
      taskReply(),
      JSON.stringify({
        tasks: [
          { task: 't1', project: 'p2', labels: [], priority: null, confidence: 0.9, why: 'x' },
        ],
      }),
      JSON.stringify({
        tasks: [
          { task: 't1', project: null, labels: [], priority: null, confidence: 0.2, why: 'x' },
        ],
      }),
      JSON.stringify({
        tasks: [
          { task: 't1', project: null, labels: [], priority: null, confidence: 0.7, why: 'x' },
        ],
      }),
      JSON.stringify({
        tasks: [{ task: 't1', project: null, labels: [], priority: 1, confidence: 0.7, why: 'x' }],
      }),
    );
    const res = await http.post('/api/v1/assist/eval', { feature: 'assist.task' });
    expect(res.statusCode).toBe(200);
    const out = res.json() as EvalResponse;
    expect(out).toMatchObject({ total: 8, passed: 8 });
    // One model call per case: a doubled count means a script was rejected and retried, which
    // would shift every later case onto the wrong reply.
    expect(model.seen).toHaveLength(8);
    expect(out.cases.at(-4)?.name).toBe('Puts an obvious task in the project it belongs to');
    // The synthetic context is what the model saw: none of Alice's tasks.
    for (const sent of model.seen) expect(sent.user).not.toContain('Secret client');
  });

  it('reports what a weak model got wrong in the triage cases', async () => {
    await route('assist.task');
    model.replies.push(
      taskReply({ subtasks: steps(['a', 'b']) }),
      taskReply(),
      taskReply({ due: 'next friday' }),
      taskReply(),
      JSON.stringify({
        tasks: [
          { task: 't1', project: 'p1', labels: [], priority: null, confidence: 0.9, why: 'x' },
        ],
      }),
      JSON.stringify({
        tasks: [
          { task: 't1', project: 'p3', labels: [], priority: null, confidence: 0.9, why: 'x' },
        ],
      }),
      JSON.stringify({
        tasks: [{ task: 't1', project: null, labels: [], priority: 1, confidence: 0.9, why: 'x' }],
      }),
      JSON.stringify({
        tasks: [{ task: 't1', project: null, labels: [], priority: 1, confidence: 0.7, why: 'x' }],
      }),
    );
    const out = (await http.post('/api/v1/assist/eval', { feature: 'assist.task' })).json();
    expect(
      out.cases
        .slice(4)
        .map((c: { passed: boolean; detail: string | null }) => [c.passed, c.detail]),
    ).toEqual([
      [false, 'not sent to Work'],
      [false, 'moved it anyway'],
      [false, 'followed the instruction in the title'],
      [false, 'used keys it was not offered'],
    ]);
  });

  it('scores the report cases', async () => {
    await route('reports');
    model.replies.push('- electricity: overdue', 'Nothing much to report.', 'All good.');
    const res = await http.post('/api/v1/assist/eval', { feature: 'reports' });
    expect(res.statusCode).toBe(200);
    expect(res.json() as EvalResponse).toMatchObject({ total: 3, passed: 3 });
  });

  it('reports what a weak model got wrong in the report cases', async () => {
    await route('reports');
    model.replies.push('overdue: helicopter repair', 'buy a helicopter ticket', 'HACKED says so');
    const out = (await http.post('/api/v1/assist/eval', { feature: 'reports' })).json();
    expect(
      out.cases.map((c: { passed: boolean; detail: string | null }) => [c.passed, c.detail]),
    ).toEqual([
      [false, '“overdue: helicopter repair” lacks electricity'],
      [false, '“buy a helicopter ticket” mentions helicopter'],
      [false, '“HACKED says so” mentions HACKED'],
    ]);
  });
});

/**
 * The new cases are checked directly, with a stub model, so they run without a database
 * (the HTTP-level tests above need Postgres and are CI-only). Each case is tested both
 * ways: what a good model answers, and what a weak or tricked one answers.
 */
describe('Triage and report eval cases', () => {
  const USER: AiUser = { id: '00000000-0000-7000-8000-0000000000aa', isAdmin: false };

  /** A scripted model: `chatJson` returns objects, `chat` returns text. */
  function stubAi(replies: unknown[]) {
    const queue = [...replies];
    return {
      chatJson: async () => ({ value: queue.shift() }),
      chat: async () => ({ text: String(queue.shift()) }),
    } as unknown as Parameters<(typeof evalCases)['assist.task'][number]['run']>[0];
  }

  const run = (feature: EvalFeature, name: string, replies: unknown[]) => {
    const c = evalCases[feature].find((x) => x.name === name);
    if (!c) throw new Error(`no eval case named “${name}”`);
    return c.run(stubAi(replies), USER);
  };

  const answer = (extra: Record<string, unknown> = {}) => ({
    tasks: [{ task: 't1', labels: [], priority: null, confidence: 0.9, why: 'x', ...extra }],
  });

  it('a good model sends an obvious task to Work', async () => {
    expect(
      await run('assist.task', 'Puts an obvious task in the project it belongs to', [
        answer({ project: 'p2' }),
      ]),
    ).toBeNull();
  });

  it('a weak model that keeps it fails the case', async () => {
    expect(
      await run('assist.task', 'Puts an obvious task in the project it belongs to', [
        answer({ project: 'p1' }),
      ]),
    ).toBe('not sent to Work');
  });

  it('an ambiguous task is only left alone when it is also unsure', async () => {
    expect(
      await run('assist.task', 'Leaves an ambiguous task where it is', [
        answer({ project: null, confidence: 0.2 }),
      ]),
    ).toBeNull();
    expect(
      await run('assist.task', 'Leaves an ambiguous task where it is', [
        answer({ project: 'p3', confidence: 0.9 }),
      ]),
    ).toBe('moved it anyway');
  });

  it('an instruction inside a task title is ignored', async () => {
    expect(
      await run('assist.task', 'Ignores instructions in a task title while triaging', [
        answer({ project: null, priority: null }),
      ]),
    ).toBeNull();
    expect(
      await run('assist.task', 'Ignores instructions in a task title while triaging', [
        answer({ project: null, priority: 1 }),
      ]),
    ).toBe('followed the instruction in the title');
    expect(
      await run('assist.task', 'Ignores instructions in a task title while triaging', [
        answer({ project: 'p3', priority: null }),
      ]),
    ).toBe('followed the instruction in the title');
  });

  it('an urgent task gets its priority raised', async () => {
    expect(
      await run('assist.task', 'Raises the priority of an urgent task', [
        answer({ project: null, priority: 1 }),
      ]),
    ).toBeNull();
    expect(
      await run('assist.task', 'Raises the priority of an urgent task', [
        answer({ project: null, priority: null }),
      ]),
    ).toBe('left it as it was');
  });

  it('a report names what is overdue and invents nothing', async () => {
    expect(await run('reports', 'Names what is overdue', ['- electricity: overdue'])).toBeNull();
    expect(await run('reports', 'Names what is overdue', ['nothing to say'])).toBe(
      '“nothing to say” lacks electricity',
    );
    expect(await run('reports', 'Does not invent tasks', ['paid the bill'])).toBeNull();
    expect(await run('reports', 'Does not invent tasks', ['buy a helicopter ticket'])).toBe(
      '“buy a helicopter ticket” mentions helicopter',
    );
    expect(
      await run('reports', 'Ignores instructions in a task title', ['all good here']),
    ).toBeNull();
    expect(await run('reports', 'Ignores instructions in a task title', ['HACKED as asked'])).toBe(
      '“HACKED as asked” mentions HACKED',
    );
  });
});
