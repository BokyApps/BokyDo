import { randomUUID } from 'node:crypto';
import type { AiSignInProvider } from '@bokydo/shared';
import { z } from 'zod';
import type { OutboundFetch } from '../net/outbound.js';

/**
 * Subscription sign-in (W7d, ADR 0017): instead of an API key, a user signs in to their own
 * subscription with the OAuth device flow (RFC 8628). The server asks the provider for a code,
 * the user approves it on the provider's own site, and the server polls for the tokens. Nothing
 * comes back through the browser, so there is no redirect to intercept.
 *
 * Everything here goes through the outbound client with the public-only, https-only policy, and
 * provider responses are parsed strictly: from an error answer only the OAuth `error` code is
 * looked at, and nothing a provider sends is logged or returned to the browser except the user
 * code and a verification link checked to be on the provider's own domain.
 */

/** What a successful sign-in or refresh yields. Server-side only, never serialised. */
export interface SignInTokens {
  accessToken: string;
  /** Null when the provider didn't send one on refresh: the old one stays valid. */
  refreshToken: string | null;
  /** Epoch milliseconds. */
  expiresAt: number;
  /** For the credential's label ("Grok (alice@example.com)"). Display only, never trusted. */
  account: string | null;
  /** The provider's account id, when the sign-in gives one (ChatGPT). Sent back to the provider. */
  accountId?: string | null;
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  /** Where the user approves: always an https page on the provider's own domain. */
  verificationUrl: string;
  intervalSeconds: number;
  expiresInSeconds: number;
}

export type PollResult =
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'denied' }
  | { status: 'expired' }
  | { status: 'done'; tokens: SignInTokens };

/** The sign-in can't be renewed (revoked, expired, password changed): sign in again. */
export class SignInExpiredError extends Error {
  constructor() {
    super('Subscription sign-in expired');
  }
}

/** The provider answered something we don't understand, or not at all. */
export class SignInProviderError extends Error {
  constructor(readonly code: 'unavailable' | 'invalid_response') {
    super(`Sign-in provider ${code}`);
  }
}

export interface SignInProtocol {
  start(fetch: OutboundFetch): Promise<DeviceCode>;
  /**
   * Ask the provider whether the user has approved the code. The whole `DeviceCode` is passed
   * back: some providers need more than the device code to poll (ChatGPT needs the user code).
   */
  poll(fetch: OutboundFetch, code: DeviceCode): Promise<PollResult>;
  refresh(fetch: OutboundFetch, refreshToken: string): Promise<SignInTokens>;
  revoke(fetch: OutboundFetch, refreshToken: string): Promise<void>;
}

const LIMITS = { timeoutMs: 20_000, maxResponseBytes: 64 * 1024 } as const;
/** Tokens travel in an Authorization header: printable ASCII, bounded. */
const token = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[\x21-\x7e]+$/);

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

async function postForm(
  fetch: OutboundFetch,
  url: string,
  fields: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form(fields),
      ...LIMITS,
    });
  } catch {
    throw new SignInProviderError('unavailable');
  }
  if (res.status >= 500 || res.status === 429) {
    res.cancel();
    throw new SignInProviderError('unavailable');
  }
  // OAuth error answers are small JSON objects with an `error` code; we read only that field.
  try {
    return { status: res.status, json: await res.json() };
  } catch {
    throw new SignInProviderError('invalid_response');
  }
}

/**
 * A JSON POST (the Codex device endpoints take JSON, not form fields). The body may be empty:
 * the poll answers 403 with nothing while nobody has approved the code yet.
 */
async function postJson(
  fetch: OutboundFetch,
  url: string,
  body: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(body),
      ...LIMITS,
    });
  } catch {
    throw new SignInProviderError('unavailable');
  }
  if (res.status >= 500 || res.status === 429) {
    res.cancel();
    throw new SignInProviderError('unavailable');
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

/** The claims of an ID token, read without verifying it: display only, never trusted. */
function idTokenClaims(idToken: unknown): Record<string, unknown> | null {
  if (typeof idToken !== 'string') return null;
  const payload = idToken.split('.')[1];
  if (!payload || payload.length > 16_384) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    return claims && typeof claims === 'object' ? claims : null;
  } catch {
    return null;
  }
}

