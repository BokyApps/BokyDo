import { describe, expect, it } from 'vitest';
import { normalizePublicUrl, settingsPatchSchema } from './settings.js';

describe('normalizePublicUrl', () => {
  it.each([
    ['https://tasks.example.com', 'https://tasks.example.com'],
    ['https://tasks.example.com/', 'https://tasks.example.com'],
    ['  http://192.168.1.10:8080 ', 'http://192.168.1.10:8080'],
    ['HTTPS://Tasks.Example.com:443', 'https://tasks.example.com'],
  ])('accepts %s', (input, expected) => {
    expect(normalizePublicUrl(input)).toBe(expected);
  });

  it.each([
    'ftp://example.com',
    'javascript:alert(1)',
    'https://user:pass@example.com',
    'https://example.com/bokydo',
    'https://example.com/?x=1',
    'https://example.com/#x',
    'example.com',
    '',
  ])('rejects %s', (input) => {
    expect(normalizePublicUrl(input)).toBeNull();
  });
});

describe('settingsPatchSchema', () => {
  it('rejects unknown keys and empty patches', () => {
    expect(settingsPatchSchema.safeParse({ 'instance.isPwned': true }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({}).success).toBe(false);
  });

  it('rejects mail header injection', () => {
    expect(settingsPatchSchema.safeParse({ 'email.fromName': 'x\r\nBcc: a@b.c' }).success).toBe(
      false,
    );
  });

  it('rejects an SMTP host with URL or path tricks', () => {
    for (const host of ['smtp.example.com/evil', 'http://x', 'a b']) {
      expect(settingsPatchSchema.safeParse({ 'email.smtpHost': host }).success).toBe(false);
    }
  });

  it('enforces a sane password minimum', () => {
    expect(settingsPatchSchema.safeParse({ 'security.passwordMinLength': 6 }).success).toBe(false);
  });
});
