/**
 * IP address parsing and classification for outbound-request safety (SSRF). Pure TypeScript so
 * the same rules validate admin settings in the browser and gate connections on the server.
 */
export interface ParsedIp {
  version: 4 | 6;
  /** 4 bytes for IPv4, 16 for IPv6. */
  bytes: Uint8Array;
}

export interface Cidr {
  ip: ParsedIp;
  prefix: number;
}

const byte = (bytes: Uint8Array, i: number): number => bytes[i] ?? 0;
const word = (bytes: Uint8Array, i: number): number => (byte(bytes, i) << 8) | byte(bytes, i + 1);

/**
 * Where an address points:
 *  - public:  globally routable; outbound requests may go here
 *  - private: RFC 1918, carrier-grade NAT, IPv6 unique-local; only reachable when an admin
 *             allow-lists it (e.g. a local Ollama)
 *  - blocked: loopback, link-local (cloud metadata), unspecified, multicast, documentation,
 *             reserved and transition ranges; never reachable, whatever the allow-list says
 */
export type IpClass = 'public' | 'private' | 'blocked';

/** Strict dotted-quad IPv4 or RFC 4291 IPv6 (no zone IDs). Returns null for anything else. */
export function parseIp(input: string): ParsedIp | null {
  const s = input.startsWith('[') && input.endsWith(']') ? input.slice(1, -1) : input;
  if (s.includes(':')) return parseIpv6(s);
  const v4 = parseIpv4(s);
  return v4 ? { version: 4, bytes: v4 } : null;
}

function parseIpv4(s: string): Uint8Array | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) {
    const p = parts[i] ?? '';
    // Decimal only, no leading zeros: "010" is octal to some parsers and decimal to others.
    if (!/^(0|[1-9]\d{0,2})$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out[i] = n;
  }
  return out;
}

function parseIpv6(s: string): ParsedIp | null {
  if (!/^[0-9A-Fa-f:.]+$/.test(s)) return null; // also rejects zone IDs ("fe80::1%eth0")
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const words = (part: string): number[] | null => {
    if (part === '') return [];
    const groups = part.split(':');
    const out: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i] ?? '';
      if (i === groups.length - 1 && g.includes('.')) {
        const v4 = parseIpv4(g);
        if (!v4) return null;
        out.push(word(v4, 0), word(v4, 2));
      } else {
        if (!/^[0-9A-Fa-f]{1,4}$/.test(g)) return null;
        out.push(parseInt(g, 16));
      }
    }
    return out;
  };
  const head = words(halves[0] ?? '');
  const tail = halves.length === 2 ? words(halves[1] ?? '') : [];
  if (!head || !tail) return null;
  // An embedded IPv4 is only valid at the very end.
  if (halves.length === 2 && (halves[0] ?? '').includes('.')) return null;
  const total = head.length + tail.length;
  if (halves.length === 1 ? total !== 8 : total > 7) return null;
  const all = [...head, ...new Array<number>(8 - total).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  all.forEach((w, i) => {
    bytes[i * 2] = w >> 8;
    bytes[i * 2 + 1] = w & 0xff;
  });
  return { version: 6, bytes };
}

export function formatIp(ip: ParsedIp): string {
  if (ip.version === 4) return [...ip.bytes].join('.');
  const words: string[] = [];
  for (let i = 0; i < 16; i += 2) words.push(word(ip.bytes, i).toString(16));
  return words.join(':');
}

/** "10.0.0.0/8", "fd00::/8"; a bare address means a single host. Host bits must be zero. */
export function parseCidr(input: string): Cidr | null {
  const [addr, len, extra] = input.trim().split('/');
  if (addr === undefined || extra !== undefined) return null;
  const ip = parseIp(addr);
  if (!ip) return null;
  const max = ip.version === 4 ? 32 : 128;
  if (len !== undefined && !/^(0|[1-9]\d{0,2})$/.test(len)) return null;
  const prefix = len === undefined ? max : Number(len);
  if (prefix > max) return null;
  for (let bit = prefix; bit < max; bit++) {
    if (byte(ip.bytes, bit >> 3) & (0x80 >> (bit & 7))) return null;
  }
  return { ip, prefix };
}

