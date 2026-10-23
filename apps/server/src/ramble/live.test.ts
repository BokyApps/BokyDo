import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { aiUsage } from '../db/schema.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';

/** A tiny stand-in for a browser/app connecting to the relay, with a message queue. */
interface Harness {
  socket: WebSocket;
  raw: string[];
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
}

function harness(socket: WebSocket): Harness {
  const queue: Record<string, unknown>[] = [];
  const waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  const raw: string[] = [];
  socket.on('message', (data) => {
    const text = data.toString();
    raw.push(text);
    const message = JSON.parse(text) as Record<string, unknown>;
    const i = waiters.findIndex((w) => w.type === message.type);
    if (i >= 0) waiters.splice(i, 1)[0]!.resolve(message);
    else queue.push(message);
  });
  return {
    socket,
    raw,
    waitFor(type, timeoutMs = 5000) {
      const i = queue.findIndex((m) => m.type === type);
      if (i >= 0) return Promise.resolve(queue.splice(i, 1)[0]!);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for ${type}; got ${JSON.stringify(queue)}`)),
          timeoutMs,
        );
        waiters.push({
          type,
          resolve: (m) => {
            clearTimeout(timer);
            resolve(m);
          },
        });
      });
    },
  };
}

describe.skipIf(!TEST_DATABASE_URL)('live Ramble relay', () => {
  const PASSWORD = 'violin-pancake-orbit-meadow';
  const KEY = 'sk-live-secret-key-1234567890';
  let t: TestApp;
  let fake: WebSocketServer;
  let alice: { id: string; token: string };
  let url: string;
  let origin: string;
  let providerAuth: string | undefined;
  let providerSaw: string[];
  let onSessionUpdate: (socket: WebSocket) => void;

  const settings = (patch: Parameters<TestApp['app']['services']['settings']['update']>[0]) =>
    t.app.services.settings.update(patch, { userId: null, ip: null });

  const headers = (extra: Record<string, string> = {}) => ({ origin, ...extra });
  const authed = () =>
    harness(new WebSocket(url, { headers: headers({ cookie: `bokydo_session=${alice.token}` }) }));

  beforeEach(async () => {
    providerSaw = [];
    providerAuth = undefined;
    onSessionUpdate = () => undefined;
    fake = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>((r) => fake.on('listening', () => r()));
    const fakeUrl = `ws://127.0.0.1:${(fake.address() as AddressInfo).port}/`;
    fake.on('connection', (socket, req) => {
      providerAuth = req.headers.authorization as string | undefined;
      socket.on('message', (data) => {
        const message = JSON.parse(data.toString()) as Record<string, unknown>;
        providerSaw.push(String(message.type ?? Object.keys(message)[0]));
        if (message.type === 'session.update') onSessionUpdate(socket);
      });
    });
    t = await testApp({
      liveConnect: (_url, opts) =>
        new Promise((resolve, reject) => {
          const socket = new WebSocket(fakeUrl, { headers: opts.headers });
          socket.once('open', () => resolve(socket));
          socket.once('error', reject);
        }),
    });
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    await createUser(t.db, { username: 'root', password: PASSWORD, isAdmin: true });
    const root = new Client(t.app);
    await root.login('root', PASSWORD);
    await settings({ 'ai.instanceAccess': 'everyone' });
    const cred = (
      await root.post('/api/v1/admin/ai/credentials', {
        provider: 'openai',
        label: 'live',
        apiKey: KEY,
      })
    ).json();
    await settings({
      'ai.routing': { 'ramble.live': { credentialId: cred.id, model: 'gpt-4o-realtime-preview' } },
    });
    const id = await createUser(t.db, { username: 'alice', password: PASSWORD });
    const client = new Client(t.app);
    await client.login('alice', PASSWORD);
    await client.post('/api/v1/sync', { cursor: null });
    alice = { id, token: client.cookies.get('bokydo_session')! };
    await t.app.listen({ port: 0, host: '127.0.0.1' });
    url = `ws://127.0.0.1:${(t.app.server.address() as AddressInfo).port}/api/v1/ramble/live`;
    origin = `http://127.0.0.1:${(t.app.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    for (const c of fake.clients) c.terminate();
    await new Promise<void>((r) => fake.close(() => r()));
    await t.close();
  });

  it('relays audio and the draft, applies extract operations, and never leaks the key', async () => {
    onSessionUpdate = (socket) => {
      socket.send(
        JSON.stringify({
          type: 'conversation.item.input_audio_transcription.completed',
          transcript: 'buy milk tomorrow',
        }),
      );
      socket.send(
        JSON.stringify({
          type: 'response.output_item.done',
          item: {
            type: 'function_call',
            name: 'edit_draft',
            call_id: 'c1',
            arguments: JSON.stringify({
              ops: [{ op: 'add', content: 'Buy milk', due: 'tomorrow' }],
            }),
          },
        }),
      );
    };
    const h = authed();
    await new Promise<void>((r) => h.socket.once('open', r));
    expect(await h.waitFor('ready')).toMatchObject({ type: 'ready', sampleRate: 24000 });
    const transcript = await h.waitFor('transcript');
    expect(transcript).toMatchObject({ text: 'buy milk tomorrow', final: true });
    const draftMessage = await h.waitFor('draft');
    const tasks = draftMessage.draft as {
      ref: string;
      content: string;
      resolved: { due: unknown };
    }[];
    expect(tasks[0]).toMatchObject({ ref: 'd1', content: 'Buy milk' });
    expect(tasks[0]!.resolved.due).not.toBeNull();
    expect(draftMessage.ops).toEqual([{ op: 'add', ref: 'd1' }]);

    // Audio is forwarded to the provider; the key is only in the server's handshake.
    h.socket.send(
      JSON.stringify({ type: 'audio', data: Buffer.alloc(48_000, 7).toString('base64') }),
    );
    h.socket.send(JSON.stringify({ type: 'stop' }));
    expect(await h.waitFor('closed')).toMatchObject({ reason: 'done' });
    expect(providerAuth).toBe(`Bearer ${KEY}`);
    expect(providerSaw).toContain('input_audio_buffer.append');
    // No frame the browser received ever carried the provider key.
    expect(h.raw.every((line) => !line.includes(KEY))).toBe(true);

    await expect
      .poll(async () =>
        (await t.db.db.select().from(aiUsage)).map((r) => ({
          feature: r.feature,
          status: r.status,
          audio: r.audioSeconds,
        })),
      )
      .toEqual([{ feature: 'ramble.live', status: 'done', audio: 1 }]);
  });

  it('refuses before opening a provider socket when the audio budget is spent', async () => {
    await settings({ 'ai.monthlyAudioMinutes': 1 });
    const h = authed();
    await new Promise<void>((r) => h.socket.once('open', r));
    expect(await h.waitFor('error')).toMatchObject({ code: 'ai_budget_exceeded' });
    expect(await h.waitFor('closed')).toMatchObject({ reason: 'provider_error' });
    expect(providerAuth).toBeUndefined();
  });

  it('answers clearly when no live model is routed', async () => {
    await settings({ 'ai.routing': {} });
    const h = authed();
    await new Promise<void>((r) => h.socket.once('open', r));
    expect(await h.waitFor('error')).toMatchObject({ code: 'ai_not_configured' });
    expect(await h.waitFor('closed')).toMatchObject({ reason: 'not_configured' });
  });

  it('accepts a bearer token with ai:use (apps, not just the browser)', async () => {
    const { token } = await t.app.services.apiTokens.createPat(alice.id, {
      name: 'live',
      scopes: ['ai:use'],
      expiresInDays: 1,
    });
    const h = harness(new WebSocket(url, { headers: { authorization: `Bearer ${token}` } }));
    await new Promise<void>((r) => h.socket.once('open', r));
    expect(await h.waitFor('ready')).toMatchObject({ sampleRate: 24000 });
    h.socket.close();
  });

  it('rejects an unauthenticated upgrade', async () => {
    const socket = new WebSocket(url, { headers: headers() });
    const outcome = await new Promise<string>((resolve) => {
      socket.once('open', () => resolve('open'));
      socket.once('unexpected-response', (_req, res) => resolve(`status:${res.statusCode}`));
      socket.once('error', () => resolve('error'));
    });
    expect(outcome).not.toBe('open');
  });

  it('rejects a cross-origin cookie upgrade (no CSRF header exists on a WebSocket)', async () => {
    const socket = new WebSocket(url, {
      headers: { cookie: `bokydo_session=${alice.token}`, origin: 'https://evil.example' },
    });
    const code = await new Promise<number>((resolve) => socket.once('close', (c) => resolve(c)));
    expect(code).toBe(1008);
  });
});
