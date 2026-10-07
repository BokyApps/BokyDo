import { z } from 'zod';

/**
 * What an API token may do. Shown on the consent screen and the token form, so the
 * descriptions are written for people, not developers.
 */
export const API_SCOPES = {
  sync: 'Full access to your tasks, projects, comments and settings, like the BokyDo app itself',
  'tasks:read': 'See your tasks',
  'tasks:write': 'Add, change, complete and delete your tasks',
  'projects:read': 'See your projects, sections, labels and filters',
  'projects:write': 'Add, change and delete your projects, sections, labels and filters',
  'comments:read': 'See comments on your tasks and projects',
  'comments:write': 'Add, change and delete your comments',
  'ai:use': 'Use AI features on your behalf (may cost money on your or the instance’s keys)',
} as const;
export type ApiScope = keyof typeof API_SCOPES;
export const API_SCOPE_KEYS = Object.keys(API_SCOPES) as ApiScope[];

/** Granted when an OAuth client asks for no particular scope. Never includes `sync` or AI. */
export const DEFAULT_OAUTH_SCOPES: readonly ApiScope[] = [
  'tasks:read',
  'tasks:write',
  'projects:read',
  'comments:read',
  'comments:write',
];

/**
 * Who a token is for: the REST/sync API or the MCP endpoint (OAuth resource indicators,
 * RFC 8707). Personal access tokens work for both.
 */
export type TokenAudience = 'api' | 'mcp';

export const apiScopeSchema = z.enum(API_SCOPE_KEYS as [ApiScope, ...ApiScope[]]);

/** Space-separated scope string (OAuth) → validated, de-duplicated list; null if any is unknown. */
export function parseScopeString(input: string): ApiScope[] | null {
  const parts = input.split(' ').filter(Boolean);
  if (parts.length > API_SCOPE_KEYS.length * 2) return null;
  const out = new Set<ApiScope>();
  for (const p of parts) {
    if (!(API_SCOPE_KEYS as string[]).includes(p)) return null;
    out.add(p as ApiScope);
  }
  return [...out];
}

export const patCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(80),
    scopes: z.array(apiScopeSchema).min(1).max(API_SCOPE_KEYS.length),
    /** Days until it stops working; null = never (not recommended, but integrations need it). */
    expiresInDays: z.number().int().min(1).max(366).nullable(),
  })
  .strict();
export type PatCreate = z.output<typeof patCreateSchema>;

/** A personal access token as listed. The secret itself is only returned once, on creation. */
export interface PersonalAccessToken {
  id: string;
  name: string;
  scopes: ApiScope[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
}

/** An app the user has authorized (all grants of one OAuth client). */
export interface AuthorizedApp {
  clientId: string;
  name: string;
  redirectHosts: string[];
  scopes: ApiScope[];
  firstAuthorizedAt: string;
  lastUsedAt: string | null;
}

/** The official Android app: a first-party OAuth client every instance knows about. */
export const ANDROID_PACKAGE = 'com.bokyapps.bokydo';
export const ANDROID_CLIENT_ID = 'bkdc_bokydo-android-app-001';
export const ANDROID_REDIRECT_URI = `${ANDROID_PACKAGE}:/oauth2redirect`;

/** `GET /.well-known/bokydo`: how apps find this instance's endpoints. */
export interface Discovery {
  app: 'bokydo';
  version: string;
  publicUrl: string;
  oauth: {
    issuer: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    revocationEndpoint: string;
  };
  android: { clientId: string; redirectUri: string; scope: string };
  api: { sync: string; events: string };
}

/** What the consent screen shows about a pending authorization. */
export interface OAuthRequestInfo {
  clientName: string;
  /** Where the browser goes after approval: the one fact about the client we can vouch for. */
  redirectHost: string;
  redirectKind: 'web' | 'loopback' | 'app';
  scopes: ApiScope[];
  audience: TokenAudience;
  registeredAt: string;
  /** Registered by this instance (the official apps), not self-described by the client. */
  verified: boolean;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * Redirect URI rules (OAuth 2.1 / RFC 8252): https anywhere; http only to the loopback interface
 * (native and CLI apps; any port); or a private-use scheme in reverse-domain form
 * (`com.example.app:/callback`) for mobile apps. No fragments, no credentials. Returns the
 * problem, or null when acceptable.
 */
export function redirectUriIssue(input: string): string | null {
  if (input.length > 512) return 'Too long';
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return 'Not a URL';
  }
  if (url.hash || input.includes('#')) return 'Must not contain a fragment';
  if (url.username || url.password) return 'Must not contain credentials';
  if (url.protocol === 'https:') return url.hostname ? null : 'Missing host';
  if (url.protocol === 'http:')
    return LOOPBACK_HOSTS.has(url.hostname) ? null : 'Plain http is only allowed for loopback';
  // Private-use scheme: needs a dot (reverse domain), which also rules out javascript:, data:,
  // file:, vbscript: and friends.
  const scheme = url.protocol.slice(0, -1);
  if (/^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+$/.test(scheme)) return null;
  return 'Unsupported scheme';
}

/** Whether `candidate` matches a registered redirect URI (loopback: any port, RFC 8252 §7.3). */
export function redirectUriMatches(registered: string, candidate: string): boolean {
  if (registered === candidate) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(candidate);
  } catch {
    return false;
  }
  if (a.protocol !== 'http:' || !LOOPBACK_HOSTS.has(a.hostname)) return false;
  return (
    b.protocol === 'http:' &&
    b.hostname === a.hostname &&
    b.pathname === a.pathname &&
    b.search === a.search &&
    !b.username &&
    !b.password &&
    !candidate.includes('#')
  );
}

export function redirectKind(uri: string): OAuthRequestInfo['redirectKind'] {
  const url = new URL(uri);
  if (url.protocol === 'https:') return 'web';
  if (url.protocol === 'http:') return 'loopback';
  return 'app';
}

/** RFC 7591 client registration request (the fields we use; others are ignored). */
export const clientRegistrationSchema = z
  .object({
    redirect_uris: z
      .array(
        z
          .string()
          .max(512)
          .refine((u) => redirectUriIssue(u) === null, 'Invalid redirect URI'),
      )
      .min(1)
      .max(10),
    client_name: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .regex(/^[^\p{Cc}\p{Cf}]*$/u, 'Invalid characters')
      .optional(),
    client_uri: z.string().max(512).optional(),
    token_endpoint_auth_method: z.literal('none').optional(),
    grant_types: z
      .array(z.enum(['authorization_code', 'refresh_token']))
      .max(2)
      .optional(),
    response_types: z.array(z.literal('code')).max(1).optional(),
    scope: z.string().max(500).optional(),
  })
  .loose();
