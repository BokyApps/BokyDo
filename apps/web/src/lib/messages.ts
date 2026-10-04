import { ApiError } from './api.js';

const PASSWORD_PROBLEMS: Record<string, string> = {
  too_short: 'That password is too short.',
  contains_username: "Don't include your username in your password.",
  same_as_current: 'Choose a password different from the current one.',
  too_simple: 'That password is too simple.',
};

/** Human-readable text for an API error. */
export function errorMessage(err: unknown): string {
  if (!(err instanceof ApiError))
    return 'Something went wrong. Check your connection and try again.';
  switch (err.code) {
    case 'invalid_credentials':
      return 'Incorrect username or password.';
    case 'too_many_requests':
      return 'Too many attempts. Wait a moment and try again.';
    case 'weak_password':
      return PASSWORD_PROBLEMS[err.body?.message ?? ''] ?? 'Choose a stronger password.';
    case 'validation_failed':
      return err.body?.issues?.map((i) => i.message).join(' ') ?? 'Please check the form.';
    case 'csrf_failed':
      return "This request didn't come from your BokyDo address. Open BokyDo at its public URL and try again.";
    case 'smtp_not_configured':
      return 'Save the SMTP settings first.';
    case 'smtp_failed':
      return `The mail server rejected the message (${err.body?.message ?? 'unknown error'}).`;
    case 'conflict':
      return err.body?.message === 'smtp_not_configured'
        ? 'Save the SMTP settings first.'
        : 'That conflicts with the current state.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
