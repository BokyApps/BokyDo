import type { ParsedIp } from '@bokydo/shared';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { OutboundError, PUBLIC_ONLY, type OutboundPolicy, type Resolver } from './outbound.js';
import { createLiveConnector, type LiveConnectOptions } from './outbound-ws.js';

const servers: WebSocketServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.clients.forEach((c) => c.terminate());
    await new Promise<void>((r) => s.close(() => r()));
  }
});

/** A test-only policy that reaches the local fake provider on 127.0.0.1. */
const loopbackOnly: OutboundPolicy = {
  httpsOnly: false,
  allows: (a: ParsedIp) => a.version === 4 && a.bytes.join('.') === '127.0.0.1',
};
const toLoopback: Resolver = async () => [{ address: '127.0.0.1', family: 4 }];

async function echoServer(): Promise<{ port: number }> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  servers.push(wss);
  await new Promise<void>((r) => wss.on('listening', () => r()));
  wss.on('connection', (socket) => socket.on('message', (data) => socket.send(data)));
  return { port: (wss.address() as AddressInfo).port };
}

const connect = (url: string, options: Partial<LiveConnectOptions> = {}) =>
  createLiveConnector(toLoopback)(url, { headers: {}, policy: loopbackOnly, ...options });

describe('SSRF-safe outbound WebSocket', () => {
  it('reaches a host through the shared lookup and streams both ways', async () => {
    const { port } = await echoServer();
    // The name resolves via the shared policy lookup (not the OS resolver) to the pinned address.
    const socket = await connect(`ws://models.test:${port}/`, {
      headers: { authorization: 'Bearer secret' },
    });
    const echoed = new Promise<string>((resolve) =>
      socket.once('message', (d) => resolve(String(d))),
    );
    socket.send('ping');
    expect(await echoed).toBe('ping');
    socket.close();
  });

  it('refuses a plain-http URL and non-websocket schemes', async () => {
    await expect(
      connect('https://api.openai.com/v1/realtime', { policy: PUBLIC_ONLY }),
    ).rejects.toThrow(OutboundError);
    await expect(connect('ftp://x/')).rejects.toThrow(OutboundError);
  });

  it('refuses plain ws under a public-only (https) policy', async () => {
    await expect(
      connect('ws://api.openai.com/realtime', { policy: PUBLIC_ONLY }),
    ).rejects.toMatchObject({ reason: 'insecure_url' });
  });

  it('refuses a loopback literal under a public-only policy', async () => {
    await expect(
      connect('wss://127.0.0.1/realtime', { policy: PUBLIC_ONLY }),
    ).rejects.toMatchObject({
      reason: 'blocked_address',
    });
  });

  it('refuses a name that resolves to a mixed public and private set', async () => {
    const mixed: Resolver = async () => [
      { address: '127.0.0.1', family: 4 },
      { address: '93.184.216.34', family: 4 },
    ];
    const connector = createLiveConnector(mixed);
    await expect(
      connector('wss://mixed.test/realtime', { headers: {}, policy: PUBLIC_ONLY }),
    ).rejects.toMatchObject({ reason: 'blocked_address' });
  });

  it('reports a failed DNS lookup as a code, not the hostname', async () => {
    const none: Resolver = async () => [];
    const connector = createLiveConnector(none);
    await expect(
      connector('wss://gone.test/realtime', { headers: {}, policy: PUBLIC_ONLY }),
    ).rejects.toMatchObject({ reason: 'blocked_address' });
  });
});
