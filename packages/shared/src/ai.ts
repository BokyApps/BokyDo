import { z } from 'zod';
import { parseCidr } from './ip.js';

/** What a model can do. Features ask for a capability; the router picks a configured model. */
export const AI_CAPABILITIES = [
  'chat.structured',
  'chat.long',
  'stt.batch',
  'audio.realtime',
  'embeddings',
  'decision',
] as const;
export type AiCapability = (typeof AI_CAPABILITIES)[number];

/** Every AI feature and the capability it needs (PLAN §5.3–5.4). */
export const AI_FEATURES = {
  'ramble.extract': 'chat.structured',
  'ramble.transcribe': 'stt.batch',
  'ramble.live': 'audio.realtime',
  'assist.task': 'chat.structured',
  'assist.filter': 'chat.structured',
  'smart-add': 'chat.structured',
  reports: 'chat.long',
  ask: 'chat.long',
  embeddings: 'embeddings',
  decision: 'decision',
} as const satisfies Record<string, AiCapability>;
export type AiFeature = keyof typeof AI_FEATURES;
export const AI_FEATURE_KEYS = Object.keys(AI_FEATURES) as AiFeature[];

/** Wire protocol a provider speaks. Adapters are written per dialect, not per vendor. */
export type AiDialect = 'openai' | 'anthropic' | 'gemini';

export interface AiProviderInfo {
  name: string;
  dialect: AiDialect;
  /** fixed: always `defaultBaseUrl`; required: the credential must give one. */
  baseUrl: 'fixed' | 'required';
  defaultBaseUrl: string | null;
  /**
   * `sign-in`: no key; the user signs in to their own subscription (device flow, W7d) and the
   * server keeps the tokens. Such credentials are personal: never instance-wide (ADR 0017).
   */
  apiKey: 'required' | 'optional' | 'sign-in';
  /** Extra request headers (gateways that need them). Only for custom endpoints. */
  customHeaders: boolean;
  capabilities: readonly AiCapability[];
}

const CHAT = ['chat.structured', 'chat.long'] as const;

/**
 * Providers BokyDo can call. Subscription sign-in providers (`apiKey: 'sign-in'`) are
 * experimental and switched on by the admin; more API-key providers are a catalog entry each
 * when they speak one of the dialects.
 */
export const AI_PROVIDERS = {
  openai: {
    name: 'OpenAI',
    dialect: 'openai',
    baseUrl: 'fixed',
    defaultBaseUrl: 'https://api.openai.com/v1',
    apiKey: 'required',
    customHeaders: false,
    capabilities: [...CHAT, 'stt.batch', 'audio.realtime', 'embeddings'],
  },
  anthropic: {
    name: 'Anthropic',
    dialect: 'anthropic',
    baseUrl: 'fixed',
    defaultBaseUrl: 'https://api.anthropic.com/v1',
    apiKey: 'required',
    customHeaders: false,
    capabilities: CHAT,
  },
  gemini: {
    name: 'Google Gemini',
    dialect: 'gemini',
    baseUrl: 'fixed',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKey: 'required',
    customHeaders: false,
    capabilities: [...CHAT, 'audio.realtime', 'embeddings'],
  },
  xai: {
    name: 'xAI (Grok)',
    dialect: 'openai',
    baseUrl: 'fixed',
    defaultBaseUrl: 'https://api.x.ai/v1',
    apiKey: 'required',
    customHeaders: false,
    capabilities: CHAT,
  },
  'xai-subscription': {
    name: 'Grok (SuperGrok / X Premium sign-in)',
    dialect: 'openai',
    baseUrl: 'fixed',
    defaultBaseUrl: 'https://api.x.ai/v1',
    apiKey: 'sign-in',
    customHeaders: false,
    capabilities: CHAT,
  },
  openrouter: {
    name: 'OpenRouter',
    dialect: 'openai',
    baseUrl: 'fixed',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    apiKey: 'required',
    customHeaders: false,
    capabilities: CHAT,
  },
  groq: {
    name: 'Groq',
    dialect: 'openai',
    baseUrl: 'fixed',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    apiKey: 'required',
    customHeaders: false,
    capabilities: [...CHAT, 'stt.batch'],
  },
  'ollama-cloud': {
    name: 'Ollama Cloud',
    dialect: 'openai',
    baseUrl: 'fixed',
    defaultBaseUrl: 'https://ollama.com/v1',
    apiKey: 'required',
    customHeaders: false,
    capabilities: CHAT,
  },
  ollama: {
    name: 'Ollama (self-hosted)',
    dialect: 'openai',
    baseUrl: 'required',
    defaultBaseUrl: null,
    apiKey: 'optional',
    customHeaders: false,
    capabilities: [...CHAT, 'embeddings'],
  },
  'openai-compatible': {
    name: 'Custom (OpenAI-compatible)',
    dialect: 'openai',
    baseUrl: 'required',
    defaultBaseUrl: null,
    apiKey: 'optional',
    customHeaders: true,
    capabilities: [...CHAT, 'stt.batch', 'embeddings'],
  },
  'anthropic-compatible': {
    name: 'Custom (Anthropic-compatible)',
    dialect: 'anthropic',
    baseUrl: 'required',
    defaultBaseUrl: null,
    apiKey: 'optional',
    customHeaders: true,
    capabilities: CHAT,
  },
} as const satisfies Record<string, AiProviderInfo>;
export type AiProvider = keyof typeof AI_PROVIDERS;
export const AI_PROVIDER_KEYS = Object.keys(AI_PROVIDERS) as AiProvider[];