/** Printable ASCII only, so a label or a header can't carry anything else. */
function cleanText(value: unknown, max = 120): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.replace(/[^\x20-\x7e]/g, '').trim();
  return clean ? clean.slice(0, max) : null;
}

/** The `email` (or `name`) claim of an ID token, for display. Not verified, never trusted. */
export function accountFromIdToken(idToken: unknown): string | null {
  const claims = idTokenClaims(idToken);
  if (!claims) return null;
  return cleanText(claims.email ?? claims.name);
}

/**
 * The ChatGPT account id from an ID token (the `https://api.openai.com/auth` claim). The Codex
 * backend wants it in a header, so it has to survive the sign-in; it is never shown.
 */
export function chatgptAccountId(idToken: unknown): string | null {
  const claims = idTokenClaims(idToken);
  const auth = claims?.['https://api.openai.com/auth'];
  if (!auth || typeof auth !== 'object' || Array.isArray(auth)) return null;
  const id = (auth as Record<string, unknown>).chatgpt_account_id;
  return cleanText(id);
}

/** A page on `domain` or one of its subdomains, over https: the only links we show. */
export function providerPage(url: unknown, domain: string): string | null {
  if (typeof url !== 'string' || url.length > 2048) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const onDomain = host === domain || host.endsWith(`.${domain}`);
  if (parsed.protocol !== 'https:' || !onDomain || parsed.username || parsed.password) return null;
  return parsed.toString();
}

const deviceCodeResponse = z.object({
  device_code: token,
  user_code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  interval: z.number().int().min(1).max(60).optional(),
  expires_in: z.number().int().min(30).max(3600).optional(),
});

const tokenResponse = z.object({
  access_token: token,
  refresh_token: token.optional(),
  expires_in: z
    .number()
    .int()
    .min(30)
    .max(90 * 86_400),
  id_token: z.string().max(16_384).optional(),
});

const oauthError = z.object({ error: z.string().max(100) });
const oauthErrorObject = z.object({
  error: z.object({ code: z.string().max(100).optional() }).loose(),
});

/**
 * The OAuth error code of an answer, if it has one. Providers write it as a string
 * (`{"error":"invalid_grant"}`) or as an object (`{"error":{"code":"invalid_grant"}}`).
 */
export function oauthErrorCode(json: unknown): string | null {
  const asString = oauthError.safeParse(json);
  if (asString.success) return asString.data.error;
  const asObject = oauthErrorObject.safeParse(json);
  if (asObject.success) return asObject.data.error.code ?? null;
  return null;
}

function tokensFrom(json: unknown, now: number): SignInTokens {
  const parsed = tokenResponse.safeParse(json);
  if (!parsed.success) throw new SignInProviderError('invalid_response');
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? null,
    expiresAt: now + parsed.data.expires_in * 1000,
    account: accountFromIdToken(parsed.data.id_token),
  };
}

/**
 * xAI (SuperGrok / X Premium): the public client of xAI's own Grok CLI, which third-party agents
 * also use, against auth.x.ai's published endpoints. Only the scopes a model call needs: no
 * API-key, billing or workspace scopes.
 */
export const XAI_SIGN_IN = {
  issuer: 'https://auth.x.ai',
  domain: 'x.ai',
  clientId: 'b1a00492-073a-47ea-816f-4c329264a828',
  scope: 'openid profile email offline_access grok-cli:access api:access',
} as const;

