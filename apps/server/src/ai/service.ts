import {
  AI_FEATURES,
  AI_FEATURE_KEYS,
  aiRoutingSchema,
  providerSupports,
  type AiFeature,
  type AiRouting,
} from '@bokydo/shared';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db/client.js';
import { users } from '../db/schema.js';
import {
  allowlistPolicy,
  createOutbound,
  PUBLIC_ONLY,
  type OutboundFetch,
  type Resolver,
} from '../net/outbound.js';
import type { SettingsService } from '../settings/settings-service.js';
import { listModels, type AiCallContext, type TestResult } from './adapters.js';
import {
  chat,
  checkChatRequest,
  promptChars,
  type ChatOptions,
  type ChatRequest,
  type ChatResult,
} from './chat.js';
import type { AiCredentialStore, CredentialOwner, UsableCredential } from './credentials.js';
import {
  checkEmbedRequest,
  checkTranscribeRequest,
  embed,
  transcribe,
  type TranscribeRequest,
} from './media.js';
import { AiProviderError, type TransportOptions } from './transport.js';
import { reserveUsage, settleUsage, type ReportedUsage, type UsageAmounts } from './usage.js';

export class AiNotConfiguredError extends Error {
  constructor(readonly feature: AiFeature) {
    super(`No AI model is configured for ${feature}`);
  }
}

export interface AiUser {
  id: string;
  isAdmin: boolean;
}

export interface ResolvedRoute {
  credential: UsableCredential;
  model: string;
  billing: 'own' | 'instance';
}

export interface AiCall<T> {
  feature: AiFeature;
  /** Worst case: prompt estimate + max output tokens; audio length for speech-to-text. */
  estimate: Partial<UsageAmounts>;
  run(ctx: AiCallContext): Promise<{ result: T; usage: ReportedUsage }>;
  signal?: AbortSignal;
}

