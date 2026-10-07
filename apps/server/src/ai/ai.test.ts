import { and, eq, sql } from 'drizzle-orm';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { aiCredentials, aiUsage, auditLog, users } from '../db/schema.js';
import { ensureAppSecrets } from '../security/app-secrets.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';
import { listModels } from './adapters.js';
import { AiCredentialStore } from './credentials.js';
import { AiNotConfiguredError, type AiUser } from './service.js';
import { AiBudgetExceededError, reserveUsage } from './usage.js';

const PASSWORD = 'violin-pancake-orbit-meadow';
// Looks like a real key so a leak would be obvious; not a credential for anything.
const KEY = 'sk-test-0123456789abcdefLEAKCANARY'; // gitleaks:allow
const OTHER_KEY = 'sk-ant-test-OTHERCANARY9876543210'; // gitleaks:allow

let t: TestApp;
let alice: { id: string; http: Client };
let bob: { id: string; http: Client };
let admin: { id: string; http: Client };
const responses: string[] = [];

const dns: Record<string, string[]> = {
  'internal.example': ['10.0.0.5'],
  'metadata.example': ['169.254.169.254'],
};

async function person(name: string, isAdmin = false) {
  const id = await createUser(t.db, { username: name, password: PASSWORD, isAdmin });
  const client = new Client(t.app);
  await client.login(name, PASSWORD);
  // Record every response body so the test can prove no key ever leaves the server.
  const request = client.request.bind(client);
  client.request = async (opts) => {
    const res = await request(opts);
    responses.push(res.body);
    return res;
  };
  return { id, http: client };
}

const settings = (patch: Parameters<TestApp['app']['services']['settings']['update']>[0]) =>
  t.app.services.settings.update(patch, { userId: null, ip: null });

const userOf = (p: { id: string }, isAdmin = false): AiUser => ({ id: p.id, isAdmin });

async function setup() {
  responses.length = 0;
  t = await testApp({
    resolver: async (host) => {
      const found = dns[host];
      if (!found) throw new Error('ENOTFOUND');
      return found.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    },
  });
  await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
  alice = await person('alice');
  bob = await person('bob');
  admin = await person('root', true);
}
async function teardown() {
  for (const body of responses) {
    expect(body).not.toContain('CANARY');
  }
  await t.close();
}

