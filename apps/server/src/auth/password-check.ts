import type { SettingsService } from '../settings/settings-service.js';
import { isBreachedPassword } from './breached.js';
import { checkPassword, type PasswordProblem } from './password-policy.js';

/** Local policy, then (if the admin opted in) the breached-password check. */
export async function validateNewPassword(
  settings: SettingsService,
  input: { password: string; username: string; currentPassword?: string },
  fetchImpl?: typeof fetch,
): Promise<PasswordProblem | 'breached' | null> {
  const problem = checkPassword(input.password, {
    minLength: settings.get('security.passwordMinLength'),
    username: input.username,
    ...(input.currentPassword !== undefined ? { currentPassword: input.currentPassword } : {}),
  });
  if (problem) return problem;
  if (
    settings.get('security.breachedPasswordCheck') &&
    (await isBreachedPassword(input.password, fetchImpl))
  ) {
    return 'breached';
  }
  return null;
}
