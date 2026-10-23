import { randomUUID } from 'node:crypto';
import { AI_PROVIDERS, type AiDialect } from '@bokydo/shared';
import { z } from 'zod';
import { OutboundError, type OutboundFetch } from '../net/outbound.js';
import type { UsableCredential } from './credentials.js';

/**
 * Everything a provider call needs. Adapters get the outbound client for the credential's
 * scope (public-only for users' keys) and must not use any other way to reach the network.
 */
export interface AiCallContext {
  credential: UsableCredential;
  model: string;
  fetch: OutboundFetch;
  signal?: AbortSignal;
}

/**
 * The ChatGPT backend (`chatgpt.com/backend-api/codex`) is not a documented API: it only knows
 * the official Codex CLI. It wants the client's identity (`originator`, `user-agent`) and a
 * session id; a request without them is refused. W7d, experimental: the owner checks this
 * against OpenAI's terms before letting anyone in.
 */
const CODEX_ORIGINATOR = 'codex_cli_rs';
const CODEX_USER_AGENT = 'codex_cli_rs/0.0.0 (BokyDo) unknown';

/** Request headers for a dialect: custom headers first, so the API key always wins. */
export function authHeaders(credential: UsableCredential): Record<string, string> {
  const dialect: AiDialect = AI_PROVIDERS[credential.provider].dialect;
  const auth: Record<string, string> = {};
  if (credential.apiKey) {
    if (dialect === 'openai' || dialect === 'responses')
      auth.authorization = `Bearer ${credential.apiKey}`;
    if (dialect === 'anthropic') auth['x-api-key'] = credential.apiKey;
    // Header, not the ?key= query parameter: URLs end up in proxy and server logs.
    if (dialect === 'gemini') auth['x-goog-api-key'] = credential.apiKey;
  }
  if (dialect === 'anthropic') auth['anthropic-version'] = '2023-06-01';
  if (dialect === 'responses') {
    // The ChatGPT (Codex) backend: the account the token belongs to, the beta the Responses
    // API is behind, and who is calling.
    if (credential.accountId) auth['chatgpt-account-id'] = credential.accountId;
    auth['openai-beta'] = 'responses=experimental';
    auth.originator = CODEX_ORIGINATOR;
    auth['user-agent'] = CODEX_USER_AGENT;
    // One session per call: the backend ties a conversation to it.
    auth.session_id = randomUUID();
  }
  return { ...credential.headers, ...auth, accept: 'application/json' };
}

export type TestResult =
  { ok: true; models: string[] } | { ok: false; error: string; status?: number };

const MAX_MODELS = 500;
const modelId = z.string().min(1).max(200);
const openAiModels = z.object({ data: z.array(z.object({ id: modelId }).loose()) }).loose();
const geminiModels = z
  .object({ models: z.array(z.object({ name: modelId }).loose()).optional() })
  .loose();
/** The ChatGPT (Codex) backend lists its models as `{models: [{slug}]}`. */
const codexModels = z.object({ models: z.array(z.object({ slug: modelId }).loose()) }).loose();

/**
 * "Test connection": list the provider's models with the stored credential. Also the live model
 * list for the routing UI. Errors are reduced to a code (and HTTP status); the provider's response
 * body is never passed back, so nothing it echoes (including keys) can leak through.
 */
export async function listModels(ctx: Omit<AiCallContext, 'model'>): Promise<TestResult> {
  const { credential } = ctx;
  const dialect = AI_PROVIDERS[credential.provider].dialect;
  try {
    const res = await ctx.fetch(`${credential.baseUrl}/models`, {
      headers: authHeaders(credential),
      timeoutMs: 15_000,
      maxResponseBytes: 2 * 1024 * 1024,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    if (res.status === 401 || res.status === 403) {
      res.cancel();
      return { ok: false, error: 'unauthorized', status: res.status };
    }
    if (res.status < 200 || res.status >= 300) {
      res.cancel();
      return { ok: false, error: 'unexpected_status', status: res.status };
    }
    const body = await res.json();
    let ids: string[];
    if (dialect === 'gemini') {
      const parsed = geminiModels.safeParse(body);
      if (!parsed.success) return { ok: false, error: 'invalid_response' };
      ids = (parsed.data.models ?? []).map((m) => m.name.replace(/^models\//, ''));
    } else if (dialect === 'responses') {
      const parsed = codexModels.safeParse(body);
      if (!parsed.success) return { ok: false, error: 'invalid_response' };
      ids = parsed.data.models.map((m) => m.slug);
    } else {
      const parsed = openAiModels.safeParse(body);
      if (!parsed.success) return { ok: false, error: 'invalid_response' };
      ids = parsed.data.data.map((m) => m.id);
    }
    return { ok: true, models: [...new Set(ids)].sort().slice(0, MAX_MODELS) };
  } catch (err) {
    if (err instanceof OutboundError) return { ok: false, error: err.reason };
    throw err;
  }
}
