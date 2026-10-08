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