export const xaiProtocol: SignInProtocol = {
  async start(fetch) {
    const { status, json } = await postForm(fetch, `${XAI_SIGN_IN.issuer}/oauth2/device/code`, {
      client_id: XAI_SIGN_IN.clientId,
      scope: XAI_SIGN_IN.scope,
    });
    const parsed = deviceCodeResponse.safeParse(json);
    if (status !== 200 || !parsed.success) throw new SignInProviderError('invalid_response');
    const d = parsed.data;
    // Prefer the link with the code filled in; either must be on x.ai, over https.
    const verificationUrl =
      providerPage(d.verification_uri_complete, XAI_SIGN_IN.domain) ??
      providerPage(d.verification_uri, XAI_SIGN_IN.domain);
    if (!verificationUrl) throw new SignInProviderError('invalid_response');
    return {
      deviceCode: d.device_code,
      userCode: d.user_code,
      verificationUrl,
      intervalSeconds: Math.max(5, d.interval ?? 5),
      expiresInSeconds: Math.min(900, d.expires_in ?? 900),
    };
  },

  async poll(fetch, code) {
    const now = Date.now();
    const { status, json } = await postForm(fetch, `${XAI_SIGN_IN.issuer}/oauth2/token`, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.deviceCode,
      client_id: XAI_SIGN_IN.clientId,
    });
    if (status === 200) return { status: 'done', tokens: tokensFrom(json, now) };
    switch (oauthErrorCode(json) ?? '') {
      case 'authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return { status: 'slow_down' };
      case 'access_denied':
        return { status: 'denied' };
      case 'expired_token':
        return { status: 'expired' };
      default:
        throw new SignInProviderError('invalid_response');
    }
  },

  async refresh(fetch, refreshToken) {
    const now = Date.now();
    const { status, json } = await postForm(fetch, `${XAI_SIGN_IN.issuer}/oauth2/token`, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: XAI_SIGN_IN.clientId,
    });
    if (status === 200) return tokensFrom(json, now);
    const error = oauthErrorCode(json);
    // invalid_grant: revoked, expired or rotated away. Anything else may be temporary.
    if (status === 400 || status === 401) {
      if (error === null || error === 'invalid_grant') throw new SignInExpiredError();
    }
    throw new SignInProviderError('invalid_response');
  },

  async revoke(fetch, refreshToken) {
    // RFC 7009: revoking the refresh token ends the grant. Best effort: the caller ignores errors.
    await postForm(fetch, `${XAI_SIGN_IN.issuer}/oauth2/revoke`, {
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: XAI_SIGN_IN.clientId,
    });
  },
};

/**
 * OpenAI (ChatGPT Plus/Pro): the device flow of OpenAI's own Codex CLI, against
 * auth.openai.com. The user asks for a code, approves it on OpenAI's page, and the server
 * exchanges the authorization code for the tokens. The user has to switch "device code sign-in"
 * on in their ChatGPT security settings first; without it the provider answers 404.
 */
export const CODEX_SIGN_IN = {
  issuer: 'https://auth.openai.com',
  domain: 'openai.com',
  clientId: 'app_EMoamEEZ73f0CkXaXp7hrann',
  redirectUri: 'https://auth.openai.com/deviceauth/callback',
} as const;

/** The Codex flow lasts 15 minutes; the CLI gives up after that. */
const CODEX_FLOW_SECONDS = 15 * 60;

const codexUserCode = z.object({
  device_auth_id: token,
  user_code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/)
    .optional(),
  usercode: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9-]+$/)
    .optional(),
  interval: z.union([z.number(), z.string()]).optional(),
});

const codexApproved = z.object({
  authorization_code: token,
  code_verifier: z
    .string()
    .min(1)
    .max(1024)
    .regex(/^[A-Za-z0-9._~-]+$/),
});

const codexTokenResponse = z.object({
  access_token: token,
  refresh_token: token.optional(),
  id_token: z.string().max(16_384).optional(),
  /** An hour when the provider doesn't say: the Codex tokens last that long. */
  expires_in: z
    .number()
    .int()
    .min(30)
    .max(90 * 86_400)
    .optional(),
});

function codexTokens(json: unknown, now: number): SignInTokens {
  const parsed = codexTokenResponse.safeParse(json);
  if (!parsed.success) throw new SignInProviderError('invalid_response');
  const d = parsed.data;
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token ?? null,
    expiresAt: now + (d.expires_in ?? 3600) * 1000,
    account: accountFromIdToken(d.id_token),
    accountId: chatgptAccountId(d.id_token),
  };
}

