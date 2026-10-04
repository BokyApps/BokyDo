import { describe, expect, it } from 'vitest';
import { checkPassword } from './password-policy.js';

const opts = { minLength: 12, username: 'admin' };

describe('checkPassword', () => {
  it('accepts a long passphrase', () => {
    expect(checkPassword('correct horse battery staple', opts)).toBeNull();
  });
  it('counts characters, not UTF-16 units', () => {
    expect(checkPassword('🔒🔒🔒🔒🔒🔒', { ...opts, minLength: 7 })).toBe('too_short');
  });
  it.each([
    ['short', 'too_short'],
    ['my-admin-password', 'contains_username'],
    ['aaaaaaaaaaaaaaaa', 'too_simple'],
  ])('rejects %s (%s)', (pw, problem) => {
    expect(checkPassword(pw, opts)).toBe(problem);
  });
  it('rejects reusing the current password', () => {
    expect(
      checkPassword('the same old passphrase', {
        ...opts,
        currentPassword: 'the same old passphrase',
      }),
    ).toBe('same_as_current');
  });
});
