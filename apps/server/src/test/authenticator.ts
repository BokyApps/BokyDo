import {
  createHash,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';

/**
 * A software WebAuthn authenticator for tests: real P-256 keys, real CBOR, real signatures, with
 * knobs to misbehave (wrong origin/RP, no user verification, replayed counters).
 */
export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly publicJwk: { x: string; y: string };
  counter = 0;

  constructor(
    private readonly rpId: string,
    private readonly origin: string,
    readonly userHandle: Buffer | null = null,
  ) {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.publicJwk = jwk;
  }

  get id(): string {
    return this.credentialId.toString('base64url');
  }

  /** navigator.credentials.create() */
  register(options: { challenge: string }, opts: { origin?: string; rpId?: string } = {}) {
    const clientData = this.clientData('webauthn.create', options.challenge, opts.origin);
    const cose = cbor(
      new Map<number, unknown>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(this.publicJwk.x, 'base64url')],
        [-3, Buffer.from(this.publicJwk.y, 'base64url')],
      ]),
    );
    const attested = Buffer.concat([
      Buffer.alloc(16), // AAGUID
      u16(this.credentialId.length),
      this.credentialId,
      cose,
    ]);
    const authData = Buffer.concat([
      this.rpIdHash(opts.rpId),
      Buffer.from([0x45]),
      u32(this.counter),
      attested,
    ]); // UP | UV | AT
    const attestationObject = cbor(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: clientData.toString('base64url'),
        attestationObject: attestationObject.toString('base64url'),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }

  /** navigator.credentials.get() */
  assert(
    options: { challenge: string },
    opts: {
      origin?: string;
      rpId?: string;
      userVerified?: boolean;
      counter?: number;
      userHandle?: Buffer | null;
    } = {},
  ) {
    this.counter = opts.counter ?? this.counter + 1;
    const clientData = this.clientData('webauthn.get', options.challenge, opts.origin);
    const flags = 0x01 | (opts.userVerified === false ? 0 : 0x04);
    const authData = Buffer.concat([
      this.rpIdHash(opts.rpId),
      Buffer.from([flags]),
      u32(this.counter),
    ]);
    const signer = createSign('sha256');
    signer.update(Buffer.concat([authData, createHash('sha256').update(clientData).digest()]));
    const signature = signer.sign(this.privateKey);
    const handle = opts.userHandle === undefined ? this.userHandle : opts.userHandle;
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key' as const,
      response: {
        clientDataJSON: clientData.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        ...(handle ? { userHandle: handle.toString('base64url') } : {}),
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform' as const,
    };
  }

  private clientData(type: string, challenge: string, origin = this.origin): Buffer {
    return Buffer.from(JSON.stringify({ type, challenge, origin, crossOrigin: false }));
  }

  private rpIdHash(rpId = this.rpId): Buffer {
    return createHash('sha256').update(rpId).digest();
  }
}

const u16 = (n: number) => Buffer.from([n >> 8, n & 0xff]);
const u32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** Minimal CBOR encoder (ints, byte/text strings, maps) — enough for WebAuthn test vectors. */
function cbor(value: unknown): Buffer {
  const head = (major: number, n: number): Buffer => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) return Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
    return Buffer.concat([Buffer.from([(major << 5) | 26]), u32(n)]);
  };
  if (typeof value === 'number') return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === 'string')
    return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (value instanceof Map) {
    return Buffer.concat([
      head(5, value.size),
      ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]),
    ]);
  }
  throw new Error(`cbor: unsupported ${typeof value}`);
}