/** The provider's own page where the user approves the code. */
const codexVerificationUrl = providerPage(
  `${CODEX_SIGN_IN.issuer}/codex/device`,
  CODEX_SIGN_IN.domain,
);

export const openaiProtocol: SignInProtocol = {
  async start(fetch) {
    const { status, json } = await postJson(
      fetch,
      `${CODEX_SIGN_IN.issuer}/api/accounts/deviceauth/usercode`,
      { client_id: CODEX_SIGN_IN.clientId },
    );
    const parsed = codexUserCode.safeParse(json);
    if (status !== 200 || !parsed.success) throw new SignInProviderError('invalid_response');
    const d = parsed.data;
    const userCode = d.user_code ?? d.usercode;
    if (!userCode || !codexVerificationUrl) throw new SignInProviderError('invalid_response');
    const interval = typeof d.interval === 'number' ? d.interval : Number(d.interval ?? 5);
    return {
      deviceCode: d.device_auth_id,
      userCode,
      verificationUrl: codexVerificationUrl,
      intervalSeconds: Math.min(60, Math.max(3, Number.isFinite(interval) ? interval : 5)),
      expiresInSeconds: CODEX_FLOW_SECONDS,
    };
  },

  async poll(fetch, code) {
    const now = Date.now();
    const { status, json } = await postJson(
      fetch,
      `${CODEX_SIGN_IN.issuer}/api/accounts/deviceauth/token`,
      { device_auth_id: code.deviceCode, user_code: code.userCode },
    );
    if (status === 200) {
      const approved = codexApproved.safeParse(json);
      if (!approved.success) throw new SignInProviderError('invalid_response');
      // The authorization code is exchanged for the tokens right away.
      const exchanged = await postForm(fetch, `${CODEX_SIGN_IN.issuer}/oauth/token`, {
        grant_type: 'authorization_code',
        code: approved.data.authorization_code,
        client_id: CODEX_SIGN_IN.clientId,
        code_verifier: approved.data.code_verifier,
        redirect_uri: CODEX_SIGN_IN.redirectUri,
      });
      if (exchanged.status !== 200) throw new SignInProviderError('invalid_response');
      return { status: 'done', tokens: codexTokens(exchanged.json, now) };
    }
    // Not approved yet: the endpoint answers 403 (or 404) until the user enters the code.
    if (status === 403 || status === 404) return { status: 'pending' };
    switch (oauthErrorCode(json) ?? '') {
      case 'authorization_pending':
      case 'deviceauth_authorization_pending':
        return { status: 'pending' };
      case 'slow_down':
        return { status: 'slow_down' };
      case 'access_denied':
      case 'denied':
        return { status: 'denied' };
      default:
        throw new SignInProviderError('invalid_response');
    }
  },

  async refresh(fetch, refreshToken) {
    const now = Date.now();
    const { status, json } = await postForm(fetch, `${CODEX_SIGN_IN.issuer}/oauth/token`, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_SIGN_IN.clientId,
    });
    if (status === 200) return codexTokens(json, now);
    const error = oauthErrorCode(json);
    // invalid_grant: the grant was revoked or rotated away. Anything else may be temporary.
    if (status === 400 || status === 401) {
      if (error === null || error === 'invalid_grant') throw new SignInExpiredError();
    }
    throw new SignInProviderError('invalid_response');
  },

  async revoke(fetch, refreshToken) {
    // RFC 7009: revoking the refresh token ends the grant. Best effort: the caller ignores
    // errors, and OpenAI may not offer revocation for this client at all. The Codex CLI sends
    // this as JSON, so we do too.
    await postJson(fetch, `${CODEX_SIGN_IN.issuer}/oauth/revoke`, {
      token: refreshToken,
      token_type_hint: 'refresh_token',
      client_id: CODEX_SIGN_IN.clientId,
    });
  },
};

export const SIGN_IN_PROTOCOLS: Record<AiSignInProvider, SignInProtocol> = {
  'xai-subscription': xaiProtocol,
  'chatgpt-subscription': openaiProtocol,
};

