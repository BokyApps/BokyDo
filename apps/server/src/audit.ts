import type { Database } from './db/client.js';
import { newId } from './db/ids.js';
import { auditLog } from './db/schema.js';

export interface AuditEvent {
  action: string;
  actorType: 'system' | 'cli' | 'user';
  actorUserId?: string | null;
  targetType?: string;
  targetId?: string;
  ip?: string | null;
  meta?: Record<string, unknown>;
}

type Inserter = Pick<Database, 'insert'>;

/** Append to the security audit log. Never put secrets or passwords in `meta`. */
export async function audit(db: Inserter, event: AuditEvent): Promise<void> {
  await db.insert(auditLog).values({
    id: newId(),
    actorType: event.actorType,
    actorUserId: event.actorUserId ?? null,
    action: event.action,
    targetType: event.targetType ?? null,
    targetId: event.targetId ?? null,
    ip: event.ip ?? null,
    meta: event.meta ?? {},
  });
}
