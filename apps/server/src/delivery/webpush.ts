import {
  createECDH,
  createPrivateKey,
  createCipheriv,
  hkdfSync,
  randomBytes,
  sign,
} from 'node:crypto';

/**
 * Web Push without third-party code: message encryption (RFC 8291, aes128gcm per RFC 8188)
 * and VAPID application-server identification (RFC 8292). Only the user's browser can read a
 * payload; the push service sees ciphertext and our public key.
 */

const b64u = (b: Buffer) => b.toString('base64url');

export interface PushKeys {
  /** The browser's P-256 public key (65-byte uncompressed point, base64url). */
  p256dh: string;
  /** The browser's 16-byte authentication secret (base64url). */
  auth: string;
}

/** Encrypt `plaintext` for one subscription. `ephemeral`/`salt` are injectable for test vectors. */
export function encryptPayload(
  plaintext: Buffer,
  keys: PushKeys,
  opts: { ephemeralPrivateKey?: Buffer; salt?: Buffer } = {},
): Buffer {
  const uaPublic = Buffer.from(keys.p256dh, 'base64url');
  const authSecret = Buffer.from(keys.auth, 'base64url');
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('invalid p256dh key');
  if (authSecret.length !== 16) throw new Error('invalid auth secret');

  const ecdh = createECDH('prime256v1');
  if (opts.ephemeralPrivateKey) ecdh.setPrivateKey(opts.ephemeralPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const ecdhSecret = ecdh.computeSecret(uaPublic); // throws for points not on the curve
  const salt = opts.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: aes128gcm\0', 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, 'Content-Encoding: nonce\0', 12));

  // One record: the plaintext followed by the last-record delimiter.
  const cipher = createCipheriv('aes-128-gcm', cek, nonce, { authTagLength: 16 });
  const body = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, body]);
}

/** The instance's VAPID key pair, from the 32-byte private scalar kept in the secrets volume. */
export class VapidKeys {
  readonly publicKey: string;
  private readonly key: ReturnType<typeof createPrivateKey>;

  constructor(privateScalar: Buffer) {
    const ecdh = createECDH('prime256v1');
    ecdh.setPrivateKey(privateScalar);
    const pub = ecdh.getPublicKey();
    this.publicKey = b64u(pub);
    this.key = createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: b64u(privateScalar),
        x: b64u(pub.subarray(1, 33)),
        y: b64u(pub.subarray(33, 65)),
      },
      format: 'jwk',
    });
  }

  /** `Authorization` header value for a request to `endpoint` (valid 12 hours). */
  authorization(endpoint: string, subject: string, now = Date.now()): string {
    const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
    const claims = b64u(
      Buffer.from(
        JSON.stringify({
          aud: new URL(endpoint).origin,
          exp: Math.floor(now / 1000) + 12 * 3600,
          sub: subject,
        }),
      ),
    );
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
      key: this.key,
      dsaEncoding: 'ieee-p1363',
    });
    return `vapid t=${header}.${claims}.${b64u(signature)}, k=${this.publicKey}`;
  }
}

/** Generate a VAPID private scalar (32 bytes, base64url) for a new instance. */
export function newVapidKey(): string {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const d = ecdh.getPrivateKey();
  return b64u(Buffer.concat([Buffer.alloc(32 - d.length), d]));
}

/**
 * Push services browsers actually use. The server POSTs to whatever endpoint a client registers,
 * so endpoints are limited to these hosts over HTTPS (no SSRF into the LAN or cloud metadata).
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com', // Chrome, Edge, Brave, Opera, Samsung Internet
  'android.googleapis.com',
  'updates.push.services.mozilla.com', // Firefox
  'web.push.apple.com', // Safari (macOS, iOS home-screen apps)
];
const PUSH_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

export function pushEndpointAllowed(endpoint: string): boolean {
  if (endpoint.length > 1024) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password) return false;
  if (url.port && url.port !== '443') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.includes(host) || PUSH_SUFFIXES.some((s) => host.endsWith(s));
}

export interface PushMessage {
  title: string;
  body: string;
  /** Same-origin path the notification opens. */
  url: string;
  /** Replaces an earlier notification with the same tag. */
  tag?: string;
}

export type PushResult = 'sent' | 'gone' | 'failed';

/** Deliver one message. `gone` means the subscription is dead and should be deleted. */
export async function sendPush(
  subscription: { endpoint: string } & PushKeys,
  message: PushMessage,
  vapid: VapidKeys,
  subject: string,
  opts: { urgency?: 'high' | 'normal'; ttlSeconds?: number; fetchImpl?: typeof fetch } = {},
): Promise<PushResult> {
  if (!pushEndpointAllowed(subscription.endpoint)) return 'gone';
  let body: Buffer;
  try {
    body = encryptPayload(Buffer.from(JSON.stringify(message)), subscription);
  } catch {
    return 'gone'; // keys that can't be used will never work
  }
  const res = await (opts.fetchImpl ?? fetch)(subscription.endpoint, {
    method: 'POST',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
    headers: {
      authorization: vapid.authorization(subscription.endpoint, subject),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(opts.ttlSeconds ?? 4 * 3600),
      urgency: opts.urgency ?? 'normal',
    },
    body,
  }).catch(() => null);
  if (!res) return 'failed';
  await res.body?.cancel().catch(() => undefined);
  if (res.status === 404 || res.status === 410) return 'gone';
  return res.ok ? 'sent' : 'failed';
}
