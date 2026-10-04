import { inArray } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { projectMembers } from '../db/schema.js';
import type { Affected } from './sync-service.js';

export interface Subscriber {
  userId: string;
  sessionId: string;
  poke(): void;
  close(): void;
}

/**
 * In-process fan-out of "something changed, sync now" hints. Pokes carry no data, so the only way
 * to read anything remains the authorised sync endpoint. (Single replica; Postgres LISTEN/NOTIFY
 * when BokyDo runs several.)
 */
export class EventBus {
  private readonly byUser = new Map<string, Set<Subscriber>>();
  static readonly MAX_STREAMS_PER_USER = 10;

  constructor(private readonly db: Database) {}

  subscribe(sub: Subscriber): (() => void) | null {
    const set = this.byUser.get(sub.userId) ?? new Set();
    if (set.size >= EventBus.MAX_STREAMS_PER_USER) return null;
    set.add(sub);
    this.byUser.set(sub.userId, set);
    return () => {
      set.delete(sub);
      if (set.size === 0) this.byUser.delete(sub.userId);
    };
  }

  /** Called after a command commits. */
  async publish(affected: Affected): Promise<void> {
    const userIds = new Set(affected.userIds);
    if (affected.projectIds.size) {
      const members = await this.db
        .select({ userId: projectMembers.userId })
        .from(projectMembers)
        .where(inArray(projectMembers.projectId, [...affected.projectIds]));
      for (const m of members) userIds.add(m.userId);
    }
    for (const id of userIds) for (const sub of this.byUser.get(id) ?? []) sub.poke();
  }

  closeSession(sessionId: string): void {
    for (const set of this.byUser.values())
      for (const sub of set) if (sub.sessionId === sessionId) sub.close();
  }

  closeUser(userId: string): void {
    for (const sub of this.byUser.get(userId) ?? []) sub.close();
  }

  closeUserExcept(userId: string, keepSessionId: string): void {
    for (const sub of this.byUser.get(userId) ?? [])
      if (sub.sessionId !== keepSessionId) sub.close();
  }

  closeAll(): void {
    for (const set of this.byUser.values()) for (const sub of set) sub.close();
  }

  streamCount(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }
}
