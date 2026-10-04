import type { AuthMethod, SessionInfo } from '@bokydo/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../audit.js';
import type { Database } from '../db/client.js';
import type { Notifier } from '../email/notifier.js';
import { setSessionCookie } from '../http/access.js';
import { clientMeta } from '../http/validation.js';
import type { SettingsService } from '../settings/settings-service.js';
import type { SessionContext, SessionStore, SessionUserRow } from './sessions.js';

export const sessionInfo = (s: SessionContext): SessionInfo => ({
  user: s.user,
  authMethod: s.authMethod,
  csrfToken: s.csrfToken,
});

/** Start a fully authenticated session: cookie, audit entry, new-device alert. */
export async function issueSession(
  deps: { db: Database; settings: SettingsService; sessions: SessionStore; notifier: Notifier },
  req: FastifyRequest,
  reply: FastifyReply,
  user: Omit<SessionUserRow, 'mustEnrollMfa'>,
  authMethod: AuthMethod,
): Promise<SessionInfo> {
  const meta = clientMeta(req);
  const { token, session } = await deps.sessions.create(user, { ...meta, authMethod });
  await audit(deps.db, {
    action: 'auth.login',
    actorType: 'user',
    actorUserId: user.id,
    ip: req.ip,
    meta: { method: authMethod },
  });
  deps.notifier.newLoginAlert(user.id, meta);
  setSessionCookie(req, reply, deps.settings, token, session.expiresAt);
  return sessionInfo(session);
}
