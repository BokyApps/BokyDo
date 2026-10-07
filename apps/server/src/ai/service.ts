import {
  AI_FEATURES,
  AI_FEATURE_KEYS,
  aiRoutingSchema,
  providerSupports,
  type AiFeature,
  type AiRouting,
} from '@bokydo/shared';
import { eq } from 'drizzle-orm';
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
import type { AiCredentialStore, CredentialOwner, UsableCredential } from './credentials.js';
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
        err instanceof AiCallError ? err.usage : NO_USAGE,
      );
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
