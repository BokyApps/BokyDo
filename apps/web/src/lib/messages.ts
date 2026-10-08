import { ApiError } from './api.js';

const PASSWORD_PROBLEMS: Record<string, string> = {
  too_short: 'That password is too short.',
  contains_username: "Don't include your username in your password.",
  same_as_current: 'Choose a password different from the current one.',
  too_simple: 'That password is too simple.',
  breached: 'That password has appeared in a data breach. Choose a different one.',
};

const CONFLICTS: Record<string, string> = {
  smtp_not_configured: 'Save the SMTP settings first.',
  mfa_required:
    'Two-factor authentication is required here, so you need to keep at least one method.',
  last_admin: 'There must always be at least one administrator.',
  cannot_change_self: "You can't change your own account here.",
  username_or_email_taken: 'That username or email address is already in use.',
  email_taken: 'That email address is already in use.',
  passkey_already_registered: 'That passkey is already registered.',
  setup_expired: 'That took too long. Start again.',
  totp_already_enabled: 'An authenticator app is already set up.',
  no_second_factor: 'Set up two-factor authentication first.',
};

/** Human-readable text for an API error. */
export function errorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError')
    return 'The passkey request was cancelled or timed out.';
  if (!(err instanceof ApiError))
    return 'Something went wrong. Check your connection and try again.';
  switch (err.code) {
    case 'invalid_credentials':
      return 'Incorrect username or password.';
    case 'invalid_code':
      return "That code didn't work. Codes can only be used once.";
    case 'mfa_flow_expired':
      return 'Your sign-in timed out. Enter your password again.';
    case 'too_many_requests':
      return 'Too many attempts. Wait a moment and try again.';
    case 'weak_password':
      return PASSWORD_PROBLEMS[err.body?.message ?? ''] ?? 'Choose a stronger password.';
    case 'validation_failed':
      return err.body?.issues?.map((i) => i.message).join(' ') ?? 'Please check the form.';
    case 'invalid_token':
      return 'This link is invalid, expired, or has already been used.';
    case 'invalid_passkey':
      return "That passkey couldn't be verified.";
    case 'passkeys_unavailable':
      return 'Passkeys need BokyDo to be served over HTTPS at its public URL.';
    case 'registration_closed':
      return 'Sign-ups are closed. Ask an administrator for an invitation.';
    case 'csrf_failed':
      return "This request didn't come from your BokyDo address. Open BokyDo at its public URL and try again.";
    case 'smtp_failed':
      return `The mail server rejected the message (${err.body?.message ?? 'unknown error'}).`;
    case 'limit_exceeded':
      return "You've reached the limit for this.";
    case 'sign_in_disabled':
      return 'Subscription sign-in is switched off on this instance.';
    case 'ai_provider_error':
      return "The AI provider didn't answer as expected. Try again in a moment.";
    case 'ai_not_configured':
      return 'AI is not set up yet. An administrator can configure it, or you can add your own key in Settings → AI.';
    case 'ai_budget_exceeded':
      return "This month's AI budget is used up. It resets next month.";
    case 'ai_refused':
      return "The AI wouldn't turn that into tasks. Try rephrasing it.";
    case 'ai_unusable':
      return "Couldn't turn that into a filter. Try saying it differently.";
    case 'unsupported_media_type':
      return "This browser recorded audio in a format BokyDo can't read. Try typing instead.";
    case 'audio_too_long':
      return 'That recording was too long. Record shorter pieces.';
    case 'todoist_unauthorized':
      return "Todoist didn't accept that token.";
    case 'todoist_unavailable':
      return "Todoist couldn't be reached just now. Try again in a moment.";
    case 'todoist_invalid_response':
      return "Todoist sent an answer BokyDo couldn't read. Try again later.";
    case 'todoist_too_large':
      return 'That Todoist account is too big to import in one go.';
    case 'session_expired':
      return 'The Todoist connection expired. Connect again to continue.';
    case 'import_running':
      return 'An import is already running. Wait for it to finish, then try again.';
    case 'invalid_choice':
      return 'Some of those choices no longer match. Check the form and try again.';
    case 'not_created':
      return 'Nothing was created, because one task could not be saved.';
    case 'conflict':
      return CONFLICTS[err.body?.message ?? ''] ?? 'That conflicts with the current state.';
    default:
      return 'Something went wrong. Please try again.';
  }
}