/** Providers added by signing in to a subscription instead of with a key. */
export type AiSignInProvider = {
  [K in AiProvider]: (typeof AI_PROVIDERS)[K]['apiKey'] extends 'sign-in' ? K : never;
}[AiProvider];
export const AI_SIGN_IN_PROVIDERS = AI_PROVIDER_KEYS.filter(
  (p): p is AiSignInProvider => AI_PROVIDERS[p].apiKey === 'sign-in',
);
export const isSignInProvider = (p: AiProvider): p is AiSignInProvider =>
  AI_PROVIDERS[p].apiKey === 'sign-in';

/**
 * Whether a provider can serve a capability. `decision` falls back to structured chat (an enum
 * plus self-reported confidence) for providers without a dedicated decision model.
 */
export function providerSupports(provider: AiProvider, capability: AiCapability): boolean {
  const caps: readonly AiCapability[] = AI_PROVIDERS[provider].capabilities;
  return (
    caps.includes(capability) || (capability === 'decision' && caps.includes('chat.structured'))
  );
}

/**
 * Normalise a provider base URL: http(s), no credentials, query or fragment; path kept without
 * a trailing slash ("https://host/v1"). Returns null when invalid. Whether the host may be
 * reached is decided at connect time by the server's outbound policy, not here.
 */
export function normalizeAiBaseUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash || !url.hostname) return null;
  let path = url.pathname;
  while (path.endsWith('/')) path = path.slice(0, -1);
  return url.origin + path;
}

const baseUrlSchema = z
  .string()
  .max(2048)
  .transform((v, ctx) => {
    const url = normalizeAiBaseUrl(v);
    if (!url) {
      ctx.addIssue({ code: 'custom', message: 'Must be an http(s) URL such as https://host/v1' });
      return z.NEVER;
    }
    return url;
  });

/** Request headers the transport owns; a credential can't set or override them. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'expect',
  'accept-encoding',
  'cookie',
  'proxy-authorization',
  'proxy-connection',
]);

export const aiHeadersSchema = z
  .record(
    z
      .string()
      .regex(/^[A-Za-z0-9-]{1,64}$/, 'Invalid header name')
      .refine((n) => !RESERVED_HEADERS.has(n.toLowerCase()), 'This header cannot be set'),
    z
      .string()
      .max(2048)
      .regex(/^[\x20-\x7e]*$/, 'Header values must be printable ASCII'),
  )
  .refine((h) => Object.keys(h).length <= 10, 'At most 10 headers')
  .refine(
    (h) => new Set(Object.keys(h).map((k) => k.toLowerCase())).size === Object.keys(h).length,
    'Duplicate header',
  );

/** API keys end up in a request header: printable ASCII, no spaces or line breaks. */
const apiKeySchema = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/, 'Invalid API key');

