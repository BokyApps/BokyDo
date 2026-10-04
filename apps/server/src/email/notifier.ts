import { and, count, eq, gt, isNotNull } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../db/client.js';
import { auditLog, users } from '../db/schema.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { Mailer } from './mailer.js';

export type SecurityEvent =
  | 'new_login'
  | 'password_changed'
  | 'totp_enabled'
  | 'totp_disabled'
  | 'recovery_codes_regenerated'
  | 'recovery_code_used'
  | 'passkey_added'
  | 'passkey_removed'
  | 'mfa_reset_by_admin'
  | 'email_changed';

const SUBJECTS: Record<SecurityEvent, string> = {
  new_login: 'New sign-in to your account',
  password_changed: 'Your password was changed',
  totp_enabled: 'Two-factor authentication turned on',
  totp_disabled: 'Two-factor authentication turned off',
  recovery_codes_regenerated: 'New recovery codes were generated',
  recovery_code_used: 'A recovery code was used to sign in',
  passkey_added: 'A passkey was added to your account',
  passkey_removed: 'A passkey was removed from your account',
  mfa_reset_by_admin: 'An administrator reset your two-factor authentication',
  email_changed: 'Your email address was changed',
};

export interface RequestMeta {
  ip: string | null;
  userAgent: string | null;
}

/**
 * Security notifications and link emails. All links are built from the configured public URL,
 * never from request headers. Sending is best-effort and never blocks or fails the request.
 */
export class Notifier {
  constructor(
    private readonly db: Database,
    private readonly settings: SettingsService,
    private readonly mailer: Mailer,
    private readonly log: FastifyBaseLogger,
  ) {}

  get canEmail(): boolean {
    return this.mailer.isConfigured() && this.settings.get('instance.publicUrl') !== null;
  }

  link(path: string, token?: string): string {
    const base = this.settings.get('instance.publicUrl') ?? '';
    // Tokens go in the fragment: never sent to servers, proxies or Referer headers.
    return token ? `${base}${path}#${token}` : `${base}${path}`;
  }

  /** Fire-and-forget security notice to the user's verified address. */
  security(userId: string, event: SecurityEvent, meta?: RequestMeta, toAddress?: string): void {
    void this.sendSecurity(userId, event, meta, toAddress).catch((err: unknown) =>
      this.log.warn({ err, event }, 'security email failed'),
    );
  }

  private async sendSecurity(
    userId: string,
    event: SecurityEvent,
    meta?: RequestMeta,
    toAddress?: string,
  ) {
    if (!this.canEmail) return;
    const [user] = await this.db
      .select({ username: users.username, email: users.email, verified: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId));
    const to = toAddress ?? (user?.verified ? user.email : null);
    if (!user || !to) return;
    const lines = [
      `Hi ${user.username},`,
      '',
      `${SUBJECTS[event]} on ${this.settings.get('instance.name')} at ${new Date().toUTCString()}.`,
      ...(meta?.ip ? [`IP address: ${meta.ip}`] : []),
      ...(meta?.userAgent ? [`Device: ${meta.userAgent.slice(0, 200)}`] : []),
      '',
      'If this was you, no action is needed.',
      `If it wasn't, change your password now and review your sessions: ${this.link('/account/security')}`,
    ];
    await this.mailer.send({
      to,
      subject: `${this.settings.get('instance.name')}: ${SUBJECTS[event]}`,
      text: lines.join('\n') + '\n',
    });
  }

  /** Alert on sign-ins from an IP this user hasn't signed in from in 90 days (not the first ever). */
  newLoginAlert(userId: string, meta: RequestMeta): void {
    const ip = meta.ip;
    if (!this.settings.get('security.newLoginAlerts') || !ip) return;
    void (async () => {
      const since = new Date(Date.now() - 90 * 86_400_000);
      const prior = and(
        eq(auditLog.action, 'auth.login'),
        eq(auditLog.actorUserId, userId),
        gt(auditLog.at, since),
      );
      const [[any], [sameIp]] = await Promise.all([
        this.db
          .select({ n: count() })
          .from(auditLog)
          .where(and(prior, isNotNull(auditLog.ip))),
        this.db
          .select({ n: count() })
          .from(auditLog)
          .where(and(prior, eq(auditLog.ip, ip))),
      ]);
      // The current login is already audited, so "1" means this is the only one from this IP.
      if ((any?.n ?? 0) > 1 && (sameIp?.n ?? 0) <= 1)
        await this.sendSecurity(userId, 'new_login', meta);
    })().catch((err: unknown) => this.log.warn({ err }, 'login alert failed'));
  }

  async sendLink(
    to: string,
    kind: 'password_reset' | 'email_verify' | 'invite',
    url: string,
    inviter?: string,
  ): Promise<void> {
    const name = this.settings.get('instance.name');
    const content = {
      password_reset: {
        subject: `${name}: reset your password`,
        body: `Someone asked to reset the password for your ${name} account.\n\nReset it here (valid for 30 minutes, works once):\n${url}\n\nIf you didn't ask for this, ignore this email. Your password stays the same.`,
      },
      email_verify: {
        subject: `${name}: confirm your email address`,
        body: `Confirm this address for your ${name} account (valid for 24 hours):\n${url}\n\nIf you didn't add this address, ignore this email.`,
      },
      invite: {
        subject: `You're invited to ${name}`,
        body: `${inviter ?? 'An administrator'} invited you to ${name}, a task manager.\n\nCreate your account here:\n${url}`,
      },
    }[kind];
    await this.mailer.send({ to, subject: content.subject, text: content.body + '\n' });
  }
}