describe.skipIf(!TEST_DATABASE_URL)('AI credentials', () => {
  beforeEach(setup);
  afterEach(teardown);

  it('stores keys encrypted, write-only and per owner', async () => {
    const res = await alice.http.post('/api/v1/ai/credentials', {
      provider: 'openai',
      label: 'Mine',
      apiKey: KEY,
    });
    expect(res.statusCode).toBe(201);
    const cred = res.json();
    expect(cred).toMatchObject({ scope: 'user', provider: 'openai', hasKey: true, baseUrl: null });
    expect(JSON.stringify(cred)).not.toContain(KEY);

    const [row] = await t.db.db.select().from(aiCredentials).where(eq(aiCredentials.id, cred.id));
    expect(JSON.stringify(row)).not.toContain('CANARY');
    const audits = await t.db.db.select().from(auditLog);
    expect(JSON.stringify(audits)).not.toContain('CANARY');

    expect((await alice.http.get('/api/v1/ai/credentials')).json().credentials).toHaveLength(1);
    // Other users, and admins, can't see or touch it.
    expect((await bob.http.get('/api/v1/ai/credentials')).json().credentials).toHaveLength(0);
    expect((await admin.http.get('/api/v1/ai/credentials')).json().credentials).toHaveLength(0);
    expect((await admin.http.get('/api/v1/admin/ai/credentials')).json().credentials).toHaveLength(
      0,
    );
    for (const client of [bob.http, admin.http]) {
      expect(
        (await client.patch(`/api/v1/ai/credentials/${cred.id}`, { label: 'x' })).statusCode,
      ).toBe(404);
      expect((await client.post(`/api/v1/ai/credentials/${cred.id}/test`)).statusCode).toBe(404);
      expect(
        (await client.request({ method: 'DELETE', url: `/api/v1/ai/credentials/${cred.id}` }))
          .statusCode,
      ).toBe(404);
    }
    // The admin scope only ever addresses instance credentials.
    expect(
      (await admin.http.patch(`/api/v1/admin/ai/credentials/${cred.id}`, { label: 'x' }))
        .statusCode,
    ).toBe(404);
    expect(
      (await alice.http.patch(`/api/v1/admin/ai/credentials/${cred.id}`, { label: 'x' }))
        .statusCode,
    ).toBe(403);

    // Rotating the key keeps it hidden; clearing it is reported.
    const rotated = await alice.http.patch(`/api/v1/ai/credentials/${cred.id}`, {
      apiKey: OTHER_KEY,
      label: 'Rotated',
    });
    expect(rotated.json()).toMatchObject({ label: 'Rotated', hasKey: true });
  });

  it('binds the encrypted key to its row and owner', async () => {
    const a = (
      await alice.http.post('/api/v1/ai/credentials', {
        provider: 'openai',
        label: 'A',
        apiKey: KEY,
      })
    ).json();
    const b = (
      await bob.http.post('/api/v1/ai/credentials', {
        provider: 'openai',
        label: 'B',
        apiKey: OTHER_KEY,
      })
    ).json();
    // Someone with database write access copies Alice's ciphertext into Bob's row.
    const [row] = await t.db.db.select().from(aiCredentials).where(eq(aiCredentials.id, a.id));
    await t.db.db
      .update(aiCredentials)
      .set({ secret: row!.secret })
      .where(eq(aiCredentials.id, b.id));
    const store = new AiCredentialStore(t.db.db, (await ensureAppSecrets(t.dataDir)).masterKey);
    expect((await store.usable(alice.id, a.id))?.apiKey).toBe(KEY);
    await expect(store.usable(bob.id, b.id)).rejects.toThrow();
    // …or hands Alice's credential row to Bob.
    await t.db.db
      .update(aiCredentials)
      .set({ ownerUserId: bob.id })
      .where(eq(aiCredentials.id, a.id));
    await expect(store.usable(bob.id, a.id)).rejects.toThrow();
  });

  it('keeps users on the public internet and admins off blocked ranges', async () => {
    const post = (client: Client, url: string, body: Record<string, unknown>) =>
      client.post(url, { label: 'L', ...body });
    const mine = '/api/v1/ai/credentials';
    const inst = '/api/v1/admin/ai/credentials';
    for (const baseUrl of [
      'http://api.example.com/v1',
      'https://127.0.0.1/v1',
      'https://localhost:11434/v1',
      'https://10.1.2.3/v1',
      'https://[fd00::1]/v1',
      'https://169.254.169.254/latest',
    ]) {
      const res = await post(alice.http, mine, { provider: 'ollama', baseUrl });
      expect(res.statusCode, baseUrl).toBe(400);
    }
    expect(
      (
        await post(alice.http, mine, {
          provider: 'openai',
          apiKey: KEY,
          baseUrl: 'https://evil.example/v1',
        })
      ).statusCode,
    ).toBe(400);
    expect((await post(alice.http, mine, { provider: 'openai' })).statusCode).toBe(400); // key required
    expect(
      (await post(alice.http, mine, { provider: 'openai', apiKey: KEY, headers: { 'x-a': '1' } }))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await post(alice.http, mine, {
          provider: 'openai-compatible',
          baseUrl: 'https://gw.example/v1',
          headers: { Host: 'x' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await post(alice.http, mine, { provider: 'openai', apiKey: 'sk bad\r\nx: y' })).statusCode,
    ).toBe(400);
    expect(
      (
        await post(alice.http, mine, {
          provider: 'ollama',
          baseUrl: 'https://ollama.example.com/v1',
        })
      ).statusCode,
    ).toBe(201);

    // Admins may point instance credentials at private networks, never at metadata/loopback.
    expect(
      (await post(admin.http, inst, { provider: 'ollama', baseUrl: 'http://ollama:11434/v1' }))
        .statusCode,
    ).toBe(201);
    expect(
      (await post(admin.http, inst, { provider: 'ollama', baseUrl: 'http://169.254.169.254/v1' }))
        .statusCode,
    ).toBe(400);
    expect(
      (await post(admin.http, inst, { provider: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1' }))
        .statusCode,
    ).toBe(400);
  });

  it('checks the resolved address on every connection', async () => {
    const userCred = (
      await alice.http.post('/api/v1/ai/credentials', {
        provider: 'openai-compatible',
        label: 'Sneaky',
        baseUrl: 'https://internal.example/v1',
      })
    ).json();
    expect((await alice.http.post(`/api/v1/ai/credentials/${userCred.id}/test`)).json()).toEqual({
      ok: false,
      error: 'blocked_address',
    });

    // Not allow-listed yet: blocked. Metadata stays blocked even when "allow-listed".
    await settings({ 'network.privateAllowlist': ['169.254.0.0/16', 'metadata.example'] });
    for (const baseUrl of ['http://internal.example/v1', 'http://metadata.example/v1']) {
      const cred = (
        await admin.http.post('/api/v1/admin/ai/credentials', {
          provider: 'ollama',
          label: 'O',
          baseUrl,
        })
      ).json();
      expect(
        (await admin.http.post(`/api/v1/admin/ai/credentials/${cred.id}/test`)).json(),
        baseUrl,
      ).toEqual({
        ok: false,
        error: 'blocked_address',
      });
    }
  });

  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find(
      (i) => i && i.family === 'IPv4' && !i.internal && /^(10|172|192)\./.test(i.address),
    )?.address;

  it.skipIf(!lanIp)('reaches an allow-listed private model server with the key', async () => {
    let seenAuth: string | undefined;
    const server = http.createServer((req, res) => {
      seenAuth = req.headers.authorization;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'llama3.2' }, { id: 'qwen3' }] }));
    });
    await new Promise<void>((r) => server.listen(0, lanIp, r));
    try {
      const port = (server.address() as AddressInfo).port;
      dns['models.lan'] = [lanIp!];
      const cred = (
        await admin.http.post('/api/v1/admin/ai/credentials', {
          provider: 'openai-compatible',
          label: 'LAN',
          baseUrl: `http://models.lan:${port}/v1`,
          apiKey: KEY,
        })
      ).json();
      const test = () => admin.http.post(`/api/v1/admin/ai/credentials/${cred.id}/test`);
      expect((await test()).json()).toEqual({ ok: false, error: 'blocked_address' });
      await settings({ 'network.privateAllowlist': ['models.lan'] });
      expect((await test()).json()).toEqual({ ok: true, models: ['llama3.2', 'qwen3'] });
      expect(seenAuth).toBe(`Bearer ${KEY}`);
    } finally {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    }
  });
});