/** Thrown by a call's `run` to report what a failed call still consumed. */
export class AiCallError extends Error {
  constructor(
    message: string,
    readonly usage: ReportedUsage,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const NO_USAGE: ReportedUsage = { inputTokens: 0, outputTokens: 0, audioSeconds: 0 };

const addUsage = (a: ReportedUsage, b: ReportedUsage): ReportedUsage => ({
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  audioSeconds: a.audioSeconds + b.audioSeconds,
});

/**
 * Worst-case tokens for a prompt: about two characters per token, which over-reserves for
 * English and stays safe for scripts that tokenise densely. Settled to the real count afterwards.
 */
const promptEstimate = (chars: number) => Math.ceil(chars / 2);

const CHAT_CAPABILITIES = new Set(['chat.structured', 'chat.long', 'decision']);

export interface ChatJsonRequest<T> extends Omit<ChatRequest, 'json' | 'tools' | 'toolChoice'> {
  /** What the reply must parse as. Its JSON Schema (input side) is sent to the model. */
  schema: z.ZodType<T>;
  /** Short name for the schema, e.g. "task_suggestions". */
  name: string;
}

export interface TryResult {
  ok: boolean;
  error?: string;
  status?: number;
  latencyMs?: number;
  /** chat: the start of the reply; embed: the vector length. */
  reply?: string;
  dimensions?: number;
}

/** One second of 16 kHz mono silence as WAV: enough to prove a speech-to-text route works. */
function silentWav(): Buffer {
  const samples = 16_000;
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + samples * 2, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16_000, 24);
  b.writeUInt32LE(32_000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(samples * 2, 40);
  return b;
}

/** JSON Schema for what a model must produce, without the meta key some providers reject. */
export function replySchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

/**
 * Model replies sometimes wrap JSON in a Markdown fence. Plain slicing, not a regex: replies are
 * untrusted and can be megabytes long.
 */
function parseReplyJson(text: string): unknown {
  let body = text.trim();
  if (body.startsWith('```') && body.endsWith('```') && body.length >= 6) {
    const nl = body.indexOf('\n');
    body = nl === -1 ? '' : body.slice(nl + 1, -3);
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Feature → provider/model routing, the network policy per credential scope, and metering.
 * Every AI feature goes through `run`: it picks the route, reserves budget, hands the adapter
 * the right outbound client and settles the usage afterwards.
 */
export class AiService {
  constructor(
    private readonly deps: {
      db: Database;
      settings: SettingsService;
      credentials: AiCredentialStore;
      /** Tests only: replaces DNS for the outbound client. */
      resolver?: Resolver;
      /** Tests only: replaces the retry backoff timer. */
      transport?: TransportOptions;
    },
  ) {}

  /** Whether this user may use the instance's routing (and so its keys and budgets). */
  mayUseInstance(user: AiUser): boolean {
    const access = this.deps.settings.get('ai.instanceAccess');
    return access === 'everyone' || (access === 'admins' && user.isAdmin);
  }

  /**
   * The outbound client for a credential. Users' own credentials only reach the public internet
   * over https; instance credentials may also reach admin-allow-listed private networks.
   */
  outboundFor(owner: CredentialOwner): OutboundFetch {
    const policy =
      owner === null
        ? allowlistPolicy(this.deps.settings.get('network.privateAllowlist'))
        : PUBLIC_ONLY;
    return createOutbound(policy, this.deps.resolver);
  }

  async userRouting(userId: string): Promise<AiRouting> {
    const [row] = await this.deps.db
      .select({ routing: users.aiRouting })
      .from(users)
      .where(eq(users.id, userId));
    const parsed = aiRoutingSchema.safeParse(row?.routing ?? {});
    return parsed.success ? parsed.data : {};
  }

  /**
   * The route a call for `feature` takes: the user's own route if they have one (and own keys
   * are allowed), otherwise the instance route if they may use it. Ownership and capability are
   * re-checked here on every call, whatever the stored routing says.
   */
  async resolve(user: AiUser, feature: AiFeature): Promise<ResolvedRoute | null> {
    const capability = AI_FEATURES[feature];
    if (this.deps.settings.get('ai.userKeys')) {
      const route = (await this.userRouting(user.id))[feature];
      if (route) {
        const credential = await this.deps.credentials.usable(user.id, route.credentialId);
        if (credential && providerSupports(credential.provider, capability))
          return { credential, model: route.model, billing: 'own' };
      }
    }
    if (this.mayUseInstance(user)) {
      const route = this.deps.settings.get('ai.routing')[feature];
      if (route) {
        const credential = await this.deps.credentials.usable(null, route.credentialId);
        if (credential && providerSupports(credential.provider, capability))
          return { credential, model: route.model, billing: 'instance' };
      }
    }
    return null;
  }

  /** Features this user can use right now (for the UI to hide what isn't set up). */
  async availableFeatures(user: AiUser): Promise<AiFeature[]> {
    const out: AiFeature[] = [];
    for (const feature of AI_FEATURE_KEYS) {
      if (await this.resolve(user, feature)) out.push(feature);
    }
    return out;
  }

  budget(): { tokens: number | null; audioSeconds: number | null } {
    const minutes = this.deps.settings.get('ai.monthlyAudioMinutes');
    return {
      tokens: this.deps.settings.get('ai.monthlyTokenBudget'),
      audioSeconds: minutes === null ? null : minutes * 60,
    };
  }

  async run<T>(user: AiUser, call: AiCall<T>): Promise<T> {
    const route = await this.resolve(user, call.feature);
    if (!route) throw new AiNotConfiguredError(call.feature);
    const { credential, model, billing } = route;
    const usageId = await reserveUsage(this.deps.db, {
      userId: user.id,
      credentialId: credential.id,
      billing,
      feature: call.feature,
      provider: credential.provider,
      model,
      estimate: {
        tokens: call.estimate.tokens ?? 0,
        audioSeconds: call.estimate.audioSeconds ?? 0,
      },
      budget: billing === 'instance' ? this.budget() : { tokens: null, audioSeconds: null },
    });
    try {
      const { result, usage } = await call.run({
        credential,
        model,
        fetch: this.outboundFor(credential.ownerUserId),
        ...(call.signal ? { signal: call.signal } : {}),
      });
      await settleUsage(this.deps.db, usageId, 'done', usage);
      await this.deps.credentials.touch(credential.id);
      return result;
    } catch (err) {
      await settleUsage(
        this.deps.db,
        usageId,
        'failed',
        err instanceof AiCallError || err instanceof AiProviderError ? err.usage : NO_USAGE,
      );
      throw err;
    }
  }

  private requireCapability(feature: AiFeature, allowed: (capability: string) => boolean) {
    if (!allowed(AI_FEATURES[feature])) throw new TypeError(`${feature} can't be used this way`);
  }

  /**
   * A chat completion for `feature`, metered against its route. Pass `onText` to stream the
   * reply. Throws AiNotConfiguredError, AiBudgetExceededError or AiProviderError.
   */
  async chat(
    user: AiUser,
    feature: AiFeature,
    request: ChatRequest,
    opts: Omit<ChatOptions, keyof TransportOptions> & { signal?: AbortSignal } = {},
  ): Promise<ChatResult> {
    this.requireCapability(feature, (c) => CHAT_CAPABILITIES.has(c));
    checkChatRequest(request);
    const { signal, ...chatOpts } = opts;
    return this.run(user, {
      feature,
      estimate: { tokens: promptEstimate(promptChars(request)) + request.maxOutputTokens },
      ...(signal ? { signal } : {}),
      run: async (ctx) => {
        const result = await chat(ctx, request, { ...this.deps.transport, ...chatOpts });
        return { result, usage: result.usage };
      },
    });
  }

  /**
   * A structured reply, validated against `schema`. A reply that doesn't validate gets one
   * correction round; after that the call fails with `output_invalid`. A refusal fails with
   * `refused`. Callers still check what the value refers to (ids, permissions): the schema only
   * proves its shape.
   */
  async chatJson<T>(
    user: AiUser,
    feature: AiFeature,
    request: ChatJsonRequest<T>,
    opts: { signal?: AbortSignal; timeoutMs?: number } = {},
  ): Promise<{ value: T; result: ChatResult }> {
    this.requireCapability(feature, (c) => CHAT_CAPABILITIES.has(c));
    const { schema, name, ...rest } = request;
    const base: ChatRequest = { ...rest, json: { name, schema: replySchema(schema) } };
    checkChatRequest(base);
    const { signal, ...chatOpts } = opts;
    return this.run(user, {
      feature,
      // Room for the correction round too.
      estimate: { tokens: 2 * (promptEstimate(promptChars(base)) + base.maxOutputTokens) },
      ...(signal ? { signal } : {}),
      run: async (ctx) => {
        let usage = NO_USAGE;
        const attempt = async (req: ChatRequest) => {
          try {
            const r = await chat(ctx, req, { ...this.deps.transport, ...chatOpts });
            usage = addUsage(usage, r.usage);
            return r;
          } catch (err) {
            if (err instanceof AiProviderError)
              throw new AiProviderError(err.code, err.status, addUsage(usage, err.usage));
            throw err;
          }
        };
        let result = await attempt(base);
        for (let round = 0; ; round++) {
          if (result.stop === 'refused') throw new AiProviderError('refused', undefined, usage);
          const parsed = schema.safeParse(parseReplyJson(result.text));
          if (parsed.success) return { result: { value: parsed.data, result }, usage };
          if (round === 1) throw new AiProviderError('output_invalid', undefined, usage);
          const problems = parsed.error.issues
            .slice(0, 5)
            .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('; ');
          result = await attempt({
            ...base,
            messages: [
              ...base.messages,
              { role: 'assistant', content: result.text.slice(0, 20_000) },
              {
                role: 'user',
                content: `That reply doesn't match the required JSON Schema (${problems.slice(0, 1000)}). Reply again with only the corrected JSON.`,
              },
            ],
          });
        }
      },
    });
  }

  /** Speech to text for `feature` (a speech-to-text route), metered by audio length. */
  async transcribe(
    user: AiUser,
    feature: AiFeature,
    request: TranscribeRequest,
    opts: { signal?: AbortSignal } = {},
  ): Promise<string> {
    this.requireCapability(feature, (c) => c === 'stt.batch');
    checkTranscribeRequest(request);
    return this.run(user, {
      feature,
      estimate: { audioSeconds: Math.ceil(request.durationSeconds) },
      ...(opts.signal ? { signal: opts.signal } : {}),
      run: async (ctx) => {
        const r = await transcribe(ctx, request, this.deps.transport);
        return { result: r.text, usage: r.usage };
      },
    });
  }

  /** Embedding vectors for `texts`, in order. */
  async embed(
    user: AiUser,
    texts: string[],
    opts: { signal?: AbortSignal } = {},
  ): Promise<number[][]> {
    checkEmbedRequest(texts);
    return this.run(user, {
      feature: 'embeddings',
      estimate: { tokens: promptEstimate(texts.reduce((n, t) => n + t.length, 0)) },
      ...(opts.signal ? { signal: opts.signal } : {}),
      run: async (ctx) => {
        const r = await embed(ctx, texts, this.deps.transport);
        return { result: r.vectors, usage: r.usage };
      },
    });
  }

  /**
   * "Try this model": a minimal real call with a stored credential of this owner, so a route can
   * be checked before it's saved. Not metered (it's tiny and rate-limited by the route); the reply
   * is cut short and errors are codes only.
   */
  async tryModel(
    owner: CredentialOwner,
    id: string,
    model: string,
    kind: 'chat' | 'transcribe' | 'embed',
  ): Promise<TryResult | null> {
    const credential = await this.deps.credentials.usable(owner, id);
    if (!credential) return null;
    const capability =
      kind === 'chat' ? 'chat.structured' : kind === 'transcribe' ? 'stt.batch' : 'embeddings';
    if (!providerSupports(credential.provider, capability))
      return { ok: false, error: 'unsupported' };
    const ctx: AiCallContext = { credential, model, fetch: this.outboundFor(owner) };
    const started = Date.now();
    try {
      if (kind === 'chat') {
        const r = await chat(
          ctx,
          {
            messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
            maxOutputTokens: 32,
          },
          { ...this.deps.transport, timeoutMs: 30_000 },
        );
        return { ok: true, latencyMs: Date.now() - started, reply: r.text.trim().slice(0, 100) };
      }
      if (kind === 'transcribe') {
        await transcribe(
          ctx,
          { audio: silentWav(), mimeType: 'audio/wav', durationSeconds: 1 },
          this.deps.transport,
        );
        return { ok: true, latencyMs: Date.now() - started };
      }
      const r = await embed(ctx, ['BokyDo connection test'], this.deps.transport);
      return { ok: true, latencyMs: Date.now() - started, dimensions: r.vectors[0]?.length ?? 0 };
    } catch (err) {
      if (err instanceof AiProviderError)
        return { ok: false, error: err.code, ...(err.status ? { status: err.status } : {}) };
      throw err;
    }
  }

  /** "Test connection" / live model list for a stored credential of this owner. */
  async test(owner: CredentialOwner, id: string): Promise<TestResult | null> {
    const credential = await this.deps.credentials.usable(owner, id);
    if (!credential) return null;
    return listModels({ credential, fetch: this.outboundFor(owner) });
  }
}