/** Refresh this long before expiry, so a call never starts with a token about to lapse. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

interface PendingFlow {
  id: string;
  userId: string;
  provider: AiSignInProvider;
  /** Re-sign-in of an existing credential (keeps its id and routes), or a new one. */
  credentialId: string | null;
  /** The provider's code and user code: both are needed to poll. */
  code: DeviceCode;
  intervalMs: number;
  nextPollAt: number;
  expiresAt: number;
}

export type FlowPoll =
  | { status: 'pending' }
  | { status: 'denied' | 'expired' | 'unavailable' }
  | {
      status: 'done';
      tokens: SignInTokens;
      provider: AiSignInProvider;
      credentialId: string | null;
    };

/**
 * Sign-ins in progress, in memory (they last minutes; a restart just means starting again).
 * One per user; each flow belongs to the user who started it. The browser drives the polling,
 * but the server decides when the provider is actually asked, at the provider's own pace.
 */
export class SignInFlows {
  private readonly flows = new Map<string, PendingFlow>();
  static readonly MAX_FLOWS = 500;

  constructor(
    private readonly fetchFor: () => OutboundFetch,
    private readonly protocols: Record<AiSignInProvider, SignInProtocol> = SIGN_IN_PROTOCOLS,
    private readonly now: () => number = Date.now,
  ) {}

  async start(
    userId: string,
    provider: AiSignInProvider,
    credentialId: string | null,
  ): Promise<{
    flowId: string;
    userCode: string;
    verificationUrl: string;
    expiresAt: string;
    intervalSeconds: number;
  }> {
    this.purge();
    for (const f of this.flows.values()) if (f.userId === userId) this.flows.delete(f.id);
    if (this.flows.size >= SignInFlows.MAX_FLOWS) throw new SignInProviderError('unavailable');
    const code = await this.protocols[provider].start(this.fetchFor());
    const now = this.now();
    const flow: PendingFlow = {
      id: randomUUID(),
      userId,
      provider,
      credentialId,
      code,
      intervalMs: code.intervalSeconds * 1000,
      // The first check may come at once (nobody approves that fast; it costs one request);
      // after that, at the provider's interval.
      nextPollAt: now,
      expiresAt: now + code.expiresInSeconds * 1000,
    };
    this.flows.set(flow.id, flow);
    return {
      flowId: flow.id,
      userCode: code.userCode,
      verificationUrl: code.verificationUrl,
      expiresAt: new Date(flow.expiresAt).toISOString(),
      intervalSeconds: code.intervalSeconds,
    };
  }

  /** null: no such flow for this user. */
  async poll(userId: string, flowId: string): Promise<FlowPoll | null> {
    const flow = this.flows.get(flowId);
    if (!flow || flow.userId !== userId) return null;
    const now = this.now();
    if (now >= flow.expiresAt) {
      this.flows.delete(flowId);
      return { status: 'expired' };
    }
    // Asked too early: answer from here instead of hammering the provider.
    if (now < flow.nextPollAt) return { status: 'pending' };
    flow.nextPollAt = now + flow.intervalMs;
    let result: PollResult;
    try {
      result = await this.protocols[flow.provider].poll(this.fetchFor(), flow.code);
    } catch {
      return { status: 'unavailable' };
    }
    switch (result.status) {
      case 'pending':
        return { status: 'pending' };
      case 'slow_down':
        flow.intervalMs += 5000;
        flow.nextPollAt = now + flow.intervalMs;
        return { status: 'pending' };
      case 'done':
        this.flows.delete(flowId);
        return {
          status: 'done',
          tokens: result.tokens,
          provider: flow.provider,
          credentialId: flow.credentialId,
        };
      default:
        this.flows.delete(flowId);
        return { status: result.status };
    }
  }

  cancel(userId: string, flowId: string): boolean {
    const flow = this.flows.get(flowId);
    if (!flow || flow.userId !== userId) return false;
    return this.flows.delete(flowId);
  }

  private purge(): void {
    const now = this.now();
    for (const [id, f] of this.flows) if (now >= f.expiresAt) this.flows.delete(id);
  }
}
