import { createECDH } from 'node:crypto';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pushSubscriptions } from '../db/schema.js';
import { Client, createUser, testApp, type TestApp } from '../test/app.js';
import { TEST_DATABASE_URL } from '../test/db.js';

const PASSWORD = 'violin-pancake-orbit-meadow';

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find(
    (i) => i && i.family === 'IPv4' && !i.internal && /^(10|172|192)\./.test(i.address),
  )?.address;

describe.skipIf(!TEST_DATABASE_URL)('admin-listed push services (UnifiedPush)', () => {
  let t: TestApp;
  let alice: { id: string; http: Client };
  const dns: Record<string, string[]> = {};
  const servers: net.Server[] = [];

  beforeEach(async () => {
    t = await testApp({
      resolver: async (host) => {
        const found = dns[host];
        if (!found) throw new Error('ENOTFOUND');
        return found.map((address) => ({ address, family: 4 }));
      },
    });
    await t.app.services.settings.markSetupComplete({ userId: null, ip: null });
    const id = await createUser(t.db, { username: 'alice', password: PASSWORD });
    const http = new Client(t.app);
    await http.login('alice', PASSWORD);
    alice = { id, http };
  });
  afterEach(async () => {
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
    await t.close();
  });

  const settings = (patch: Parameters<TestApp['app']['services']['settings']['update']>[0]) =>
    t.app.services.settings.update(patch, { userId: null, ip: null });

  const keys = () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    return {
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: Buffer.alloc(16, 7).toString('base64url'),
    };
  };
  const subscribe = (endpoint: string) =>
    alice.http.post('/api/v1/push/subscriptions', { endpoint, keys: keys() });

  /** A TCP listener that records whether anything connected (TLS never completes; that's fine). */
  async function listener(host: string) {
    const seen = { connections: 0 };
    const server = net.createServer((sock) => {
      seen.connections++;
      sock.destroy();
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, host, r));
    return { port: (server.address() as AddressInfo).port, seen };
  }

  it('accepts endpoints on listed hosts only, and the setting validates entries', async () => {
    expect((await subscribe('https://ntfy.example.com/upX')).statusCode).toBe(400);
    await settings({ 'push.allowedHosts': ['ntfy.example.com', '*.push.example.org:8443'] });
    expect((await subscribe('https://ntfy.example.com/upX?up=1')).statusCode).toBe(201);
    expect((await subscribe('https://a.push.example.org:8443/x')).statusCode).toBe(201);
    expect((await subscribe('https://a.push.example.org/x')).statusCode).toBe(400);
    expect((await subscribe('http://ntfy.example.com/upY')).statusCode).toBe(400);

    await createUser(t.db, { username: 'root', password: PASSWORD, isAdmin: true });
    const root = new Client(t.app);
    await root.login('root', PASSWORD);
    for (const bad of [
      '10.0.0.5',
      '*.com',
      'localhost',
      'ntfy.localhost',
      'a..b',
      'host:99999',
      'https://ntfy.sh',
    ])
      expect(
        (await root.patch('/api/v1/admin/settings', { 'push.allowedHosts': [bad] })).statusCode,
        bad,
      ).toBe(400);
    expect(
      (await root.patch('/api/v1/admin/settings', { 'push.allowedHosts': ['NTFY.sh'] })).statusCode,
    ).toBe(200);
    expect(t.app.services.settings.get('push.allowedHosts')).toEqual(['ntfy.sh']);
  });

  it('never connects to loopback through a listed name', async () => {
    const loop = await listener('127.0.0.1');
    dns['ntfy.trap.example'] = ['127.0.0.1'];
    await settings({ 'push.allowedHosts': [`ntfy.trap.example:${loop.port}`] });
    expect((await subscribe(`https://ntfy.trap.example:${loop.port}/up1`)).statusCode).toBe(201);
    expect(await t.app.services.delivery.push(alice.id, { title: 't', body: 'b', url: '/' })).toBe(
      0,
    );
    expect(loop.seen.connections).toBe(0);
  });

  it.skipIf(!lanIp)('reaches a listed self-hosted push server on the LAN', async () => {
    const lan = await listener(lanIp!);
    dns['ntfy.home.example'] = [lanIp!];
    await settings({ 'push.allowedHosts': [`ntfy.home.example:${lan.port}`] });
    expect((await subscribe(`https://ntfy.home.example:${lan.port}/up1`)).statusCode).toBe(201);
    await t.app.services.delivery.push(alice.id, { title: 't', body: 'b', url: '/' });
    expect(lan.seen.connections).toBe(1);

    // Another private name that isn't a listed push host stays unreachable.
    dns['other.home.example'] = [lanIp!];
    await settings({
      'push.allowedHosts': [`ntfy.home.example:${lan.port}`, `*.home.example:${lan.port}`],
    });
    expect((await subscribe(`https://other.home.example:${lan.port}/up2`)).statusCode).toBe(201);
    lan.seen.connections = 0;
    await t.app.services.delivery.push(alice.id, { title: 't', body: 'b', url: '/' });
    expect(lan.seen.connections).toBe(1); // only the exact listed host, not the wildcard one

    // Taking a host off the list stops delivery and drops its subscriptions.
    await settings({ 'push.allowedHosts': [] });
    lan.seen.connections = 0;
    await t.app.services.delivery.push(alice.id, { title: 't', body: 'b', url: '/' });
    expect(lan.seen.connections).toBe(0);
    expect(
      await t.db.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, alice.id)),
    ).toEqual([]);
  });
});
