export type PasswordProblem = 'too_short' | 'contains_username' | 'same_as_current' | 'too_simple';

/**
 * NIST 800-63B style: length over composition rules. A breached-password check (HIBP k-anonymity)
 * is added in W1 as an admin opt-in because it makes an outbound request.
 */
export function checkPassword(
  password: string,
  opts: { minLength: number; username: string; currentPassword?: string },
): PasswordProblem | null {
  if ([...password].length < opts.minLength) return 'too_short';
  if (opts.currentPassword !== undefined && password === opts.currentPassword)
    return 'same_as_current';
  const lower = password.toLowerCase();
  if (opts.username.length >= 3 && lower.includes(opts.username.toLowerCase()))
    return 'contains_username';
  if (new Set(password).size < 4) return 'too_simple';
  return null;
}