const labelSchema = z.string().trim().min(1).max(80);

export const aiModelSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, 'Invalid model name');

export const aiCredentialCreateSchema = z
  .object({
    provider: z.enum(AI_PROVIDER_KEYS as [AiProvider, ...AiProvider[]]),
    label: labelSchema,
    baseUrl: baseUrlSchema.nullable().optional(),
    apiKey: apiKeySchema.nullable().optional(),
    headers: aiHeadersSchema.optional(),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const issue of credentialIssues(c.provider, {
      baseUrl: c.baseUrl ?? null,
      hasKey: !!c.apiKey,
      hasHeaders: Object.keys(c.headers ?? {}).length > 0,
    })) {
      ctx.addIssue({ code: 'custom', path: [issue.path], message: issue.message });
    }
  });
export type AiCredentialCreate = z.output<typeof aiCredentialCreateSchema>;

/** PATCH: omitted fields are kept; `apiKey: null` / `headers: null` clear them. */
export const aiCredentialUpdateSchema = z
  .object({
    label: labelSchema.optional(),
    baseUrl: baseUrlSchema.nullable().optional(),
    apiKey: apiKeySchema.nullable().optional(),
    headers: aiHeadersSchema.nullable().optional(),
  })
  .strict()
  .refine((p) => Object.keys(p).length > 0, 'Nothing to change');
export type AiCredentialUpdate = z.output<typeof aiCredentialUpdateSchema>;

/** Field rules that depend on the provider (also re-checked on update, against the result). */
export function credentialIssues(
  provider: AiProvider,
  c: { baseUrl: string | null; hasKey: boolean; hasHeaders: boolean },
): { path: string; message: string }[] {
  const info: AiProviderInfo = AI_PROVIDERS[provider];
  const issues: { path: string; message: string }[] = [];
  if (info.apiKey === 'sign-in') {
    issues.push({ path: 'provider', message: 'Add this provider by signing in' });
    return issues;
  }
  if (info.baseUrl === 'fixed' && c.baseUrl !== null)
    issues.push({ path: 'baseUrl', message: 'This provider has a fixed address' });
  if (info.baseUrl === 'required' && c.baseUrl === null)
    issues.push({ path: 'baseUrl', message: 'A base URL is required' });
  if (info.apiKey === 'required' && !c.hasKey)
    issues.push({ path: 'apiKey', message: 'An API key is required' });
  if (!info.customHeaders && c.hasHeaders)
    issues.push({ path: 'headers', message: 'Custom headers are only for custom endpoints' });
  return issues;
}

/**
 * A stored credential as the API shows it. The key and header values are never returned. For a
 * sign-in provider, `hasKey` means "signed in": false once the sign-in has expired or was revoked.
 */
export interface AiCredential {
  id: string;
  scope: 'instance' | 'user';
  provider: AiProvider;
  label: string;
  baseUrl: string | null;
  hasKey: boolean;
  headerNames: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export const aiRouteSchema = z.object({ credentialId: z.uuid(), model: aiModelSchema }).strict();
export type AiRoute = z.output<typeof aiRouteSchema>;

/** Which credential and model serve each feature. Missing features are switched off. */
export const aiRoutingSchema = z.partialRecord(
  z.enum(AI_FEATURE_KEYS as [AiFeature, ...AiFeature[]]),
  aiRouteSchema,
);
export type AiRouting = z.output<typeof aiRoutingSchema>;

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * An entry in the admin's private-network allow-list: a CIDR ("192.168.1.0/24", "fd00::/8"), a
 * single address, or a hostname ("ollama") whose private addresses may then be reached. Only
 * private ranges can be opened up this way; loopback, link-local and metadata never can.
 */
export const privateAllowlistEntrySchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine(
    (v) =>
      parseCidr(v) !== null ||
      (HOSTNAME.test(v) && !/^[\d.]+$/.test(v) && v !== 'localhost' && !v.endsWith('.localhost')),
    'Must be a CIDR range, IP address or hostname',
  );
