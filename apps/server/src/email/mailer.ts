import nodemailer from 'nodemailer';
import type { SettingsService } from '../settings/settings-service.js';

export class EmailNotConfiguredError extends Error {
  constructor() {
    super('SMTP is not configured');
  }
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

/** Sends mail with the SMTP settings from Admin → Settings → Email (read fresh on every send). */
export class Mailer {
  constructor(private readonly settings: SettingsService) {}

  isConfigured(): boolean {
    return Boolean(this.settings.get('email.smtpHost') && this.settings.get('email.fromAddress'));
  }

  async send(mail: OutgoingEmail): Promise<void> {
    const host = this.settings.get('email.smtpHost');
    const fromAddress = this.settings.get('email.fromAddress');
    if (!host || !fromAddress) throw new EmailNotConfiguredError();
    const security = this.settings.get('email.smtpSecurity');
    const username = this.settings.get('email.smtpUsername');
    const password = this.settings.getSecret('email.smtpPassword');

    const transport = nodemailer.createTransport({
      host,
      port: this.settings.get('email.smtpPort'),
      secure: security === 'tls',
      requireTLS: security === 'starttls',
      ignoreTLS: security === 'none',
      auth: username ? { user: username, pass: password ?? '' } : undefined,
      tls: { minVersion: 'TLSv1.2' },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
    try {
      await transport.sendMail({
        from: { name: this.settings.get('email.fromName'), address: fromAddress },
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } finally {
      transport.close();
    }
  }
}
