# ADR 0004: Authentication, MFA and account recovery

- Status: Accepted (2026-10-04)

## Decision

- **Second factors**: TOTP (RFC 6238, implemented in-house against the RFC test vectors, ±1 step
  drift, last-used step stored so a code works once), passkeys/security keys (WebAuthn via
  SimpleWebAuthn), and 10 single-use recovery codes (HMAC-keyed hashes, atomic consumption).
- **Login flow**: a correct password for a user with a second factor yields only an `mfa` flow
  (HttpOnly, SameSite=Strict cookie scoped to `/api/v1/auth`, 5 minutes, 5 attempts, single use),
  never a session. Passkey-only passwordless sign-in requires user verification; a passkey used
  as a second factor requires user presence.
- **Passkey relying party** is derived only from the configured public URL (HTTPS or localhost,
  never an IP address), never from request headers.
- **Sudo mode**: enabling/disabling factors, adding/removing passkeys, changing email and
  granting admin need a password or passkey check within 10 minutes.
- **MFA policy** (off / admins / everyone): users who need MFA and have none are confined to the
  enrolment screens (`mfa_enrollment_required`); the last factor can't be removed while required.
- **Recovery**: password reset only to _verified_ addresses, 30-minute single-use links with the
  token in the URL fragment, always-202 responses; a reset signs out everywhere but never
  disables MFA. Admin-issued reset links work without SMTP. Break-glass CLI:
  `bokydo admin reset-password`, `bokydo admin reset-mfa`.
- **Notifications**: new-IP sign-ins and every security change are emailed to the verified address;
  an email change also warns the old address.
- **Breached-password check** (HIBP k-anonymity, padded) is opt-in because it makes an outbound
  request; it fails open.
