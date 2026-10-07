import { createECDH, createPublicKey, verify, createDecipheriv, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  encryptPayload,
  newVapidKey,
  pushEndpointAllowed,
  sendPush,
  VapidKeys,
} from './webpush.js';
import { OutboundError, type OutboundFetch } from '../net/outbound.js';

const b = (s: string) => Buffer.from(s.replace(/\s/g, ''), 'base64url');

describe('Web Push encryption (RFC 8291)', () => {
  it('matches the RFC 8291 example byte for byte', () => {
    // The published example keys from RFC 8291 §5 / Appendix A: public test values, not secrets.
    const out = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      {
        p256dh:
          'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', // gitleaks:allow
        auth: 'BTBZMqHH6r4Tts7J_aSIgg', // gitleaks:allow
      },
      {
        ephemeralPrivateKey: b('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw'), // gitleaks:allow
        salt: b('DGv6ra1nlYgDCS1FRnbzlw'),
      },
    );
    expect(out.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
        'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
        'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
    );
  });

  it('round-trips with a fresh key and salt each time', () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const auth = Buffer.alloc(16, 7);
    const keys = {
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: auth.toString('base64url'),
    };
    const a = encryptPayload(Buffer.from('{"title":"x"}'), keys);
    const c = encryptPayload(Buffer.from('{"title":"x"}'), keys);
    expect(a.equals(c)).toBe(false);
    // Decrypt as the browser would.
    const salt = a.subarray(0, 16);
    const asPublic = a.subarray(21, 86);
    const secret = ua.computeSecret(asPublic);
    const info = Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPublic]);
    const ikm = Buffer.from(hkdfSync('sha256', secret, auth, info, 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));
    const body = a.subarray(86);
    const d = createDecipheriv('aes-128-gcm', cek, nonce, { authTagLength: 16 });
    d.setAuthTag(body.subarray(body.length - 16));
    const plain = Buffer.concat([d.update(body.subarray(0, body.length - 16)), d.final()]);
    expect(plain.toString()).toBe('{"title":"x"}\u0002');
  });

  it('rejects malformed or off-curve browser keys', () => {
    const auth = Buffer.alloc(16).toString('base64url');
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: 'AAAA', auth })).toThrow();
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString('base64url');
    expect(() => encryptPayload(Buffer.from('x'), { p256dh: offCurve, auth })).toThrow();
  });
});

describe('VAPID (RFC 8292)', () => {
  it('signs a short-lived JWT for the endpoint origin that verifies with the public key', () => {
    const vapid = new VapidKeys(Buffer.from(newVapidKey(), 'base64url'));
    const header = vapid.authorization(
      'https://fcm.googleapis.com/fcm/send/abc',
      'https://todo.example',
      Date.UTC(2030, 0, 1),
    );
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header) ?? [];
    expect(k).toBe(vapid.publicKey);
    const [h, c, s] = jwt!.split('.');
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      exp: Date.UTC(2030, 0, 1) / 1000 + 12 * 3600,
      sub: 'https://todo.example',
    });
    const pub = Buffer.from(k!, 'base64url');
    const key = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: pub.subarray(1, 33).toString('base64url'),
        y: pub.subarray(33).toString('base64url'),
      },
      format: 'jwk',
    });
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${c}`),
        { key, dsaEncoding: 'ieee-p1363' },
        Buffer.from(s!, 'base64url'),
      ),
    ).toBe(true);
  });
});

describe('push endpoints', () => {
  it.each([
    ['https://fcm.googleapis.com/fcm/send/abc', true],
    ['https://updates.push.services.mozilla.com/wpush/v2/abc', true],
    ['https://web.push.apple.com/QGx', true],
    ['https://api.push.apple.com/x', true],
    ['https://db5p.notify.windows.com/w/?token=x', true],
    ['http://fcm.googleapis.com/fcm/send/abc', false],
    ['https://fcm.googleapis.com:8443/x', false],
    ['https://user:pw@fcm.googleapis.com/x', false],
    ['https://fcm.googleapis.com.evil.example/x', false],
    ['https://evilpush.apple.com.example/x', false],
    ['https://169.254.169.254/latest/meta-data', false],
    ['https://localhost/x', false],
    ['https://10.0.0.5/x', false],
    ['not a url', false],
    [`https://fcm.googleapis.com/${'a'.repeat(1100)}`, false],
  ])('%s → %s', (url, ok) => {
    expect(pushEndpointAllowed(url)).toBe(ok);
  });

  it('never contacts a disallowed endpoint and reports gone/failed by status', async () => {
    const vapid = new VapidKeys(Buffer.from(newVapidKey(), 'base64url'));
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const keys = {
      p256dh: ua.getPublicKey().toString('base64url'),
      auth: Buffer.alloc(16).toString('base64url'),
    };
    const calls: string[] = [];
    const fake =
      (status: number): OutboundFetch =>
      async (url) => {
        calls.push(url);
        return {
          status,
          headers: {},
          body: (async function* () {})(),
          text: async () => '',
          json: async () => null,
          cancel: () => undefined,
        };
      };
    const failing: OutboundFetch = async () => {
      throw new OutboundError('blocked_address');
    };
    const msg = { title: 't', body: 'b', url: '/today' };
    const send = (endpoint: string, fetch: OutboundFetch, extraHosts: string[] = []) =>
      sendPush({ endpoint, ...keys }, msg, vapid, 's', { fetch, extraHosts });
    expect(await send('https://10.0.0.5/x', fake(201))).toBe('gone');
    expect(await send('https://ntfy.example.com/up1', fake(201))).toBe('gone');
    expect(calls).toEqual([]);
    const ep = 'https://fcm.googleapis.com/fcm/send/abc';
    expect(await send(ep, fake(201))).toBe('sent');
    expect(await send(ep, fake(410))).toBe('gone');
    expect(await send(ep, fake(500))).toBe('failed');
    expect(await send(ep, failing)).toBe('failed');
    expect(await send('https://ntfy.example.com/up1', fake(201), ['ntfy.example.com'])).toBe(
      'sent',
    );
  });

  it.each([
    ['https://ntfy.example.com/upAbc?up=1', ['ntfy.example.com'], true],
    ['https://NTFY.example.com./upAbc', ['ntfy.example.com'], true],
    ['https://ntfy.example.com:8443/up', ['ntfy.example.com:8443'], true],
    ['https://ntfy.example.com:8443/up', ['ntfy.example.com'], false],
    ['https://ntfy.example.com/up', ['ntfy.example.com:8443'], false],
    ['https://a.push.example.org/x', ['*.push.example.org'], true],
    ['https://push.example.org/x', ['*.push.example.org'], false],
    ['https://ntfy.example.com.evil.example/up', ['ntfy.example.com'], false],
    ['https://evilntfy.example.com/up', ['ntfy.example.com'], false],
    ['http://ntfy.example.com/up', ['ntfy.example.com'], false],
    ['https://user@ntfy.example.com/up', ['ntfy.example.com'], false],
    ['https://ntfy.example.com/up', [], false],
    // The vendors keep their rules whatever the list says.
    ['https://fcm.googleapis.com:8443/x', ['ntfy.example.com'], false],
  ])('%s with %j → %s', (url, hosts, ok) => {
    expect(pushEndpointAllowed(url, hosts)).toBe(ok);
  });
});
