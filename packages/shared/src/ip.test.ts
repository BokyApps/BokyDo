import { describe, expect, it } from 'vitest';
import { classifyIp, formatIp, inCidr, parseCidr, parseIp } from './ip.js';

const cls = (s: string) => {
  const ip = parseIp(s);
  if (!ip) throw new Error(`unparsable ${s}`);
  return classifyIp(ip);
};

describe('parseIp', () => {
  it('accepts canonical forms', () => {
    expect(formatIp(parseIp('192.168.1.20')!)).toBe('192.168.1.20');
    expect(formatIp(parseIp('::1')!)).toBe('0:0:0:0:0:0:0:1');
    expect(formatIp(parseIp('[2001:db8::1]')!)).toBe('2001:db8:0:0:0:0:0:1');
    expect(formatIp(parseIp('::ffff:127.0.0.1')!)).toBe('0:0:0:0:0:ffff:7f00:1');
    expect(parseIp('1:2:3:4:5:6:7:8')).not.toBeNull();
  });

  it('rejects ambiguous or malformed input', () => {
    for (const bad of [
      '127.1', // short form
      '0177.0.0.1', // octal
      '0x7f.0.0.1', // hex
      '2130706433', // integer
      '256.0.0.1',
      '1.2.3.4.5',
      '',
      'localhost',
      '1::2::3',
      '1:2:3:4:5:6:7:8:9',
      '1:2:3:4:5:6:7',
      'fe80::1%eth0', // zone ID
      '1.2.3.4::1', // IPv4 not last
      '::12345',
    ]) {
      expect(parseIp(bad), bad).toBeNull();
    }
  });
});

describe('parseCidr / inCidr', () => {
  it('matches prefixes', () => {
    const net = parseCidr('172.16.0.0/12')!;
    expect(inCidr(parseIp('172.31.255.255')!, net)).toBe(true);
    expect(inCidr(parseIp('172.32.0.0')!, net)).toBe(false);
    expect(inCidr(parseIp('::ffff:172.16.0.1')!, net)).toBe(false); // different family
    expect(parseCidr('10.1.2.3')!.prefix).toBe(32);
    expect(parseCidr('fd00::/8')!.prefix).toBe(8);
  });

  it('rejects host bits, bad prefixes and junk', () => {
    for (const bad of ['10.0.0.1/8', '10.0.0.0/33', '::/129', '10.0.0.0/08', '10.0.0.0/8/1', 'x']) {
      expect(parseCidr(bad), bad).toBeNull();
    }
  });
});

describe('classifyIp', () => {
  it('blocks loopback, link-local, metadata and special ranges in every spelling', () => {
    for (const s of [
      '127.0.0.1',
      '127.255.255.254',
      '0.0.0.0',
      '169.254.169.254',
      '100.100.100.200',
      '224.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
      '192.0.2.10',
      '::',
      '::1',
      '::127.0.0.1', // IPv4-compatible (deprecated)
      '::ffff:127.0.0.1', // IPv4-mapped
      '::ffff:169.254.169.254',
      '64:ff9b::127.0.0.1', // NAT64
      'fe80::1',
      'fec0::1',
      'ff02::1',
      'fd00:ec2::254',
      '2001:db8::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', // Teredo
      '2002:7f00:1::', // 6to4 of 127.0.0.1
    ]) {
      expect(cls(s), s).toBe('blocked');
    }
  });

  it('marks internal networks private', () => {
    for (const s of [
      '10.0.0.1',
      '172.16.5.4',
      '192.168.0.10',
      '100.64.0.1',
      'fd12:3456::1',
      '::ffff:10.0.0.1',
      '64:ff9b::192.168.1.1',
    ]) {
      expect(cls(s), s).toBe('private');
    }
  });

  it('allows public addresses', () => {
    for (const s of [
      '8.8.8.8',
      '1.1.1.1',
      '2606:4700::1111',
      '::ffff:8.8.8.8',
      '64:ff9b::1.1.1.1',
    ]) {
      expect(cls(s), s).toBe('public');
    }
  });
});
