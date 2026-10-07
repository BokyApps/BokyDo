import {
  AI_PROVIDERS,
  classifyIp,
  credentialIssues,
  isLoopbackHost,
  parseIp,
  type AiCredential,
  type AiCredentialCreate,
  type AiCredentialUpdate,
  type AiProvider,
} from '@bokydo/shared';
import { and, asc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { audit } from '../audit.js';
import { decryptSecret, encryptSecret, isEncryptedValue } from '../crypto/envelope.js';
import type { Database } from '../db/client.js';
import { newId } from '../db/ids.js';
import { aiCredentials } from '../db/schema.js';

/** null = instance (admin-managed) credential; otherwise the owning user's id. */
export type CredentialOwner = string | null;

/** A credential ready to call a provider with. Server-side only, never serialised. */
export interface UsableCredential {
  id: string;
  ownerUserId: string | null;
  provider: AiProvider;
  baseUrl: string;
  apiKey: string | null;
  headers: Record<string, string>;
}

interface StoredSecret {
  apiKey?: string;
  headers?: Record<string, string>;
}

export const MAX_USER_CREDENTIALS = 20;
export const MAX_INSTANCE_CREDENTIALS = 50;

export class CredentialInputError extends Error {
  constructor(readonly issues: { path: string; message: string }[]) {
    super('Invalid credential');
  }
}

export class CredentialLimitError extends Error {}

type Actor = { userId: string; ip: string | null };
type Row = typeof aiCredentials.$inferSelect;

/**
 * The secret is bound to its row and owner as AEAD associated data: a ciphertext copied into
 * another row, or another user's row, does not decrypt.
 */
const secretContext = (id: string, owner: CredentialOwner) =>
  `ai-credential:${id}:${owner ?? 'instance'}`;

const ownedBy = (owner: CredentialOwner): SQL =>
  owner === null ? isNull(aiCredentials.ownerUserId) : eq(aiCredentials.ownerUserId, owner);

/**
 * Save-time address rules. The outbound client enforces the real policy on every connection;
 * this just rejects obviously unusable URLs early with a clear message.
 */
export function baseUrlIssue(owner: CredentialOwner, baseUrl: string | null): string | null {
  if (baseUrl === null) return null;
  const url = new URL(baseUrl);
  const literal = parseIp(url.hostname);
  if (literal && classifyIp(literal) === 'blocked') return 'This address can never be reached';
  if (owner === null) return null;
  // Users' own credentials may only reach the public internet, over https.
  if (url.protocol !== 'https:') return 'Must use https';
  if (isLoopbackHost(url.hostname) || (literal && classifyIp(literal) !== 'public'))
    return 'Private network addresses are only available to instance credentials';
  return null;
}

export class AiCredentialStore {
  constructor(
    private readonly db: Database,
    private readonly kek: Buffer,
  ) {}

  async list(owner: CredentialOwner): Promise<AiCredential[]> {
    const rows = await this.db
      .select()
      .from(aiCredentials)
      .where(ownedBy(owner))
      .orderBy(asc(aiCredentials.createdAt), asc(aiCredentials.id));
    return rows.map(toPublic);
  }

  async create(
    owner: CredentialOwner,
    input: AiCredentialCreate,
    actor: Actor,
  ): Promise<AiCredential> {
    const baseUrl = input.baseUrl ?? null;
    const urlIssue = baseUrlIssue(owner, baseUrl);
    if (urlIssue) throw new CredentialInputError([{ path: 'baseUrl', message: urlIssue }]);
    const id = newId();
    const secret: StoredSecret = {
      ...(input.apiKey ? { apiKey: input.apiKey } : {}),
      ...(input.headers && Object.keys(input.headers).length ? { headers: input.headers } : {}),
    };
    const row = await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`bokydo:ai-credentials:${owner ?? 'instance'}`}))`,
      );
      const [{ n }] = (await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(aiCredentials)
        .where(ownedBy(owner))) as [{ n: number }];
      if (n >= (owner === null ? MAX_INSTANCE_CREDENTIALS : MAX_USER_CREDENTIALS))
        throw new CredentialLimitError();
      const [inserted] = await tx
        .insert(aiCredentials)
        .values({
          id,
          ownerUserId: owner,
          provider: input.provider,
          label: input.label,
          baseUrl,
          secret: this.seal(id, owner, secret),
          hasKey: !!secret.apiKey,
          headerNames: Object.keys(secret.headers ?? {}),
          createdBy: actor.userId,
        })
        .returning();
      await audit(tx, {
        action: 'ai.credential.created',
        actorType: 'user',
        actorUserId: actor.userId,
        targetType: 'ai_credential',
        targetId: id,
        ip: actor.ip,
        meta: { scope: owner === null ? 'instance' : 'user', provider: input.provider },
      });
      if (!inserted) throw new Error('insert returned nothing');
      return inserted;
    });
    return toPublic(row);
  }

  async update(
    owner: CredentialOwner,
    id: string,
    patch: AiCredentialUpdate,
    actor: Actor,
  ): Promise<AiCredential | null> {
    const row = await this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(aiCredentials)
        .where(and(eq(aiCredentials.id, id), ownedBy(owner)))
        .for('update');
      if (!current) return null;
      const provider = current.provider as AiProvider;
      const secret = this.unseal(current);
      if (patch.apiKey !== undefined) {
        if (patch.apiKey === null) delete secret.apiKey;
        else secret.apiKey = patch.apiKey;
      }
      if (patch.headers !== undefined) {
        if (patch.headers === null || Object.keys(patch.headers).length === 0)
          delete secret.headers;
        else secret.headers = patch.headers;
      }
      const baseUrl = patch.baseUrl !== undefined ? patch.baseUrl : current.baseUrl;
      const issues = credentialIssues(provider, {
        baseUrl,
        hasKey: !!secret.apiKey,
        hasHeaders: !!secret.headers,
      });
      const urlIssue = baseUrlIssue(owner, baseUrl);
      if (urlIssue) issues.push({ path: 'baseUrl', message: urlIssue });
      if (issues.length) throw new CredentialInputError(issues);
      const [updated] = await tx
        .update(aiCredentials)
        .set({
          label: patch.label ?? current.label,
          baseUrl,
          secret: this.seal(id, owner, secret),
          hasKey: !!secret.apiKey,
          headerNames: Object.keys(secret.headers ?? {}),
          updatedAt: new Date(),
        })
        .where(eq(aiCredentials.id, id))
        .returning();
      await audit(tx, {
        action: 'ai.credential.updated',
        actorType: 'user',
        actorUserId: actor.userId,
        targetType: 'ai_credential',
        targetId: id,
        ip: actor.ip,
        meta: {
          scope: owner === null ? 'instance' : 'user',
          fields: Object.keys(patch).filter(
            (k) => patch[k as keyof AiCredentialUpdate] !== undefined,
          ),
        },
      });
      if (!updated) throw new Error('update returned nothing');
      return updated;
    });
    return row && toPublic(row);
  }

  async delete(owner: CredentialOwner, id: string, actor: Actor): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const deleted = await tx
        .delete(aiCredentials)
        .where(and(eq(aiCredentials.id, id), ownedBy(owner)))
        .returning({ id: aiCredentials.id });
      if (!deleted.length) return false;
      await audit(tx, {
        action: 'ai.credential.deleted',
        actorType: 'user',
        actorUserId: actor.userId,
        targetType: 'ai_credential',
        targetId: id,
        ip: actor.ip,
        meta: { scope: owner === null ? 'instance' : 'user' },
      });
      return true;
    });
  }

  /** Whether a credential exists with exactly this owner (for routing validation). */
  async owned(owner: CredentialOwner, id: string): Promise<AiProvider | null> {
    const [row] = await this.db
      .select({ provider: aiCredentials.provider })
      .from(aiCredentials)
      .where(and(eq(aiCredentials.id, id), ownedBy(owner)));
    return row ? (row.provider as AiProvider) : null;
  }

  /** Decrypt a credential for a call. Only for server-side use; the result must not be logged. */
  async usable(owner: CredentialOwner, id: string): Promise<UsableCredential | null> {
    const [row] = await this.db
      .select()
      .from(aiCredentials)
      .where(and(eq(aiCredentials.id, id), ownedBy(owner)));
    if (!row || !(row.provider in AI_PROVIDERS)) return null;
    const provider = row.provider as AiProvider;
    const baseUrl = row.baseUrl ?? AI_PROVIDERS[provider].defaultBaseUrl;
    if (!baseUrl) return null;
    const secret = this.unseal(row);
    return {
      id: row.id,
      ownerUserId: row.ownerUserId,
      provider,
      baseUrl,
      apiKey: secret.apiKey ?? null,
      headers: secret.headers ?? {},
    };
  }

  async touch(id: string): Promise<void> {
    await this.db
      .update(aiCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(aiCredentials.id, id));
  }

  private seal(id: string, owner: CredentialOwner, secret: StoredSecret) {
    if (!secret.apiKey && !secret.headers) return null;
    return encryptSecret(this.kek, JSON.stringify(secret), secretContext(id, owner));
  }

  private unseal(row: Row): StoredSecret {
    if (!isEncryptedValue(row.secret)) return {};
    return JSON.parse(
      decryptSecret(this.kek, row.secret, secretContext(row.id, row.ownerUserId)),
    ) as StoredSecret;
  }
}

function toPublic(row: Row): AiCredential {
  return {
    id: row.id,
    scope: row.ownerUserId === null ? 'instance' : 'user',
    provider: row.provider as AiProvider,
    label: row.label,
    baseUrl: row.baseUrl,
    hasKey: row.hasKey,
    headerNames: row.headerNames,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  };
}
