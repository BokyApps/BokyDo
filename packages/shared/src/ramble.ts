import { z } from 'zod';
import type { Due } from './model.js';

/**
 * Ramble (PLAN §5.3): a spoken or typed brain-dump becomes a draft list of tasks. The client
 * keeps the draft; every new piece of transcript is sent with it, and the model answers with
 * edit operations (add / update / remove) that the server applies, validates and resolves
 * against what the user may write to. Nothing is created until the user commits the draft.
 */
export const RAMBLE_LIMITS = {
  /** Tasks in one draft. */
  maxDraft: 50,
  /** New transcript per extraction call (a pasted text ramble can be this long). */
  maxTextChars: 20_000,
  /** One audio chunk. */
  maxAudioBytes: 5 * 1024 * 1024,
  maxAudioSeconds: 60,
} as const;

const ref = z.string().regex(/^d[0-9]{1,3}$/, 'Draft refs look like d1, d2, …');
const name = z.string().trim().min(1).max(120);

/** A task in the draft, as the model and the review panel see it: names, not ids. */
export const rambleDraftTaskSchema = z
  .object({
    ref,
    content: z.string().trim().min(1).max(500),
    description: z.string().max(2000).optional(),
    /** Natural language, as said ("next Friday 5pm", "every Monday"); parsed by the server. */
    due: z.string().trim().min(1).max(100).optional(),
    priority: z.number().int().min(1).max(4).optional(),
    project: name.optional(),
    section: name.optional(),
    labels: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
    /** Username of a project member. */
    assignee: z.string().trim().min(1).max(60).optional(),
  })
  .strict();
export type RambleDraftTask = z.output<typeof rambleDraftTaskSchema>;

export const rambleExtractRequestSchema = z
  .object({
    /** The new piece of transcript (a voice chunk) or the whole pasted text. */
    text: z.string().trim().min(1).max(RAMBLE_LIMITS.maxTextChars),
    draft: z.array(rambleDraftTaskSchema).max(RAMBLE_LIMITS.maxDraft).default([]),
  })
  .strict()
  .refine((r) => new Set(r.draft.map((t) => t.ref)).size === r.draft.length, 'Duplicate ref');
export type RambleExtractRequest = z.input<typeof rambleExtractRequestSchema>;

export type RambleIssue =
  'unknown_project' | 'unknown_section' | 'unknown_assignee' | 'unparsed_due' | 'new_label';

/** What a draft task would become if committed now. */
export interface RambleResolution {
  /** null: the Inbox. */
  projectId: string | null;
  sectionId: string | null;
  due: Due | null;
  labels: string[];
  assigneeId: string | null;
  issues: RambleIssue[];
}

export type RambleResolvedTask = RambleDraftTask & { resolved: RambleResolution };

export interface RambleOpSummary {
  op: 'add' | 'update' | 'remove';
  ref: string;
}

export interface RambleExtractResponse {
  draft: RambleResolvedTask[];
  /** What changed, in order (for highlighting); operations the server refused are left out. */
  ops: RambleOpSummary[];
}

/** Commit: the reviewed draft. `projectId` overrides the named project (chosen in review). */
export const rambleCommitRequestSchema = z
  .object({
    tasks: z
      .array(rambleDraftTaskSchema.extend({ projectId: z.uuid().optional() }))
      .min(1)
      .max(RAMBLE_LIMITS.maxDraft),
  })
  .strict()
  .refine((r) => new Set(r.tasks.map((t) => t.ref)).size === r.tasks.length, 'Duplicate ref');
export type RambleCommitRequest = z.input<typeof rambleCommitRequestSchema>;

export interface RambleCommitResponse {
  created: { ref: string; taskId: string }[];
}

export const rambleTranscribeQuerySchema = z
  .object({
    /** The chunk's length as recorded; metering never counts less than its size implies. */
    seconds: z.coerce.number().positive().max(RAMBLE_LIMITS.maxAudioSeconds),
    language: z
      .string()
      .regex(/^[a-z]{2,3}$/)
      .optional(),
  })
  .strict();