export function inCidr(ip: ParsedIp, cidr: Cidr): boolean {
  if (ip.version !== cidr.ip.version) return false;
  for (let bit = 0; bit < cidr.prefix; bit++) {
    const mask = 0x80 >> (bit & 7);
    if ((byte(ip.bytes, bit >> 3) & mask) !== (byte(cidr.ip.bytes, bit >> 3) & mask)) return false;
  }
  return true;
}

/** For the constant tables below: a typo must fail loudly at startup, not match nothing. */
function knownCidr(c: string): Cidr {
  const cidr = parseCidr(c);
  if (!cidr) throw new Error(`Invalid built-in CIDR ${c}`);
  return cidr;
}
const cidrs = (list: string[]) => list.map(knownCidr);

const V4_PRIVATE = cidrs(['10.0.0.0/8', '100.64.0.0/10', '172.16.0.0/12', '192.168.0.0/16']);
const V4_BLOCKED = cidrs([
  '0.0.0.0/8', // "this network"
  '127.0.0.0/8', // loopback
  '169.254.0.0/16', // link-local, incl. cloud metadata 169.254.169.254
  '100.100.100.200/32', // Alibaba Cloud metadata (inside CGNAT space)
  '192.0.0.0/24', // IETF protocol assignments
  '192.0.2.0/24', // documentation
  '192.88.99.0/24', // 6to4 relay anycast
  '198.18.0.0/15', // benchmarking
  '198.51.100.0/24', // documentation
  '203.0.113.0/24', // documentation
  '224.0.0.0/4', // multicast
  '240.0.0.0/4', // reserved, incl. broadcast
]);

const V6_GLOBAL = knownCidr('2000::/3');
const V6_PRIVATE = cidrs(['fc00::/7']);
const V6_BLOCKED = cidrs([
  '2001::/23', // IETF protocol assignments, incl. Teredo 2001::/32
  '2001:db8::/32', // documentation
  '2002::/16', // 6to4: tunnels to an embedded IPv4 we can't vet
  '3fff::/20', // documentation
  'fd00:ec2::254/128', // AWS metadata over IPv6 (inside fc00::/7)
]);
const V6_MAPPED = knownCidr('::ffff:0.0.0.0/96');
const V6_NAT64 = knownCidr('64:ff9b::/96');

export function classifyIp(ip: ParsedIp): IpClass {
  if (ip.version === 4) {
    if (V4_BLOCKED.some((c) => inCidr(ip, c))) return 'blocked';
    if (V4_PRIVATE.some((c) => inCidr(ip, c))) return 'private';
    return 'public';
  }
  // IPv4 carried inside IPv6 is judged by the IPv4 address it reaches.
  const embedded = embeddedIpv4(ip);
  if (embedded) return classifyIp(embedded);
  if (V6_BLOCKED.some((c) => inCidr(ip, c))) return 'blocked';
  if (V6_PRIVATE.some((c) => inCidr(ip, c))) return 'private';
  // Everything outside global unicast (loopback, ::, link-local, multicast, …) is blocked.
  return inCidr(ip, V6_GLOBAL) ? 'public' : 'blocked';
}

/** The IPv4 address an IPv4-mapped (::ffff:a.b.c.d) or NAT64 (64:ff9b::a.b.c.d) address reaches. */
export function embeddedIpv4(ip: ParsedIp): ParsedIp | null {
  if (ip.version !== 6) return null;
  if (!inCidr(ip, V6_MAPPED) && !inCidr(ip, V6_NAT64)) return null;
  return { version: 4, bytes: ip.bytes.slice(12) };
}
