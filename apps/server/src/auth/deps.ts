import type { Database } from '../db/client.js';
import type { Notifier } from '../email/notifier.js';
import type { AppSecrets } from '../security/app-secrets.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { EventBus } from '../sync/events.js';
import type { FlowStore } from './flows.js';
import type { SessionStore } from './sessions.js';
import type { UserTokenStore } from './user-tokens.js';

export interface AuthDeps {
  db: Database;
  settings: SettingsService;
  sessions: SessionStore;
  events: EventBus;
  flows: FlowStore;
  tokens: UserTokenStore;
  notifier: Notifier;
  secrets: AppSecrets;
  /** Injectable for the breached-password check in tests. */
  fetchImpl?: typeof fetch;
}

/** Encryption context for a user's TOTP secret (binds the ciphertext to that user). */
export const totpContext = (userId: string) => `user:${userId}:totp`;
