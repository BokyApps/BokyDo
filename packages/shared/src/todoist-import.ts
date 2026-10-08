import { z } from 'zod';
import { idSchema } from './model.js';

/**
 * Granular import from a Todoist account (PLAN W11a). The user pastes their Todoist API token;
 * the server reads the account once (the token is used for that one request and never stored),
 * shows a preview, the user chooses what comes over, sees a dry run, and starts the import. It
 * runs in the background, item by item through ordinary sync commands, and remembers Todoist ids,
 * so running it again only adds what was skipped before.
 */
export const TODOIST_IMPORT_LIMITS = {
  projects: 2000,
  sections: 20_000,
  tasks: 100_000,
  comments: 100_000,
  labels: 2000,
  filters: 500,
  collaborators: 2000,
  /** How long a connected preview stays usable before the user must connect again. */
  sessionMinutes: 30,
} as const;

/** Todoist API tokens are 40 hex characters; allow some slack for other token kinds. */
export const todoistConnectSchema = z
  .object({ token: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/, 'Not a Todoist API token') })
  .strict();

export interface TodoistPreviewProject {
  /** Todoist's id (opaque string). */
  id: string;
  name: string;
  parentId: string | null;
  isInbox: boolean;
  isArchived: boolean;
  isShared: boolean;
  sections: number;
  tasks: number;
  comments: number;
  /** A writable BokyDo project with the same name, offered as the merge target. */
  suggestedMerge: string | null;
  /** Imported before: where it went (its tasks are only added if not imported already). */
  importedAs: string | null;
}

export interface TodoistPreviewLabel {
  id: string;
  name: string;
  /** Tasks carrying it. */
  tasks: number;
  /** The user already has a BokyDo label of this name. */
  exists: boolean;
  /** Not a valid BokyDo label name (spaces, @ or #): tasks keep it out. */
  invalid: boolean;
}

export interface TodoistPreviewFilter {
  id: string;
  name: string;
  query: string;
  /** BokyDo's filter language understands the query. */
  supported: boolean;
  /** Project and label names the query mentions (so unselected ones can be flagged). */
  projects: string[];
  labels: string[];
  importedAs: string | null;
}

export interface TodoistPreviewPerson {
  id: string;
  name: string;
  email: string;
  /** The account being imported (always mapped to you). */
  isYou: boolean;
}

export interface TodoistPreview {
  sessionId: string;
  expiresAt: string;
  account: { name: string; email: string };
  projects: TodoistPreviewProject[];
  labels: TodoistPreviewLabel[];
  filters: TodoistPreviewFilter[];
  people: TodoistPreviewPerson[];
  totals: { projects: number; sections: number; tasks: number; comments: number };
}

/** What to do with each item. Anything not listed is skipped. */
export const todoistImportChoicesSchema = z
  .object({
    sessionId: z.string().regex(/^[A-Za-z0-9_-]{20,64}$/),
    projects: z
      .array(
        z
          .object({
            id: z.string().min(1).max(64),
            action: z.enum(['new', 'merge']),
            /** merge: the BokyDo project to add into. */
            targetId: idSchema.optional(),
            /** new, top-level only: create it in this team (null/absent = personal). */
            workspaceId: idSchema.nullable().optional(),
          })
          .strict()
          .refine((p) => (p.action === 'merge') === (p.targetId !== undefined), {
            message: 'A merge needs a target project (and only a merge has one)',
          }),
      )
      .max(TODOIST_IMPORT_LIMITS.projects),
    labels: z.array(z.string().min(1).max(64)).max(TODOIST_IMPORT_LIMITS.labels),
    filters: z.array(z.string().min(1).max(64)).max(TODOIST_IMPORT_LIMITS.filters),
    comments: z.boolean(),
    /** Todoist collaborator id → BokyDo user id (or null: leave their tasks unassigned). */
    people: z
      .array(z.object({ id: z.string().min(1).max(64), userId: idSchema.nullable() }).strict())
      .max(TODOIST_IMPORT_LIMITS.collaborators),
  })
  .strict()
  .refine((c) => new Set(c.projects.map((p) => p.id)).size === c.projects.length, {
    message: 'A project is listed twice',
  });
export type TodoistImportChoices = z.input<typeof todoistImportChoicesSchema>;

export interface TodoistImportWarning {
  /** What it is about, for grouping in the UI. */
  kind:
    | 'recurrence'
    | 'timezone'
    | 'assignee'
    | 'label'
    | 'filter'
    | 'truncated'
    | 'duration'
    | 'nesting'
    | 'failed';
  message: string;
}

export interface TodoistImportCounts {
  projects: number;
  merged: number;
  sections: number;
  tasks: number;
  comments: number;
  labels: number;
  filters: number;
  /** Items left out because an earlier import already brought them over. */
  alreadyImported: number;
}

/** The dry run: what would be written, and what will not come over as it is. */
export interface TodoistImportPlanSummary {
  counts: TodoistImportCounts;
  warnings: TodoistImportWarning[];
  /** Warnings beyond the first few hundred are counted, not listed. */
  moreWarnings: number;
}

export interface TodoistImportRun {
  id: string;
  status: 'running' | 'done' | 'failed';
  /** Commands applied so far, and in total. */
  done: number;
  total: number;
  counts: TodoistImportCounts | null;
  warnings: TodoistImportWarning[];
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
