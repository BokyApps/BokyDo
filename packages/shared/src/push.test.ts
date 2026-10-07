import { describe, expect, it } from 'vitest';
import { parsePushHost, pushHostAllowed } from './push.js';

describe('push host entries', () => {
  it.each([
    ['ntfy.sh', { host: 'ntfy.sh', wildcard: false, port: 443 }],
    [' NTFY.Example.com:8443 ', { host: 'ntfy.example.com', wildcard: false, port: 8443 }],
    ['*.push.example.org', { host: 'push.example.org', wildcard: true, port: 443 }],
  ])('%s parses', (entry, parsed) => {
    expect(parsePushHost(entry)).toEqual(parsed);
  });

  it.each([
    'localhost',
    'ntfy.localhost',
    '10.0.0.5',
    '1.2.3.4:443',
    '*.com',
    '*',
    'ntfy',
    'a..b',
    '-a.example',
    'ntfy.sh:0',
    'ntfy.sh:65536',
    'https://ntfy.sh',
    'ntfy.sh/path',
    '*.*.example.com',
    'user@ntfy.sh',
  ])('%s is refused', (entry) => {
    expect(parsePushHost(entry)).toBeNull();
  });

  it('matches host and port exactly, wildcards only below the domain', () => {
    const list = ['ntfy.sh', '*.push.example.org:8443'];
    expect(pushHostAllowed(list, 'ntfy.sh', 443)).toBe(true);
    expect(pushHostAllowed(list, 'NTFY.SH.', 443)).toBe(true);
    expect(pushHostAllowed(list, 'ntfy.sh', 8443)).toBe(false);
    expect(pushHostAllowed(list, 'x.ntfy.sh', 443)).toBe(false);
    expect(pushHostAllowed(list, 'a.b.push.example.org', 8443)).toBe(true);
    expect(pushHostAllowed(list, 'push.example.org', 8443)).toBe(false);
    expect(pushHostAllowed(list, 'evilpush.example.org', 8443)).toBe(false);
    expect(pushHostAllowed(['bogus entry'], 'bogus entry', 443)).toBe(false);
  });
});
