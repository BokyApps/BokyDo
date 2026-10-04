import {
  settingDefinitions,
  settingKeys,
  type PublicSettings,
  type SettingKey,
  type Settings,
  type SettingsPatch,
  type SettingValue,
} from '@bokydo/shared';
import { eq, inArray, sql } from 'drizzle-orm';
import { audit } from '../audit.js';
import { decryptSecret, encryptSecret, isEncryptedValue } from '../crypto/envelope.js';
import type { Database } from '../db/client.js';
import { instanceSettings } from '../db/schema.js';
import { SETUP_COMPLETE_KEY } from '../setup/instance-settings.js';

type SecretKey = {
  [K in SettingKey]: (typeof settingDefinitions)[K]['secret'] extends true ? K : never;
}[SettingKey];

const secretContext = (key: string) => `setting:${key}`;

/**
 * Typed, cached access to instance settings. Reads are served from memory; writes go to the
 * database in one transaction, bump the row version, are audited, then refresh the cache.
 * (Single-replica for now; multi-replica cache invalidation via LISTEN/NOTIFY when needed.)
 */
export class SettingsService {
  private values: Map<string, unknown> = new Map();
  private setupComplete = false;

  private constructor(
    private readonly db: Database,
    private readonly kek: Buffer,
    private readonly onInvalid: (key: string) => void,
  ) {}

  static async load(
    db: Database,
    kek: Buffer,
    onInvalid: (key: string) => void = () => undefined,
  ): Promise<SettingsService> {
    const service = new SettingsService(db, kek, onInvalid);
    await service.reload();
    return service;
  }

  async reload(): Promise<void> {
    const rows = await this.db.select().from(instanceSettings);
    const byKey = new Map(rows.map((r) => [r.key, r.value]));
    const next = new Map<string, unknown>();
    for (const key of settingKeys) {
      const def = settingDefinitions[key];
      const stored = byKey.get(key);
      if (stored === undefined) {
        next.set(key, def.default);
      } else if (def.secret) {
        next.set(key, isEncryptedValue(stored) ? stored : null);
      } else {
        const parsed = def.schema.safeParse(stored);
        if (!parsed.success) this.onInvalid(key);
        next.set(key, parsed.success ? parsed.data : def.default);
      }
    }
    this.values = next;
    this.setupComplete = byKey.get(SETUP_COMPLETE_KEY) === true;
  }

  get<K extends Exclude<SettingKey, SecretKey>>(key: K): SettingValue<K> {
    return this.values.get(key) as SettingValue<K>;
  }

  /** Decrypt a secret setting for server-side use only. */
  getSecret(key: SecretKey): string | null {
    const stored = this.values.get(key);
    return isEncryptedValue(stored) ? decryptSecret(this.kek, stored, secretContext(key)) : null;
  }

  isSetupComplete(): boolean {
    return this.setupComplete;
  }

  /** Settings as the admin API exposes them: secrets reduced to `{ isSet }`. */
  toPublic(): PublicSettings {
    const out: Record<string, unknown> = {};
    for (const key of settingKeys) {
      const value = this.values.get(key);
      out[key] = settingDefinitions[key].secret ? { isSet: isEncryptedValue(value) } : value;
    }
    return out as PublicSettings;
  }

  /** Apply an already-validated patch. Returns the keys that actually changed. */
  async update(
    patch: { [K in SettingKey]?: Settings[K] | undefined },
    actor: { userId: string | null; ip: string | null },
  ): Promise<SettingKey[]> {
    const changed: SettingKey[] = [];
    const changes: Record<string, unknown> = {};
    await this.db.transaction(async (tx) => {
      const keys = (Object.keys(patch) as SettingKey[]).filter((k) => patch[k] !== undefined);
      // Lock the affected rows so concurrent admins can't interleave version bumps.
      await tx
        .select({ key: instanceSettings.key })
        .from(instanceSettings)
        .where(inArray(instanceSettings.key, keys))
        .for('update');
      for (const key of keys) {
        const def = settingDefinitions[key];
        const next = patch[key];
        if (def.secret) {
          if (next === null) {
            await tx.delete(instanceSettings).where(eq(instanceSettings.key, key));
          } else {
            await upsert(
              tx,
              key,
              encryptSecret(this.kek, next as string, secretContext(key)),
              actor.userId,
            );
          }
          changed.push(key);
          changes[key] = next === null ? 'cleared' : 'set';
          continue;
        }
        const previous = this.values.get(key);
        if (JSON.stringify(previous) === JSON.stringify(next)) continue;
        await upsert(tx, key, next, actor.userId);
        changed.push(key);
        changes[key] = { from: previous, to: next };
      }
      if (changed.length > 0) {
        await audit(tx, {
          action: 'settings.updated',
          actorType: actor.userId ? 'user' : 'system',
          actorUserId: actor.userId,
          ip: actor.ip,
          meta: { changes },
        });
      }
    });
    await this.reload();
    return changed;
  }

  async markSetupComplete(actor: { userId: string | null; ip: string | null }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await upsert(tx, SETUP_COMPLETE_KEY, true, actor.userId);
      await audit(tx, {
        action: 'setup.completed',
        actorType: actor.userId ? 'user' : 'system',
        actorUserId: actor.userId,
        ip: actor.ip,
      });
    });
    await this.reload();
  }
}

async function upsert(
  tx: Pick<Database, 'insert'>,
  key: string,
  value: unknown,
  userId: string | null,
): Promise<void> {
  await tx
    .insert(instanceSettings)
    .values({ key, value, updatedBy: userId })
    .onConflictDoUpdate({
      target: instanceSettings.key,
      set: {
        value,
        updatedBy: userId,
        updatedAt: new Date(),
        version: sql`${instanceSettings.version} + 1`,
      },
    });
}

export type { SettingsPatch };
