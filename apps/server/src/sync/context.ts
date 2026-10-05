import type { CommandError } from '@bokydo/shared';
import { sql } from 'drizzle-orm';
import type { Database } from '../db/client.js';
import { changes } from '../db/schema.js';

/** All sync writers take this lock, so `changes.seq` is committed strictly in order (ADR 0003). */
export const WRITE_LOCK = sql`select pg_advisory_xact_lock(hashtext('bokydo:sync-write'))`;

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** A command was rejected. `not_found` is used for anything the user can't see (no existence leak). */
export class CommandFailure extends Error {
  constructor(
    readonly code: CommandError,
    message?: string,
  ) {
    super(message ?? code);
  }
}

export const fail = (code: CommandError, message?: string): never => {
  throw new CommandFailure(code, message);
};

type ChangeType =
  | 'projects'
  | 'sections'
  | 'tasks'
  | 'labels'
  | 'filters'
  | 'project_access'
  | 'user'
  | 'invitations';
interface ChangeRow {
  entityType: ChangeType;
  entityId: string;
  projectId: string | null;
  userId: string | null;
}

/** Collects change-log rows for one command; flushed inside the command's transaction. */
export class ChangeRecorder {
  private rows: ChangeRow[] = [];
  readonly projectScopes = new Set<string>();
  readonly userScopes = new Set<string>();

  inProject(entityType: ChangeType, entityId: string, projectId: string): void {
    this.rows.push({ entityType, entityId, projectId, userId: null });
    this.projectScopes.add(projectId);
  }

  forUser(entityType: ChangeType, entityId: string, userId: string): void {
    this.rows.push({ entityType, entityId, projectId: null, userId });
    this.userScopes.add(userId);
  }

  async flush(tx: Tx): Promise<void> {
    if (this.rows.length === 0) return;
    // Chunk to stay well under Postgres' bind-parameter limit on big cascades.
    for (let i = 0; i < this.rows.length; i += 1000) {
      await tx.insert(changes).values(this.rows.slice(i, i + 1000));
    }
  }

  get isEmpty(): boolean {
    return this.rows.length === 0;
  }
}

export interface CommandContext {
  tx: Tx;
  userId: string;
  now: Date;
  changes: ChangeRecorder;
  /** The instance default, for users who haven't chosen a time zone. */
  defaultTimeZone: string;
}

/** Per-instance abuse limits. Generous for real use; they bound storage and cascade sizes. */
export const LIMITS = {
  projectsPerUser: 500,
  projectDepth: 3,
  sectionsPerProject: 500,
  tasksPerProject: 20_000,
  subtaskDepth: 4,
  labelsPerUser: 1000,
  filtersPerUser: 500,
  membersPerProject: 250,
  pendingInvitesPerProject: 100,
} as const;