describe.skipIf(!TEST_DATABASE_URL)('AI routing and budgets', () => {
  beforeEach(setup);
  afterEach(teardown);

  async function instanceRoute() {
    const cred = (
      await admin.http.post('/api/v1/admin/ai/credentials', {
        provider: 'anthropic',
        label: 'Inst',
        apiKey: KEY,
      })
    ).json();
    const res = await admin.http.put('/api/v1/admin/ai/routing', {
      'assist.task': { credentialId: cred.id, model: 'claude-x' },
    });
    expect(res.statusCode).toBe(200);
    return cred.id as string;
  }

  it('validates routes against ownership and capability', async () => {
    const mine = (
      await alice.http.post('/api/v1/ai/credentials', {
        provider: 'anthropic',
        label: 'A',
        apiKey: KEY,
      })
    ).json();
    const theirs = (
      await bob.http.post('/api/v1/ai/credentials', {
        provider: 'openai',
        label: 'B',
        apiKey: OTHER_KEY,
      })
    ).json();
    const put = (body: unknown) => alice.http.put('/api/v1/ai/routing', body);
    expect((await put({ 'assist.task': { credentialId: theirs.id, model: 'm' } })).statusCode).toBe(
      400,
    );
    expect(
      (await put({ 'ramble.transcribe': { credentialId: mine.id, model: 'm' } })).statusCode,
    ).toBe(400);
    expect((await put({ nope: { credentialId: mine.id, model: 'm' } })).statusCode).toBe(400);
    expect((await put({ decision: { credentialId: mine.id, model: 'm' } })).statusCode).toBe(200);
    const instId = await instanceRoute();
    expect((await put({ 'assist.task': { credentialId: instId, model: 'm' } })).statusCode).toBe(
      400,
    );

    // Even a forged routing row can't borrow someone else's credential.
    await t.db.db
      .update(users)
      .set({ aiRouting: { 'assist.task': { credentialId: theirs.id, model: 'm' } } })
      .where(eq(users.id, alice.id));
    expect(await t.app.services.ai.resolve(userOf(alice), 'assist.task')).toBeNull();
  });

  it('applies instance access and own-key policy', async () => {
    await instanceRoute();
    const ai = t.app.services.ai;
    expect(await ai.resolve(userOf(alice), 'assist.task')).toBeNull(); // default: admins only
    expect((await ai.resolve(userOf(admin, true), 'assist.task'))?.billing).toBe('instance');
    await settings({ 'ai.instanceAccess': 'everyone' });
    expect((await ai.resolve(userOf(alice), 'assist.task'))?.billing).toBe('instance');

    const own = (
      await alice.http.post('/api/v1/ai/credentials', {
        provider: 'openai',
        label: 'A',
        apiKey: KEY,
      })
    ).json();
    await alice.http.put('/api/v1/ai/routing', {
      'assist.task': { credentialId: own.id, model: 'gpt' },
    });
    expect(await ai.resolve(userOf(alice), 'assist.task')).toMatchObject({
      billing: 'own',
      model: 'gpt',
    });

    await settings({ 'ai.userKeys': false });
    expect((await ai.resolve(userOf(alice), 'assist.task'))?.billing).toBe('instance');
    expect(
      (
        await alice.http.post('/api/v1/ai/credentials', {
          provider: 'openai',
          label: 'B',
          apiKey: KEY,
        })
      ).statusCode,
    ).toBe(403);
    expect((await alice.http.post(`/api/v1/ai/credentials/${own.id}/test`)).statusCode).toBe(403);
    expect(
      (await alice.http.request({ method: 'DELETE', url: `/api/v1/ai/credentials/${own.id}` }))
        .statusCode,
    ).toBe(204);
    expect(await ai.userRouting(alice.id)).toEqual({});
  });

  it('removes a deleted instance credential from routing', async () => {
    const id = await instanceRoute();
    await admin.http.request({ method: 'DELETE', url: `/api/v1/admin/ai/credentials/${id}` });
    expect(t.app.services.settings.get('ai.routing')).toEqual({});
  });

  it('enforces the monthly budget under parallel calls', async () => {
    await instanceRoute();
    await settings({ 'ai.instanceAccess': 'everyone', 'ai.monthlyTokenBudget': 1000 });
    const ai = t.app.services.ai;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const call = () =>
      ai.run(userOf(alice), {
        feature: 'assist.task',
        estimate: { tokens: 300 },
        run: async (ctx) => {
          expect(ctx.credential.apiKey).toBe(KEY);
          await gate;
          return { result: 'ok', usage: { inputTokens: 50, outputTokens: 50, audioSeconds: 0 } };
        },
      });
    const pending = Array.from({ length: 10 }, call).map((p) =>
      p.then(
        () => 'ok',
        (e: unknown) => e,
      ),
    );
    // Let all reservations happen while every call is still in flight.
    await new Promise((r) => setTimeout(r, 300));
    release();
    const results = await Promise.all(pending);
    expect(results.filter((r) => r === 'ok')).toHaveLength(3);
    expect(results.filter((r) => r instanceof AiBudgetExceededError)).toHaveLength(7);

    // Settled at actual use (3 × 100), so there's room again: 300 + 7 × 100 = 1000.
    for (let i = 0; i < 7; i++) {
      await ai.run(userOf(alice), {
        feature: 'assist.task',
        estimate: { tokens: 100 },
        run: async () => ({
          result: 1,
          usage: { inputTokens: 60, outputTokens: 40, audioSeconds: 0 },
        }),
      });
    }
    await expect(
      ai.run(userOf(alice), {
        feature: 'assist.task',
        estimate: { tokens: 1 },
        run: async () => ({
          result: 1,
          usage: { inputTokens: 1, outputTokens: 0, audioSeconds: 0 },
        }),
      }),
    ).rejects.toBeInstanceOf(AiBudgetExceededError);

    // Bob has his own budget; the summary reports Alice's spend.
    await expect(
      ai.run(userOf(bob), {
        feature: 'assist.task',
        estimate: { tokens: 10 },
        run: async () => ({
          result: 1,
          usage: { inputTokens: 10, outputTokens: 0, audioSeconds: 0 },
        }),
      }),
    ).resolves.toBe(1);
    const usage = (await alice.http.get('/api/v1/ai/usage')).json();
    expect(usage.instance).toMatchObject({ tokens: 1000, tokenBudget: 1000 });
    const perUser = (await admin.http.get('/api/v1/admin/ai/usage')).json().users;
    expect(
      perUser.map((u: { username: string; tokens: number }) => [u.username, u.tokens]),
    ).toEqual([
      ['alice', 1000],
      ['bob', 10],
    ]);
  });

  it('serialises budget checks per user', async () => {
    const credentialId = await instanceRoute();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // Another request is mid-check for Alice: it holds her budget lock.
    const holder = t.db.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`bokydo:ai-budget:${alice.id}`}))`,
      );
      locked();
      await held;
    });
    await isLocked;
    let done = false;
    const reserve = reserveUsage(t.db.db, {
      userId: alice.id,
      credentialId,
      billing: 'instance',
      feature: 'assist.task',
      provider: 'anthropic',
      model: 'm',
      estimate: { tokens: 10, audioSeconds: 0 },
      budget: { tokens: 1000, audioSeconds: null },
    }).then(() => (done = true));
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    release();
    await holder;
    await reserve;
    expect(done).toBe(true);
  });

  it('releases the reservation of a failed call, and stale reservations expire', async () => {
    await instanceRoute();
    await settings({ 'ai.instanceAccess': 'everyone', 'ai.monthlyTokenBudget': 500 });
    const ai = t.app.services.ai;
    await expect(
      ai.run(userOf(alice), {
        feature: 'assist.task',
        estimate: { tokens: 500 },
        run: async () => {
          throw new Error('provider down');
        },
      }),
    ).rejects.toThrow('provider down');
    const ok = () =>
      ai.run(userOf(alice), {
        feature: 'assist.task',
        estimate: { tokens: 500 },
        run: async () => ({
          result: 1,
          usage: { inputTokens: 0, outputTokens: 0, audioSeconds: 0 },
        }),
      });
    await expect(ok()).resolves.toBe(1);

    // A crashed call leaves a reservation behind; after the TTL it stops counting.
    await t.db.db.insert(aiUsage).values({
      id: crypto.randomUUID(),
      userId: alice.id,
      billing: 'instance',
      feature: 'assist.task',
      provider: 'anthropic',
      model: 'm',
      status: 'reserved',
      reservedTokens: 500,
      startedAt: new Date(),
    });
    await expect(ok()).rejects.toBeInstanceOf(AiBudgetExceededError);
    await t.db.db
      .update(aiUsage)
      .set({ startedAt: sql`now() - interval '16 minutes'` })
      .where(and(eq(aiUsage.userId, alice.id), eq(aiUsage.status, 'reserved')));
    await expect(ok()).resolves.toBe(1);
  });

  it('own keys are metered but never budgeted', async () => {
    await settings({ 'ai.monthlyTokenBudget': 0 });
    const own = (
      await alice.http.post('/api/v1/ai/credentials', {
        provider: 'openai',
        label: 'A',
        apiKey: KEY,
      })
    ).json();
    await alice.http.put('/api/v1/ai/routing', {
      'assist.task': { credentialId: own.id, model: 'gpt' },
    });
    const ai = t.app.services.ai;
    await expect(
      ai.run(userOf(alice), {
        feature: 'assist.task',
        estimate: { tokens: 5000 },
        run: async () => ({
          result: 1,
          usage: { inputTokens: 4000, outputTokens: 1000, audioSeconds: 0 },
        }),
      }),
    ).resolves.toBe(1);
    await expect(
      ai.run(userOf(alice), {
        feature: 'reports',
        estimate: {},
        run: async () => ({
          result: 1,
          usage: { inputTokens: 0, outputTokens: 0, audioSeconds: 0 },
        }),
      }),
    ).rejects.toBeInstanceOf(AiNotConfiguredError);
    const usage = (await alice.http.get('/api/v1/ai/usage')).json();
    expect(usage.instance.tokens).toBe(0);
    expect(usage.byFeature).toEqual([
      { feature: 'assist.task', billing: 'own', calls: 1, tokens: 5000, audioSeconds: 0 },
    ]);
    expect((await admin.http.get('/api/v1/admin/ai/usage')).json().users).toEqual([]);
  });
});

describe('listModels', () => {
  const credential = {
    id: 'c',
    ownerUserId: null,
    provider: 'gemini' as const,
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: KEY,
    headers: {},
  };
  const reply =
    (status: number, body: unknown) =>
    async (url: string, init?: { headers?: Record<string, string> }) => {
      calls.push({ url, headers: init?.headers ?? {} });
      return {
        status,
        headers: {},
        body: (async function* () {})(),
        text: async () => JSON.stringify(body),
        json: async () => body,
        cancel: () => undefined,
      };
    };
  let calls: { url: string; headers: Record<string, string> }[] = [];
  beforeEach(() => {
    calls = [];
  });

  it('sends the key in a header, never the URL, and parses the list', async () => {
    const result = await listModels({
      credential,
      fetch: reply(200, { models: [{ name: 'models/gemini-b' }, { name: 'models/gemini-a' }] }),
    });
    expect(result).toEqual({ ok: true, models: ['gemini-a', 'gemini-b'] });
    expect(calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models');
    expect(calls[0]!.headers['x-goog-api-key']).toBe(KEY);
  });

  it('reduces failures to a code without the provider body', async () => {
    expect(await listModels({ credential, fetch: reply(401, { error: KEY }) })).toEqual({
      ok: false,
      error: 'unauthorized',
      status: 401,
    });
    expect(await listModels({ credential, fetch: reply(200, { models: 'nope' }) })).toEqual({
      ok: false,
      error: 'invalid_response',
    });
  });
});

describe.skipIf(!TEST_DATABASE_URL)('AI calls through the service', () => {
  beforeEach(setup);
  afterEach(teardown);

  const lanIp = Object.values(networkInterfaces())
    .flat()
    .find(
      (i) => i && i.family === 'IPv4' && !i.internal && /^(10|172|192)\./.test(i.address),
    )?.address;

  /** A scripted OpenAI-compatible model server on a private address. */
  async function modelServer(
    handle: (path: string, body: string, res: http.ServerResponse) => void,
  ) {
    const seen: { path: string; auth?: string; body: string }[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        seen.push({
          path: req.url ?? '',
          ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
          body,
        });
        handle(req.url ?? '', body, res);
      });
    });
    await new Promise<void>((r) => server.listen(0, lanIp, r));
    const port = (server.address() as AddressInfo).port;
    dns['models.lan'] = [lanIp!];
    await settings({ 'network.privateAllowlist': ['models.lan'] });
    const cred = (
      await admin.http.post('/api/v1/admin/ai/credentials', {
        provider: 'openai-compatible',
        label: 'LAN',
        baseUrl: `http://models.lan:${port}/v1`,
        apiKey: KEY,
      })
    ).json();
    const close = async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    };
    return { cred: cred.id as string, seen, close };
  }

  const json = (res: http.ServerResponse, body: unknown, status = 200) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const reply = (content: string, prompt = 20, completion = 5) => ({
    choices: [{ message: { content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: prompt, completion_tokens: completion },
  });

  async function ledger() {
    return t.db.db
      .select({
        status: aiUsage.status,
        feature: aiUsage.feature,
        input: aiUsage.inputTokens,
        output: aiUsage.outputTokens,
        audio: aiUsage.audioSeconds,
      })
      .from(aiUsage);
  }

  it.skipIf(!lanIp)('streams a chat and meters what the provider reported', async () => {
    const m = await modelServer((_path, _body, res) => {
      res.setHeader('content-type', 'text/event-stream');
      for (const e of [
        { choices: [{ delta: { content: 'Plan: ' } }] },
        { choices: [{ delta: { content: 'pack' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 30, completion_tokens: 7 } },
      ])
        res.write(`data: ${JSON.stringify(e)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    try {
      await settings({
        'ai.instanceAccess': 'everyone',
        'ai.routing': { 'assist.task': { credentialId: m.cred, model: 'llama' } },
      });
      const pieces: string[] = [];
      const r = await t.app.services.ai.chat(
        userOf(alice),
        'assist.task',
        { messages: [{ role: 'user', content: 'Trip' }], maxOutputTokens: 200 },
        { onText: (d) => pieces.push(d) },
      );
      expect(pieces).toEqual(['Plan: ', 'pack']);
      expect(r.text).toBe('Plan: pack');
      expect(m.seen[0]).toMatchObject({ path: '/v1/chat/completions', auth: `Bearer ${KEY}` });
      expect(JSON.parse(m.seen[0]!.body)).toMatchObject({
        model: 'llama',
        stream: true,
        max_tokens: 200,
      });
      expect(await ledger()).toEqual([
        { status: 'done', feature: 'assist.task', input: 30, output: 7, audio: 0 },
      ]);
    } finally {
      await m.close();
    }
  });

  it.skipIf(!lanIp)('validates structured replies with one correction round', async () => {
    const replies = ['not json', '```json\n{"subtasks":["Book","Pack"]}\n```'];
    const m = await modelServer((_p, _b, res) => {
      const next = replies.shift();
      if (next === 'HTTP 401') json(res, { error: 'no' }, 401);
      else json(res, reply(next ?? '{}'));
    });
    try {
      await settings({
        'ai.instanceAccess': 'everyone',
        'ai.routing': { 'assist.task': { credentialId: m.cred, model: 'llama' } },
      });
      const schema = z.object({ subtasks: z.array(z.string()).max(10) }).strict();
      const { value } = await t.app.services.ai.chatJson(userOf(alice), 'assist.task', {
        messages: [{ role: 'user', content: 'Break down: trip' }],
        maxOutputTokens: 100,
        schema,
        name: 'subtasks',
      });
      expect(value).toEqual({ subtasks: ['Book', 'Pack'] });
      const second = JSON.parse(m.seen[1]!.body);
      expect(second.messages.at(-2)).toEqual({ role: 'assistant', content: 'not json' });
      expect(second.messages.at(-1).content).toContain("doesn't match");
      expect(second.response_format.json_schema.schema.required).toEqual(['subtasks']);
      // Both rounds are metered on the one ledger row.
      expect(await ledger()).toEqual([
        { status: 'done', feature: 'assist.task', input: 40, output: 10, audio: 0 },
      ]);

      // Still wrong after the correction: the call fails and is metered as failed.
      replies.push('{"subtasks":1}', '{"subtasks":2}');
      await expect(
        t.app.services.ai.chatJson(userOf(alice), 'assist.task', {
          messages: [{ role: 'user', content: 'x' }],
          maxOutputTokens: 100,
          schema,
          name: 'subtasks',
        }),
      ).rejects.toMatchObject({ code: 'output_invalid' });
      expect((await ledger()).filter((r) => r.status === 'failed')).toEqual([
        { status: 'failed', feature: 'assist.task', input: 40, output: 10, audio: 0 },
      ]);

      // The correction round itself fails: the first round's usage is still metered.
      replies.push('nope', 'HTTP 401');
      await expect(
        t.app.services.ai.chatJson(userOf(alice), 'assist.task', {
          messages: [{ role: 'user', content: 'x' }],
          maxOutputTokens: 100,
          schema,
          name: 'subtasks',
        }),
      ).rejects.toMatchObject({ code: 'unauthorized' });
      expect((await ledger()).filter((r) => r.status === 'failed')).toContainEqual({
        status: 'failed',
        feature: 'assist.task',
        input: 20,
        output: 5,
        audio: 0,
      });
    } finally {
      await m.close();
    }
  });

  it.skipIf(!lanIp)(
    'refuses a call the budget cannot cover before contacting the provider',
    async () => {
      const m = await modelServer((_p, _b, res) => json(res, reply('ok')));
      try {
        await settings({
          'ai.instanceAccess': 'everyone',
          'ai.monthlyTokenBudget': 1000,
          'ai.routing': { 'assist.task': { credentialId: m.cred, model: 'llama' } },
        });
        await expect(
          t.app.services.ai.chat(userOf(alice), 'assist.task', {
            messages: [{ role: 'user', content: 'x' }],
            maxOutputTokens: 5000,
          }),
        ).rejects.toBeInstanceOf(AiBudgetExceededError);
        expect(m.seen).toHaveLength(0);
      } finally {
        await m.close();
      }
    },
  );

  it.skipIf(!lanIp)('transcribes and embeds through their routes', async () => {
    const m = await modelServer((path, _b, res) => {
      if (path === '/v1/audio/transcriptions') return json(res, { text: 'call mum' });
      json(res, { data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { prompt_tokens: 3 } });
    });
    try {
      await settings({
        'ai.instanceAccess': 'everyone',
        'ai.routing': {
          'ramble.transcribe': { credentialId: m.cred, model: 'whisper' },
          embeddings: { credentialId: m.cred, model: 'nomic' },
        },
      });
      const text = await t.app.services.ai.transcribe(userOf(alice), 'ramble.transcribe', {
        audio: Buffer.from('fake-audio'),
        mimeType: 'audio/ogg',
        durationSeconds: 12.2,
      });
      expect(text).toBe('call mum');
      expect(m.seen[0]!.body).toContain('filename="audio.ogg"');
      expect(await t.app.services.ai.embed(userOf(alice), ['call mum'])).toEqual([[0.1, 0.2]]);
      const rows = await ledger();
      expect(rows).toContainEqual({
        status: 'done',
        feature: 'ramble.transcribe',
        input: 0,
        output: 0,
        audio: 13,
      });
      expect(rows).toContainEqual({
        status: 'done',
        feature: 'embeddings',
        input: 3,
        output: 0,
        audio: 0,
      });
      // A feature only takes calls of its own kind.
      await expect(
        t.app.services.ai.chat(userOf(alice), 'ramble.transcribe', {
          messages: [{ role: 'user', content: 'x' }],
          maxOutputTokens: 1,
        }),
      ).rejects.toThrow(TypeError);
    } finally {
      await m.close();
    }
  });

  it.skipIf(!lanIp)(
    'tries a model with a stored credential, without leaking the error body',
    async () => {
      let calls = 0;
      const m = await modelServer((_p, _b, res) =>
        ++calls === 1 ? json(res, reply('OK')) : json(res, { error: `bad key ${KEY}` }, 401),
      );
      try {
        const tryIt = (body: unknown) =>
          admin.http.post(`/api/v1/admin/ai/credentials/${m.cred}/try`, body);
        const ok = (await tryIt({ model: 'llama', kind: 'chat' })).json();
        expect(ok).toMatchObject({ ok: true, reply: 'OK' });
        expect(ok.latencyMs).toEqual(expect.any(Number));
        expect((await tryIt({ model: 'llama', kind: 'chat' })).json()).toEqual({
          ok: false,
          error: 'unauthorized',
          status: 401,
        });
        expect((await tryIt({ model: 'bad model', kind: 'chat' })).statusCode).toBe(400);
        // Not someone else's credential, and not an instance one through the user route.
        expect(
          (
            await alice.http.post(`/api/v1/ai/credentials/${m.cred}/try`, {
              model: 'x',
              kind: 'chat',
            })
          ).statusCode,
        ).toBe(404);
      } finally {
        await m.close();
      }
    },
  );
});
