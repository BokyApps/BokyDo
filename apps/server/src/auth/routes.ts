import {
  changePasswordRequestSchema,
  loginRequestSchema,
  passkeyVerifySchema,
  reauthRequestSchema,
  recoveryCodeSchema,
  totpCodeSchema,
  type MfaChallenge,
  type MfaMethod,
} from '@bokydo/shared';
import {
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { and, eq, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { audit } from '../audit.js';
import { decryptSecret, isEncryptedValue } from '../crypto/envelope.js';
import { recoveryCodes, users, webauthnCredentials } from '../db/schema.js';
import {
  clearSessionCookies,
  requireSession,
  setSessionCookie,
  useSecureCookies,
} from '../http/access.js';
import { clientMeta, parseBody } from '../http/validation.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import { totpContext, type AuthDeps } from './deps.js';
import { hasSecondFactor, userFactors } from './factors.js';
import { FlowStore, type FlowRow } from './flows.js';
import { issueSession, sessionInfo } from './issue-session.js';
import { validateNewPassword } from './password-check.js';
import { RateLimiter } from './rate-limiter.js';
import { hashRecoveryCode } from './recovery.js';
import { verifyTotp } from './totp.js';
import { relyingParty } from './webauthn.js';

type UserRow = typeof users.$inferSelect;
const MFA_FLOW_TTL_MS = 5 * 60_000;
const always = { setup: 'always' } as const;

export async function registerAuthRoutes(app: FastifyInstance, deps: AuthDeps): Promise<void> {
  const { db, settings, sessions, events, flows, notifier } = deps;
  // Verifying against a real hash when the user doesn't exist keeps response timing uniform.
  const dummyHash = await hashPassword(randomBytes(32).toString('base64url'));
  const perIp = new RateLimiter({
    windowMs: 15 * 60_000,
    maxPerWindow: 30,
    freeFailures: Infinity,
    maxBackoffMs: 0,
  });
  const perAccount = new RateLimiter({
    windowMs: 15 * 60_000,
    maxPerWindow: Infinity,
    freeFailures: 5,
    maxBackoffMs: 15 * 60_000,
  });

  const limited = (
    reply: FastifyReply,
    ...checks: { allowed: boolean; retryAfterSeconds: number }[]
  ) => {
    const blocked = checks.find((c) => !c.allowed);
    if (!blocked) return false;
    reply.header('Retry-After', String(blocked.retryAfterSeconds));
    void reply.status(429).send({ error: 'too_many_requests' });
    return true;
  };
  const sessionUser = (u: UserRow) => ({
    id: u.id,
    username: u.username,
    isAdmin: u.isAdmin,
    mustChangePassword: u.mustChangePassword,
  });
  const loadUser = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0];

  /** The pending MFA flow from the flow cookie, counting an attempt. Sends the error itself. */
  async function mfaFlow(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ flow: FlowRow; user: UserRow } | null> {
    const flow = await flows.byToken('mfa', FlowStore.readCookie(req));
    if (!flow?.userId) {
      void reply.status(401).send({ error: 'mfa_flow_expired' });
      return null;
    }
    if (limited(reply, perAccount.attempt(`mfa:${flow.userId}`))) return null;
    if (!(await flows.attempt(flow))) {
      FlowStore.clearCookie(reply);
      void reply.status(429).send({ error: 'too_many_requests' });
      return null;
    }
    const user = await loadUser(flow.userId);
    if (!user || user.disabledAt) {
      void reply.status(401).send({ error: 'mfa_flow_expired' });
      return null;
    }
    return { flow, user };
  }

  async function mfaFailed(
    reply: FastifyReply,
    req: FastifyRequest,
    user: UserRow,
    method: MfaMethod,
  ) {
    perAccount.failure(`mfa:${user.id}`);
    await audit(db, {
      action: 'auth.mfa_failed',
      actorType: 'user',
      actorUserId: user.id,
      ip: req.ip,
      meta: { method },
    });
    return reply.status(401).send({ error: 'invalid_code' });
  }

  /** Finish a second-factor step: the flow is single-use, then a full session starts. */
  async function completeMfa(
    req: FastifyRequest,
    reply: FastifyReply,
    flow: FlowRow,
    user: UserRow,
    method: 'password+totp' | 'password+recovery' | 'password+passkey',
  ) {
    if (!(await flows.consume(flow.id)))
      return reply.status(401).send({ error: 'mfa_flow_expired' });
    perAccount.success(`mfa:${user.id}`);
    FlowStore.clearCookie(reply);
    return issueSession(deps, req, reply, sessionUser(user), method);
  }

  app.post(
    '/api/v1/auth/login',
    { config: { access: 'public', ...always } },
    async (req, reply) => {
      const body = parseBody(loginRequestSchema, req.body, reply);
      if (!body) return;
      const login = body.username.toLowerCase();
      const accountKey = `login:${login}`;
      if (limited(reply, perIp.attempt(`ip:${req.ip}`), perAccount.attempt(accountKey))) return;

      // Sign in with the username, or with a verified email address.
      const [user] = await db
        .select()
        .from(users)
        .where(
          or(
            eq(sql`lower(${users.username})`, login),
            and(eq(sql`lower(${users.email})`, login), isNotNull(users.emailVerifiedAt)),
          ),
        )
        .limit(1);
      const ok = await verifyPassword(user?.passwordHash ?? dummyHash, body.password);
      if (!user || !ok || user.disabledAt) {
        perAccount.failure(accountKey);
        await audit(db, {
          action: 'auth.login_failed',
          actorType: 'user',
          actorUserId: user?.id ?? null,
          ip: req.ip,
          meta: { username: body.username.slice(0, 64) },
        });
        return reply.status(401).send({ error: 'invalid_credentials' });
      }
      perAccount.success(accountKey);

      const factors = await userFactors(db, user.id);
      if (hasSecondFactor(factors)) {
        const { token } = await flows.create({
          kind: 'mfa',
          userId: user.id,
          ttlMs: MFA_FLOW_TTL_MS,
        });
        FlowStore.setCookie(reply, token, useSecureCookies(req, settings), MFA_FLOW_TTL_MS);
        const methods: MfaMethod[] = [];
        if (factors.passkeys > 0) methods.push('passkey');
        if (factors.totp) methods.push('totp');
        if (factors.recoveryCodesRemaining > 0) methods.push('recovery');
        return { mfaRequired: true, methods } satisfies MfaChallenge;
      }
      return issueSession(deps, req, reply, sessionUser(user), 'password');
    },
  );

  app.post(
    '/api/v1/auth/mfa/totp',
    { config: { access: 'public', ...always } },
    async (req, reply) => {
      const body = parseBody(totpCodeSchema, req.body, reply);
      if (!body) return;
      const ctx = await mfaFlow(req, reply);
      if (!ctx) return;
      const { flow, user } = ctx;
      if (!isEncryptedValue(user.totpSecret)) return mfaFailed(reply, req, user, 'totp');
      const step = verifyTotp(
        decryptSecret(deps.secrets.masterKey, user.totpSecret, totpContext(user.id)),
        body.code,
        Date.now(),
      );
      if (step === null) return mfaFailed(reply, req, user, 'totp');
      // Atomically advance the last-used step: the same code can never be accepted twice.
      const advanced = await db
        .update(users)
        .set({ totpLastStep: step })
        .where(
          and(eq(users.id, user.id), or(isNull(users.totpLastStep), lt(users.totpLastStep, step))),
        )
        .returning({ id: users.id });
      if (advanced.length === 0) return mfaFailed(reply, req, user, 'totp');
      return completeMfa(req, reply, flow, user, 'password+totp');
    },
  );

  app.post(
    '/api/v1/auth/mfa/recovery',
    { config: { access: 'public', ...always } },
    async (req, reply) => {
      const body = parseBody(recoveryCodeSchema, req.body, reply);
      if (!body) return;
      const ctx = await mfaFlow(req, reply);
      if (!ctx) return;
      const { flow, user } = ctx;
      // Single atomic UPDATE: two concurrent uses of one code can't both succeed.
      const used = await db
        .update(recoveryCodes)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(recoveryCodes.userId, user.id),
            eq(recoveryCodes.codeHash, hashRecoveryCode(deps.secrets.sessionKey, body.code)),
            isNull(recoveryCodes.usedAt),
          ),
        )
        .returning({ id: recoveryCodes.id });
      if (used.length === 0) return mfaFailed(reply, req, user, 'recovery');
      await audit(db, {
        action: 'auth.recovery_code_used',
        actorType: 'user',
        actorUserId: user.id,
        ip: req.ip,
      });
      notifier.security(user.id, 'recovery_code_used', clientMeta(req));
      return completeMfa(req, reply, flow, user, 'password+recovery');
    },
  );

  app.post(
    '/api/v1/auth/mfa/passkey/options',
    { config: { access: 'public', ...always } },
    async (req, reply) => {
      const rp = relyingParty(settings);
      if (!rp) return reply.status(409).send({ error: 'passkeys_unavailable' });
      const flow = await flows.byToken('mfa', FlowStore.readCookie(req));
      if (!flow?.userId) return reply.status(401).send({ error: 'mfa_flow_expired' });
      const creds = await db
        .select()
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, flow.userId));
      const options = await generateAuthenticationOptions({
        rpID: rp.id,
        allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
        userVerification: 'preferred',
      });
      await flows.setChallenge(flow.id, options.challenge);
      return options;
    },
  );

  app.post(
    '/api/v1/auth/mfa/passkey',
    { config: { access: 'public', ...always } },
    async (req, reply) => {
      const body = parseBody(passkeyVerifySchema, req.body, reply);
      if (!body) return;
      const ctx = await mfaFlow(req, reply);
      if (!ctx) return;
      const { flow, user } = ctx;
      const verified = await verifyPasskey(body.response, flow, user.id, false);
      if (!verified) return mfaFailed(reply, req, user, 'passkey');
      return completeMfa(req, reply, flow, user, 'password+passkey');
    },
  );

  /** Passwordless sign-in with a discoverable passkey (user verification required). */
  app.post(
    '/api/v1/auth/passkey/options',
    { config: { access: 'public', ...always } },
    async (req, reply) => {
      const rp = relyingParty(settings);
      if (!rp) return reply.status(409).send({ error: 'passkeys_unavailable' });
      if (limited(reply, perIp.attempt(`ip:${req.ip}`))) return;
      const options = await generateAuthenticationOptions({
        rpID: rp.id,
        userVerification: 'required',
      });
      const { token } = await flows.create({
        kind: 'passkey_login',
        challenge: options.challenge,
        ttlMs: MFA_FLOW_TTL_MS,
      });
      FlowStore.setCookie(reply, token, useSecureCookies(req, settings), MFA_FLOW_TTL_MS);
      return options;
    },
  );

  app.post(
    '/api/v1/auth/passkey',
    { config: { access: 'public', ...always } },
    async (req, reply) => {
      const body = parseBody(passkeyVerifySchema, req.body, reply);
      if (!body) return;
      if (limited(reply, perIp.attempt(`ip:${req.ip}`))) return;
      const flow = await flows.byToken('passkey_login', FlowStore.readCookie(req));
      if (!flow || !(await flows.attempt(flow)))
        return reply.status(401).send({ error: 'mfa_flow_expired' });
      const [cred] = await db
        .select()
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.id, body.response.id));
      const user = cred ? await loadUser(cred.userId) : undefined;
      if (
        !cred ||
        !user ||
        user.disabledAt ||
        !(await verifyPasskey(body.response, flow, user.id, true))
      ) {
        await audit(db, {
          action: 'auth.passkey_failed',
          actorType: 'user',
          actorUserId: user?.id ?? null,
          ip: req.ip,
        });
        return reply.status(401).send({ error: 'invalid_credentials' });
      }
      if (!(await flows.consume(flow.id)))
        return reply.status(401).send({ error: 'mfa_flow_expired' });
      FlowStore.clearCookie(reply);
      return issueSession(deps, req, reply, sessionUser(user), 'passkey');
    },
  );

  /**
   * Verify an assertion against the flow's challenge and one of `userId`'s credentials, then
   * advance the signature counter (a counter that goes backwards means a cloned authenticator
   * and is rejected by the library).
   */
  async function verifyPasskey(
    response: unknown,
    flow: FlowRow,
    userId: string,
    requireUserVerification: boolean,
  ): Promise<boolean> {
    const rp = relyingParty(settings);
    const assertion = response as { id: string; response: { userHandle?: string } };
    if (!rp || !flow.challenge) return false;
    const [cred] = await db
      .select()
      .from(webauthnCredentials)
      .where(and(eq(webauthnCredentials.id, assertion.id), eq(webauthnCredentials.userId, userId)));
    if (!cred) return false;
    const handle = assertion.response.userHandle;
    if (handle && handle !== Buffer.from(userId.replace(/-/g, ''), 'hex').toString('base64url'))
      return false;
    try {
      const result = await verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge: flow.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
          counter: cred.counter,
          transports: cred.transports,
        },
        requireUserVerification,
      });
      if (!result.verified) return false;
      await db
        .update(webauthnCredentials)
        .set({
          counter: result.authenticationInfo.newCounter,
          lastUsedAt: new Date(),
          backedUp: result.authenticationInfo.credentialBackedUp,
        })
        .where(eq(webauthnCredentials.id, cred.id));
      return true;
    } catch (err) {
      app.log.info({ err: (err as Error).message }, 'passkey verification failed');
      return false;
    }
  }

  app.post(
    '/api/v1/auth/logout',
    { config: { access: 'restricted', ...always } },
    async (req, reply) => {
      const session = requireSession(req);
      await sessions.revoke(session.id);
      events.closeSession(session.id);
      await audit(db, {
        action: 'auth.logout',
        actorType: 'user',
        actorUserId: session.user.id,
        ip: req.ip,
      });
      clearSessionCookies(reply);
      return reply.status(204).send();
    },
  );

  app.get('/api/v1/auth/session', { config: { access: 'restricted', ...always } }, async (req) =>
    sessionInfo(requireSession(req)),
  );

  /** Re-enter the password to unlock sensitive account changes for a few minutes. */
  app.post(
    '/api/v1/auth/reauth',
    { config: { access: 'restricted', ...always } },
    async (req, reply) => {
      const body = parseBody(reauthRequestSchema, req.body, reply);
      if (!body) return;
      const session = requireSession(req);
      const key = `reauth:${session.user.id}`;
      if (limited(reply, perAccount.attempt(key))) return;
      const user = await loadUser(session.user.id);
      if (!user || !(await verifyPassword(user.passwordHash, body.password))) {
        perAccount.failure(key);
        return reply.status(403).send({ error: 'invalid_credentials' });
      }
      perAccount.success(key);
      await sessions.markReauthenticated(session.id);
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/v1/auth/reauth/passkey/options',
    { config: { access: 'restricted', ...always } },
    async (req, reply) => {
      const rp = relyingParty(settings);
      if (!rp) return reply.status(409).send({ error: 'passkeys_unavailable' });
      const session = requireSession(req);
      const creds = await db
        .select()
        .from(webauthnCredentials)
        .where(eq(webauthnCredentials.userId, session.user.id));
      if (creds.length === 0) return reply.status(409).send({ error: 'no_passkeys' });
      const options = await generateAuthenticationOptions({
        rpID: rp.id,
        allowCredentials: creds.map((c) => ({ id: c.id, transports: c.transports })),
        userVerification: 'required',
      });
      await flows.create({
        kind: 'reauth_passkey',
        sessionId: session.id,
        userId: session.user.id,
        challenge: options.challenge,
        ttlMs: MFA_FLOW_TTL_MS,
      });
      return options;
    },
  );

  app.post(
    '/api/v1/auth/reauth/passkey',
    { config: { access: 'restricted', ...always } },
    async (req, reply) => {
      const body = parseBody(passkeyVerifySchema, req.body, reply);
      if (!body) return;
      const session = requireSession(req);
      const flow = await flows.bySession('reauth_passkey', session.id);
      if (!flow || !(await flows.attempt(flow)))
        return reply.status(401).send({ error: 'mfa_flow_expired' });
      if (!(await verifyPasskey(body.response, flow, session.user.id, true)))
        return reply.status(403).send({ error: 'invalid_credentials' });
      await flows.consume(flow.id);
      await sessions.markReauthenticated(session.id);
      return reply.status(204).send();
    },
  );

  app.post(
    '/api/v1/auth/password',
    { config: { access: 'restricted', ...always } },
    async (req, reply) => {
      const body = parseBody(changePasswordRequestSchema, req.body, reply);
      if (!body) return;
      const current = requireSession(req);
      const key = `password:${current.user.id}`;
      if (limited(reply, perAccount.attempt(key))) return;

      const user = await loadUser(current.user.id);
      if (!user || !(await verifyPassword(user.passwordHash, body.currentPassword))) {
        perAccount.failure(key);
        return reply.status(403).send({ error: 'invalid_credentials' });
      }
      perAccount.success(key);

      const problem = await validateNewPassword(
        settings,
        {
          password: body.newPassword,
          username: user.username,
          currentPassword: body.currentPassword,
        },
        deps.fetchImpl,
      );
      if (problem) return reply.status(400).send({ error: 'weak_password', message: problem });

      await db
        .update(users)
        .set({
          passwordHash: await hashPassword(body.newPassword),
          mustChangePassword: false,
          updatedAt: new Date(),
        })
        .where(eq(users.id, user.id));
      await deps.tokens.invalidate('password_reset', user.id);
      // Every existing session (including this one) is replaced by a fresh one.
      await sessions.revokeAllForUser(user.id);
      events.closeUser(user.id);
      await audit(db, {
        action: 'auth.password_changed',
        actorType: 'user',
        actorUserId: user.id,
        ip: req.ip,
      });
      notifier.security(user.id, 'password_changed', clientMeta(req));
      const { token, session } = await sessions.create(
        { ...sessionUser(user), mustChangePassword: false },
        { ...clientMeta(req), authMethod: current.authMethod },
      );
      setSessionCookie(req, reply, settings, token, session.expiresAt);
      return sessionInfo(session);
    },
  );
}
