import {
  emailUpdateSchema,
  passkeyRegisterSchema,
  passkeyRenameSchema,
  totpCodeSchema,
  type AccountSecurity,
  type SessionListItem,
  type TotpSetup,
} from '@bokydo/shared';
import { generateRegistrationOptions, verifyRegistrationResponse } from '@simplewebauthn/server';
import { and, count, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import qrcode from 'qrcode-generator';
import { z } from 'zod';
import { audit } from '../audit.js';
import { decryptSecret, encryptSecret, isEncryptedValue } from '../crypto/envelope.js';
import { newId } from '../db/ids.js';
import { recoveryCodes, users, webauthnCredentials } from '../db/schema.js';
import { clearSessionCookies, requireRecentAuth, requireSession } from '../http/access.js';
import { clientMeta, parseBody } from '../http/validation.js';
import { totpContext, type AuthDeps } from '../auth/deps.js';
import { hasSecondFactor, mfaRequiredFor, userFactors } from '../auth/factors.js';
import { generateRecoveryCodes, hashRecoveryCode } from '../auth/recovery.js';
import { generateTotpSecret, otpauthUrl, verifyTotp } from '../auth/totp.js';
import {
  MAX_PASSKEYS_PER_USER,
  relyingParty,
  SUPPORTED_ALGORITHMS,
  userHandle,
} from '../auth/webauthn.js';
import { pgCode } from '../sync/handlers/common.js';

const SETUP_TTL_MS = 10 * 60_000;
const VERIFY_TTL_MS = 24 * 60 * 60_000;
const credentialIdParam = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/) });
const sessionIdParam = z.object({ id: z.uuid() });

