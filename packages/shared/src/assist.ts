import { z } from 'zod';
import type { Due } from './model.js';

/**
 * Task Assist and Filter Assist (PLAN §5.3, W9). Both only suggest: the server never writes. The
 * client shows the suggestion and applies what the user accepts through ordinary sync commands,
 * so a model talked into something by a task's text can at worst propose it.
 */
export const ASSIST_LIMITS = {
  subtasks: 12,
  filterText: 500,
} as const;

export const taskAssistRequestSchema = z.object({ taskId: z.uuid() }).strict();
export type TaskAssistRequest = z.input<typeof taskAssistRequestSchema>;

export interface TaskAssistSuggestion {
  /** A clearer, actionable title, or null when the current one is fine. */
  content: string | null;
  /** Next steps as sub-tasks (already-existing sub-tasks are not repeated). */
  subtasks: { content: string; due: Due | null }[];
  /** A suggested due date, parsed by BokyDo's own date parser (null: none suggested or unreadable). */
  due: Due | null;
  /** 1 is the most urgent; null: no change suggested. */
  priority: number | null;
  /** One or two sentences: why these suggestions. Plain text. */
  why: string;
}

export interface TaskAssistResponse {
  suggestion: TaskAssistSuggestion;
}

export const filterAssistRequestSchema = z
  .object({ text: z.string().trim().min(1).max(ASSIST_LIMITS.filterText) })
  .strict();
export type FilterAssistRequest = z.input<typeof filterAssistRequestSchema>;

export interface FilterAssistResponse {
  /** A query BokyDo's filter parser accepts. */
  query: string;
  /** What the query does, in plain words (from the model). */
  explanation: string;
  /** Names the query mentions that don't exist (it would match nothing for them). */
  warnings: string[];
  /** Open tasks it matches now (first list only), as a sanity check for the user. */
  matches: number;
}

// ---- Ask your tasks ----

export const ASK_LIMITS = {
  /** Messages in one conversation (the client keeps it and sends it each turn). */
  messages: 20,
  messageChars: 4000,
  totalChars: 30_000,
  /** Changes the assistant may propose in one answer. */
  proposals: 10,
} as const;

export const askRequestSchema = z
  .object({
    messages: z
      .array(
        z
          .object({
            role: z.enum(['user', 'assistant']),
            content: z.string().trim().min(1).max(ASK_LIMITS.messageChars),
          })
          .strict(),
      )
      .min(1)
      .max(ASK_LIMITS.messages)
      .refine((m) => m.at(-1)?.role === 'user', 'The last message must be the question')
      .refine(
        (m) => m.reduce((n, x) => n + x.content.length, 0) <= ASK_LIMITS.totalChars,
        'The conversation is too long; start a new one',
      ),
  })
  .strict();
export type AskRequest = z.input<typeof askRequestSchema>;

/** The write tools the assistant may propose; they run only when the user confirms. */
export const ASK_WRITE_TOOLS = ['add_task', 'update_task', 'complete_task', 'add_comment'] as const;
export type AskWriteTool = (typeof ASK_WRITE_TOOLS)[number];

/** A change the assistant suggests. Nothing has happened yet: the user confirms or ignores it. */
export interface AskProposal {
  tool: AskWriteTool;
  /** The tool's arguments, as the confirm endpoint takes them back. */
  args: Record<string, unknown>;
  /** What it would do, in plain words (written by the server, not the model). */
  summary: string;
}

export interface AskResponse {
  /** The assistant's answer. Plain text: show it as text, never as HTML. */
  reply: string;
  proposals: AskProposal[];
  /** Read tools it used, for "how did it know?" */
  used: string[];
}

export const askConfirmSchema = z
  .object({
    tool: z.enum(ASK_WRITE_TOOLS),
    args: z.record(z.string(), z.unknown()),
  })
  .strict();
export type AskConfirm = z.input<typeof askConfirmSchema>;

// ---- Reports ----

export const REPORT_KINDS = ['day', 'week', 'project'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const reportRequestSchema = z
  .object({
    /** day: plan for today; week: last 7 days done and the next 7 ahead; project: one project. */
    kind: z.enum(REPORT_KINDS),
    projectId: z.uuid().optional(),
  })
  .strict()
  .refine((r) => (r.kind === 'project') === (r.projectId !== undefined), {
    message: 'A project report needs a project (and only it takes one)',
    path: ['projectId'],
  });
export type ReportRequest = z.input<typeof reportRequestSchema>;

export interface ReportResponse {
  /** The summary. Plain text: show it as text, never as HTML. */
  report: string;
  /** What it was written from (so the user can judge it). */
  counts: { overdue: number; today: number; upcoming: number; completed: number };
  generatedAt: string;
}

// ---- Inbox triage (decision models, PLAN §5.4) ----

export const TRIAGE_LIMITS = { tasks: 20 } as const;

export const triageRequestSchema = z
  .object({ taskIds: z.array(z.uuid()).min(1).max(TRIAGE_LIMITS.tasks) })
  .strict()
  .refine((r) => new Set(r.taskIds).size === r.taskIds.length, 'A task is listed twice');
export type TriageRequest = z.input<typeof triageRequestSchema>;

/** Where a task probably belongs. Suggestions only: the user applies them. */
export interface TriageSuggestion {
  taskId: string;
  /** A project the user can add tasks to; null: leave it where it is. */
  projectId: string | null;
  /** Names of the user's existing labels only. */
  labels: string[];
  /** 1 is the most urgent; null: no change suggested. */
  priority: number | null;
  /** The model's own confidence, 0 to 1 (uncalibrated for LLMs). */
  confidence: number;
  /** One short sentence. Plain text. */
  why: string;
}

export interface TriageResponse {
  suggestions: TriageSuggestion[];
}

// ---- Eval harness ----

/** Features the eval harness has cases for. */
export const EVAL_FEATURES = ['assist.filter', 'assist.task', 'ramble.extract'] as const;
export type EvalFeature = (typeof EVAL_FEATURES)[number];

export const evalRequestSchema = z.object({ feature: z.enum(EVAL_FEATURES) }).strict();
export type EvalRequest = z.input<typeof evalRequestSchema>;

export interface EvalCaseResult {
  name: string;
  passed: boolean;
  /** What was wrong, for a failed case. */
  detail: string | null;
  ms: number;
}

export interface EvalResponse {
  feature: EvalFeature;
  passed: number;
  total: number;
  cases: EvalCaseResult[];
}
