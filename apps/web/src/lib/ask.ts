import { ASK_LIMITS, type AskConfirm, type AskProposal, type AskResponse } from '@bokydo/shared';
import { ApiError } from './api.js';
import { errorMessage } from './messages.js';

/*
 * Ask your tasks on the client: the conversation is kept here and sent whole with each question.
 * The helpers are pure so the rules (what is sent, when Send is allowed, what the person reads)
 * can be tested without a browser or a server.
 */

export type AskRole = 'user' | 'assistant';

export type ProposalStatus = 'open' | 'running' | 'done' | 'skipped' | 'failed';

export interface ProposalCard {
  proposal: AskProposal;
  status: ProposalStatus;
  /** Why the last "Do it" failed, in plain words. */
  message?: string;
}

export interface AskTurn {
  role: AskRole;
  /** Plain text. Shown as text only, never as Markdown or HTML. */
  content: string;
  /** Read tools the assistant used for this answer (assistant turns only). */
  used?: string[];
  /** Changes the assistant proposes (assistant turns only). Nothing runs until "Do it". */
  proposals?: ProposalCard[];
}

/** Friendly words for the read tools, for "Looked at: search, filters". */
const TOOL_WORDS = new Map<string, string>([
  ['search_tasks', 'search'],
  ['run_filter', 'filters'],
  ['get_task', 'a task'],
  ['list_projects', 'projects'],
  ['list_filters', 'saved filters'],
  ['get_report', 'overview'],
]);

/** "Looked at: search, filters", each word once. Unknown tool names are left out; null if none. */
export function lookedAtText(used: readonly string[]): string | null {
  const words = [
    ...new Set(
      used.map((name) => TOOL_WORDS.get(name)).filter((w): w is string => w !== undefined),
    ),
  ];
  return words.length > 0 ? `Looked at: ${words.join(', ')}` : null;
}

/** Shown when the model gave no answer at all (it used up its rounds). */
export const NO_ANSWER = "I couldn't come up with an answer. Try asking in fewer words.";

/**
 * The reply as the conversation keeps it. The server allows a longer reply than it accepts
 * back as a message, so it is cut to the message limit here; otherwise the next question would
 * be refused.
 */
export function answerText(reply: string): string {
  const text = reply.trim();
  if (text === '') return NO_ANSWER;
  return text.length > ASK_LIMITS.messageChars
    ? text.slice(0, ASK_LIMITS.messageChars - 1) + '…'
    : text;
}

/** The assistant turn for an answer: its text, the tools it used, and its open proposals. */
export function answerTurn(answer: AskResponse): AskTurn {
  return {
    role: 'assistant',
    content: answerText(answer.reply),
    used: answer.used,
    proposals: answer.proposals.map((proposal) => ({ proposal, status: 'open' })),
  };
}

export interface AskPlan {
  /** Send is allowed now. */
  canSend: boolean;
  /** Why Send is off, when the limits are the reason. Null when there is simply nothing to send. */
  hint: string | null;
}

/**
 * Whether the question can be sent, given the conversation so far. The limits are the server's
 * (ASK_LIMITS), counted the way the server counts: trimmed text, all messages including the
 * question.
 */
export function planAsk(turns: readonly AskTurn[], draft: string, busy = false): AskPlan {
  const question = draft.trim();
  if (busy || question === '') return { canSend: false, hint: null };
  if (question.length > ASK_LIMITS.messageChars)
    return {
      canSend: false,
      hint: `Shorten your question to ${ASK_LIMITS.messageChars} characters or fewer.`,
    };
  if (turns.length + 1 > ASK_LIMITS.messages)
    return {
      canSend: false,
      hint: 'This conversation is full. Start a new conversation to keep asking.',
    };
  const total = turns.reduce((n, t) => n + t.content.length, question.length);
  if (total > ASK_LIMITS.totalChars)
    return {
      canSend: false,
      hint: 'This conversation is too long. Start a new conversation to keep asking.',
    };
  return { canSend: true, hint: null };
}

/** The request body for the question, after the conversation so far. */
export function askRequest(turns: readonly AskTurn[], question: string) {
  return {
    messages: [
      ...turns.map((t) => ({ role: t.role, content: t.content })),
      { role: 'user' as const, content: question.trim() },
    ],
  };
}

/** Set one proposal's status. Returns the same array when the turn is gone (a new conversation). */
export function updateProposal(
  turns: readonly AskTurn[],
  turn: number,
  card: number,
  status: ProposalStatus,
  message?: string,
): AskTurn[] {
  return turns.map((t, i) => {
    if (i !== turn || !t.proposals?.[card]) return t;
    const proposals = t.proposals.map((c, j) =>
      j === card ? { proposal: c.proposal, status, ...(message ? { message } : {}) } : c,
    );
    return { ...t, proposals };
  });
}

/** The confirm body: exactly the proposal's tool and args, as the server's schema is strict. */
export function confirmBody(proposal: AskProposal): AskConfirm {
  return { tool: proposal.tool, args: proposal.args };
}

/** Human-readable text for a failed question or "Do it". */
export function askErrorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === 'ai_refused')
    return "The AI wouldn't answer that. Try asking in other words.";
  return errorMessage(err);
}