/** Account → Security. Enrolment routes are `restricted` so users forced to enrol can reach them. */
export function registerAccountRoutes(app: FastifyInstance, deps: AuthDeps): void {
  const { db, settings, sessions, flows, notifier, events, tokens } = deps;
  const restricted = { config: { access: 'restricted', setup: 'always' } } as const;
  const user = { config: { access: 'user', setup: 'always' } } as const;

  const params = <S extends z.ZodType>(
    schema: S,
    req: FastifyRequest,
    reply: FastifyReply,
  ): z.output<S> | undefined => {
    const parsed = schema.safeParse(req.params);
    if (parsed.success) return parsed.data;
    void reply.status(404).send({ error: 'not_found' });
    return undefined;
  };

  /** Replace all recovery codes; returns the plaintext codes (shown once). */
  async function issueRecoveryCodes(userId: string): Promise<string[]> {
    const codes = generateRecoveryCodes();
    await db.transaction(async (tx) => {
      await tx.delete(recoveryCodes).where(eq(recoveryCodes.userId, userId));
      await tx.insert(recoveryCodes).values(
        codes.map((c) => ({
          id: newId(),
          userId,
          codeHash: hashRecoveryCode(deps.secrets.sessionKey, c),
        })),
      );
    });
    return codes;
  }

  /** Would removing a factor leave a user the policy requires to have MFA with none? */
  async function wouldBreakPolicy(
    userId: string,
    isAdmin: boolean,
    remove: 'totp' | 'passkey',
  ): Promise<boolean> {
    if (!mfaRequiredFor(settings, { isAdmin })) return false;
    const f = await userFactors(db, userId);
    const remaining = remove === 'totp' ? f.passkeys : f.passkeys - 1 + (f.totp ? 1 : 0);
    return remaining <= 0;
  }

  app.get('/api/v1/account/security', restricted, async (req): Promise<AccountSecurity> => {
    const session = requireSession(req);
    const [[u], creds, factors] = await Promise.all([
      db.select().from(users).where(eq(users.id, session.user.id)),
      db.select().from(webauthnCredentials).where(eq(webauthnCredentials.userId, session.user.id)),
      userFactors(db, session.user.id),
    ]);
    return {
      email: u?.email ?? null,
      emailVerified: Boolean(u?.emailVerifiedAt),
      totpEnabled: factors.totp,
      passkeys: creds.map((c) => ({
        id: c.id,
        name: c.name,
        createdAt: c.createdAt.toISOString(),
        lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
        backedUp: c.backedUp,
      })),
      recoveryCodesRemaining: factors.recoveryCodesRemaining,
      mfaRequired: mfaRequiredFor(settings, session.user),
      passkeysAvailable: relyingParty(settings) !== null,
    };
  });

  // ---- Sessions ------------------------------------------------------------------------------

  app.get('/api/v1/account/sessions', user, async (req): Promise<SessionListItem[]> => {
    const session = requireSession(req);
    return (await sessions.list(session.user.id)).map((s) => ({
      id: s.publicId,
      current: s.id === session.id,
      authMethod: s.authMethod as SessionListItem['authMethod'],
      createdAt: s.createdAt.toISOString(),
      lastSeenAt: s.lastSeenAt.toISOString(),
      ip: s.ip,
      userAgent: s.userAgent,
    }));
  });

  app.delete('/api/v1/account/sessions/:id', user, async (req, reply) => {
    const p = params(sessionIdParam, req, reply);
    if (!p) return;
    const session = requireSession(req);
    const revoked = await sessions.revokeByPublicId(session.user.id, p.id);
    if (!revoked) return reply.status(404).send({ error: 'not_found' });
    events.closeSession(revoked);
    await audit(db, {
      action: 'auth.session_revoked',
      actorType: 'user',
      actorUserId: session.user.id,
      ip: req.ip,
    });
    if (revoked === session.id) clearSessionCookies(reply);
    return reply.status(204).send();
  });

  app.post('/api/v1/account/sessions/revoke-others', user, async (req, reply) => {
    const session = requireSession(req);
    await sessions.revokeAllForUser(session.user.id, session.id);
    events.closeUserExcept(session.user.id, session.id);
    await audit(db, {
      action: 'auth.sessions_revoked_others',
      actorType: 'user',
      actorUserId: session.user.id,
      ip: req.ip,
    });
    return reply.status(204).send();
  });

  // ---- Authenticator app (TOTP) ------------------------------------------------------------

  app.post(
    '/api/v1/account/totp/setup',
    restricted,
    async (req, reply): Promise<TotpSetup | undefined> => {
      if (!requireRecentAuth(req, reply)) return;
      const session = requireSession(req);
      if ((await userFactors(db, session.user.id)).totp)
        return reply.status(409).send({ error: 'conflict', message: 'totp_already_enabled' });
      const secret = generateTotpSecret();
      await flows.create({
        kind: 'totp_setup',
        sessionId: session.id,
        userId: session.user.id,
        secret: encryptSecret(deps.secrets.masterKey, secret, `flow:totp_setup:${session.id}`),
        ttlMs: SETUP_TTL_MS,
      });
      const url = otpauthUrl(settings.get('instance.name'), session.user.username, secret);
      const qr = qrcode(0, 'M');
      qr.addData(url);
      qr.make();
      const svg = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
      return {
        secret,
        otpauthUrl: url,
        qrCode: `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`,
      };
    },
  );

  app.post('/api/v1/account/totp/confirm', restricted, async (req, reply) => {
    const body = parseBody(totpCodeSchema, req.body, reply);
    if (!body) return;
    const session = requireSession(req);
    const flow = await flows.bySession('totp_setup', session.id);
    if (!flow || !isEncryptedValue(flow.secret) || !(await flows.attempt(flow))) {
      return reply.status(409).send({ error: 'conflict', message: 'setup_expired' });
    }
    const secret = decryptSecret(
      deps.secrets.masterKey,
      flow.secret,
      `flow:totp_setup:${session.id}`,
    );
    const step = verifyTotp(secret, body.code, Date.now());
    if (step === null) return reply.status(400).send({ error: 'invalid_code' });
    await flows.consume(flow.id);
    await db
      .update(users)
      .set({
        totpSecret: encryptSecret(deps.secrets.masterKey, secret, totpContext(session.user.id)),
        totpEnabledAt: new Date(),
        totpLastStep: step,
        updatedAt: new Date(),
      })
      .where(eq(users.id, session.user.id));
    const factors = await userFactors(db, session.user.id);
    const codes =
      factors.recoveryCodesRemaining === 0 ? await issueRecoveryCodes(session.user.id) : null;
    await audit(db, {
      action: 'auth.totp_enabled',
      actorType: 'user',
      actorUserId: session.user.id,
      ip: req.ip,
    });
    notifier.security(session.user.id, 'totp_enabled', clientMeta(req));
    return { recoveryCodes: codes };
  });

  app.post('/api/v1/account/totp/disable', restricted, async (req, reply) => {
    if (!requireRecentAuth(req, reply)) return;
    const session = requireSession(req);
    if (await wouldBreakPolicy(session.user.id, session.user.isAdmin, 'totp')) {
      return reply.status(409).send({ error: 'conflict', message: 'mfa_required' });
    }
    await db
      .update(users)
      .set({ totpSecret: null, totpEnabledAt: null, totpLastStep: null, updatedAt: new Date() })
      .where(eq(users.id, session.user.id));
    if (!hasSecondFactor(await userFactors(db, session.user.id))) {
      await db.delete(recoveryCodes).where(eq(recoveryCodes.userId, session.user.id));
    }
    await audit(db, {
      action: 'auth.totp_disabled',
      actorType: 'user',
      actorUserId: session.user.id,
      ip: req.ip,
    });
    notifier.security(session.user.id, 'totp_disabled', clientMeta(req));
    return reply.status(204).send();
  });

  app.post('/api/v1/account/recovery-codes', restricted, async (req, reply) => {
    if (!requireRecentAuth(req, reply)) return;
    const session = requireSession(req);
    if (!hasSecondFactor(await userFactors(db, session.user.id))) {
      return reply.status(409).send({ error: 'conflict', message: 'no_second_factor' });
    }
    const codes = await issueRecoveryCodes(session.user.id);
    await audit(db, {
      action: 'auth.recovery_codes_regenerated',
      actorType: 'user',
      actorUserId: session.user.id,
      ip: req.ip,
    });
    notifier.security(session.user.id, 'recovery_codes_regenerated', clientMeta(req));
    return { recoveryCodes: codes };
  });

  // ---- Passkeys ------------------------------------------------------------------------------

  app.post('/api/v1/account/passkeys/options', restricted, async (req, reply) => {
    if (!requireRecentAuth(req, reply)) return;
    const rp = relyingParty(settings);
    if (!rp) return reply.status(409).send({ error: 'passkeys_unavailable' });
    const session = requireSession(req);
    const existing = await db
      .select()
      .from(webauthnCredentials)
      .where(eq(webauthnCredentials.userId, session.user.id));
    if (existing.length >= MAX_PASSKEYS_PER_USER)
      return reply.status(409).send({ error: 'limit_exceeded' });
    const options = await generateRegistrationOptions({
      rpName: rp.name,
      rpID: rp.id,
      userName: session.user.username,
      userID: userHandle(session.user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
      supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
    });
    await flows.create({
      kind: 'passkey_register',
      sessionId: session.id,
      userId: session.user.id,
      challenge: options.challenge,
      ttlMs: SETUP_TTL_MS,
    });
    return options;
  });

  app.post('/api/v1/account/passkeys', restricted, async (req, reply) => {
    const body = parseBody(passkeyRegisterSchema, req.body, reply);
    if (!body) return;
    const rp = relyingParty(settings);
    if (!rp) return reply.status(409).send({ error: 'passkeys_unavailable' });
    const session = requireSession(req);
    const flow = await flows.bySession('passkey_register', session.id);
    if (!flow?.challenge || !(await flows.attempt(flow)))
      return reply.status(409).send({ error: 'conflict', message: 'setup_expired' });
    let info;
    try {
      const result = await verifyRegistrationResponse({
        response: body.response as never,
        expectedChallenge: flow.challenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.id,
        requireUserVerification: false,
        supportedAlgorithmIDs: SUPPORTED_ALGORITHMS,
      });
      if (!result.verified) throw new Error('not verified');
      info = result.registrationInfo;
    } catch (err) {
      req.log.info({ err: (err as Error).message }, 'passkey registration rejected');
      return reply.status(400).send({ error: 'invalid_passkey' });
    }
    await flows.consume(flow.id);
    try {
      await db.insert(webauthnCredentials).values({
        id: info.credential.id,
        userId: session.user.id,
        publicKey: Buffer.from(info.credential.publicKey).toString('base64url'),
        counter: info.credential.counter,
        transports: info.credential.transports ?? [],
        deviceType: info.credentialDeviceType,
        backedUp: info.credentialBackedUp,
        aaguid: info.aaguid,
        name: body.name,
      });
    } catch (err) {
      if (pgCode(err) === '23505')
        return reply.status(409).send({ error: 'conflict', message: 'passkey_already_registered' });
      throw err;
    }
    const factors = await userFactors(db, session.user.id);
    const codes =
      factors.recoveryCodesRemaining === 0 ? await issueRecoveryCodes(session.user.id) : null;
    await audit(db, {
      action: 'auth.passkey_added',
      actorType: 'user',
      actorUserId: session.user.id,
      ip: req.ip,
      meta: { name: body.name },
    });
    notifier.security(session.user.id, 'passkey_added', clientMeta(req));
    return { id: info.credential.id, recoveryCodes: codes };
  });

  app.patch('/api/v1/account/passkeys/:id', restricted, async (req, reply) => {
    const p = params(credentialIdParam, req, reply);
    const body = parseBody(passkeyRenameSchema, req.body, reply);
    if (!p || !body) return;
    const session = requireSession(req);
    const updated = await db
      .update(webauthnCredentials)
      .set({ name: body.name })
      .where(and(eq(webauthnCredentials.id, p.id), eq(webauthnCredentials.userId, session.user.id)))
      .returning({ id: webauthnCredentials.id });
    if (updated.length === 0) return reply.status(404).send({ error: 'not_found' });
    return reply.status(204).send();
  });

  app.delete('/api/v1/account/passkeys/:id', restricted, async (req, reply) => {
    const p = params(credentialIdParam, req, reply);
    if (!p) return;
    if (!requireRecentAuth(req, reply)) return;
    const session = requireSession(req);
    const [owned] = await db
      .select({ n: count() })
      .from(webauthnCredentials)
      .where(
        and(eq(webauthnCredentials.id, p.id), eq(webauthnCredentials.userId, session.user.id)),
      );
    if (!owned?.n) return reply.status(404).send({ error: 'not_found' });
    if (await wouldBreakPolicy(session.user.id, session.user.isAdmin, 'passkey')) {
      return reply.status(409).send({ error: 'conflict', message: 'mfa_required' });
    }
    await db
      .delete(webauthnCredentials)
      .where(
        and(eq(webauthnCredentials.id, p.id), eq(webauthnCredentials.userId, session.user.id)),
      );
    if (!hasSecondFactor(await userFactors(db, session.user.id))) {
      await db
        .delete(recoveryCodes)
        .where(and(eq(recoveryCodes.userId, session.user.id), isNull(recoveryCodes.usedAt)));
    }
    await audit(db, {
      action: 'auth.passkey_removed',
      actorType: 'user',
      actorUserId: session.user.id,
      ip: req.ip,
    });
    notifier.security(session.user.id, 'passkey_removed', clientMeta(req));
    return reply.status(204).send();
  });

  // ---- Email ---------------------------------------------------------------------------------

  app.put('/api/v1/account/email', user, async (req, reply) => {
    const body = parseBody(emailUpdateSchema, req.body, reply);
    if (!body) return;
    if (!requireRecentAuth(req, reply)) return;
    const session = requireSession(req);
    const [before] = await db.select().from(users).where(eq(users.id, session.user.id));
    try {
      await db
        .update(users)
        .set({ email: body.email, emailVerifiedAt: null, updatedAt: new Date() })
        .where(eq(users.id, session.user.id));
    } catch (err) {
      if (pgCode(err) === '23505')
        return reply.status(409).send({ error: 'conflict', message: 'email_taken' });
      throw err;
    }
    await tokens.invalidate('password_reset', session.user.id);
    await audit(db, {
      action: 'user.email_changed',
      actorType: 'user',
      actorUserId: session.user.id,
      ip: req.ip,
    });
    // Tell the *old* verified address, so a hijacker can't silently redirect recovery email.
    if (
      before?.email &&
      before.emailVerifiedAt &&
      before.email.toLowerCase() !== body.email.toLowerCase()
    ) {
      notifier.security(session.user.id, 'email_changed', clientMeta(req), before.email);
    }
    let verificationSent = false;
    if (notifier.canEmail) {
      const { token } = await tokens.create({
        kind: 'email_verify',
        userId: session.user.id,
        email: body.email,
        ttlMs: VERIFY_TTL_MS,
      });
      void notifier
        .sendLink(body.email, 'email_verify', notifier.link('/verify-email', token))
        .catch(() => undefined);
      verificationSent = true;
    }
    return { verificationSent };
  });
}
