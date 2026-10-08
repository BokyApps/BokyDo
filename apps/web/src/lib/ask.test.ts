import { askRequestSchema, ASK_LIMITS, type AskProposal } from '@bokydo/shared';
import { describe, expect, it } from 'vitest';
import {
  answerText,
  answerTurn,
  askErrorMessage,
  askRequest,
  confirmBody,
  lookedAtText,
  NO_ANSWER,
  planAsk,
  updateProposal,
  type AskTurn,
} from './ask.js';
import { ApiError } from './api.js';

const user = (content: string): AskTurn => ({ role: 'user', content });
const assistant = (content: string): AskTurn => ({ role: 'assistant', content });

const proposal: AskProposal = {
  tool: 'complete_task',
  args: { taskId: '6f1f4b3e-2d7a-4a53-9a57-8f0f2d9c1a11' },
  summary: 'Complete "Call the dentist"',
};

describe('lookedAtText', () => {
  it('names the read tools in friendly words, each once, in the order used', () => {
    expect(lookedAtText(['search_tasks', 'run_filter', 'search_tasks'])).toBe(
      'Looked at: search, filters',
    );
    expect(lookedAtText(['get_report', 'list_projects', 'list_filters', 'get_task'])).toBe(
      'Looked at: overview, projects, saved filters, a task',
    );
  });

  it('leaves out tools it does not know, and says nothing when none are left', () => {
    expect(lookedAtText(['search_tasks', 'future_tool'])).toBe('Looked at: search');
    expect(lookedAtText(['future_tool'])).toBeNull();
    expect(lookedAtText([])).toBeNull();
  });

  it('does not treat object property names as tools', () => {
    expect(lookedAtText(['constructor', '__proto__', 'toString'])).toBeNull();
  });
});

describe('planAsk', () => {
  it('allows a question after an empty conversation, and says nothing when there is no question', () => {
    expect(planAsk([], 'What is due today?')).toEqual({ canSend: true, hint: null });
    expect(planAsk([], '   ')).toEqual({ canSend: false, hint: null });
    expect(planAsk([], '')).toEqual({ canSend: false, hint: null });
  });

  it('is off while a question is in flight, even with a valid draft', () => {
    expect(planAsk([], 'What is due today?', true)).toEqual({ canSend: false, hint: null });
  });

  it('counts the question as the server does: trimmed', () => {
    const exact = 'a'.repeat(ASK_LIMITS.messageChars);
    expect(planAsk([], `  ${exact}  `).canSend).toBe(true);
    const over = 'a'.repeat(ASK_LIMITS.messageChars + 1);
    const plan = planAsk([], over);
    expect(plan.canSend).toBe(false);
    expect(plan.hint).toContain(String(ASK_LIMITS.messageChars));
  });

  it('refuses a question that would make the conversation exceed the message count', () => {
    const full = Array.from({ length: ASK_LIMITS.messages - 1 }, (_, i) =>
      i % 2 === 0 ? user('q') : assistant('a'),
    );
    expect(full).toHaveLength(19);
    expect(planAsk(full, 'one more').canSend).toBe(true);
    const plan = planAsk([...full, user('q')], 'one more too');
    expect(plan.canSend).toBe(false);
    expect(plan.hint).toMatch(/start a new conversation/i);
  });

  it('counts the whole conversation against the total character limit, up to exactly the limit', () => {
    const big = 'x'.repeat(ASK_LIMITS.messageChars);
    // Seven full messages, then a question that fills the rest of the budget exactly.
    const turns = Array.from({ length: 7 }, () => assistant(big));
    const used = 7 * ASK_LIMITS.messageChars;
    const fits = 'y'.repeat(ASK_LIMITS.totalChars - used);
    expect(planAsk(turns, fits).canSend).toBe(true);
    const plan = planAsk(turns, `${fits}y`);
    expect(plan.canSend).toBe(false);
    expect(plan.hint).toMatch(/too long/i);
  });

  it('builds a request the server schema accepts, when it allows the question', () => {
    const turns = [user('What is due today?'), assistant('Two things: the dentist and rent.')];
    const request = askRequest(turns, '  And tomorrow?  ');
    expect(request.messages).toEqual([
      { role: 'user', content: 'What is due today?' },
      { role: 'assistant', content: 'Two things: the dentist and rent.' },
      { role: 'user', content: 'And tomorrow?' },
    ]);
    expect(askRequestSchema.safeParse(request).success).toBe(true);
    expect(planAsk(turns, 'And tomorrow?').canSend).toBe(true);
  });
});

describe('answerText and answerTurn', () => {
  it('shows a short note, not an empty turn, when the model gave no answer', () => {
    expect(answerText('')).toBe(NO_ANSWER);
    expect(answerText('   \n  ')).toBe(NO_ANSWER);
  });

  it('cuts a reply to the message limit, so it can be sent back with the next question', () => {
    // The server may return up to 8,000 characters; a message may only hold 4,000.
    const long = 'z'.repeat(8000);
    const kept = answerText(long);
    expect(kept.length).toBeLessThanOrEqual(ASK_LIMITS.messageChars);
    expect(askRequestSchema.safeParse(askRequest([assistant(kept)], 'next')).success).toBe(true);
  });

  it('keeps the text, the tools used, and every proposal open', () => {
    const turn = answerTurn({
      reply: '  Done, see below.  ',
      used: ['search_tasks'],
      proposals: [proposal],
    });
    expect(turn).toEqual({
      role: 'assistant',
      content: 'Done, see below.',
      used: ['search_tasks'],
      proposals: [{ proposal, status: 'open' }],
    });
  });
});

describe('updateProposal', () => {
  const turns: AskTurn[] = [
    user('Complete the dentist call'),
    { ...answerTurn({ reply: 'Shall I?', used: [], proposals: [proposal, proposal] }) },
  ];

  it('changes only the one card, without touching the input', () => {
    const next = updateProposal(turns, 1, 0, 'done');
    expect(next[1]?.proposals?.[0]?.status).toBe('done');
    expect(next[1]?.proposals?.[1]?.status).toBe('open');
    expect(turns[1]?.proposals?.[0]?.status).toBe('open');
    expect(next[0]).toBe(turns[0]);
  });

  it('keeps a failure message, and drops it when the card is retried', () => {
    const failed = updateProposal(turns, 1, 0, 'failed', 'Nope.');
    expect(failed[1]?.proposals?.[0]).toEqual({ proposal, status: 'failed', message: 'Nope.' });
    const retried = updateProposal(failed, 1, 0, 'running');
    expect(retried[1]?.proposals?.[0]).toEqual({ proposal, status: 'running' });
  });

  it('does nothing when the turn is gone (the conversation was cleared while a change ran)', () => {
    expect(updateProposal([], 1, 0, 'done')).toEqual([]);
    expect(updateProposal(turns, 1, 5, 'done')).toEqual(turns);
  });
});

describe('confirmBody', () => {
  it('sends exactly the tool and args, never the summary', () => {
    const body = confirmBody(proposal);
    expect(body).toEqual({ tool: proposal.tool, args: proposal.args });
    expect(Object.keys(body).sort()).toEqual(['args', 'tool']);
  });
});

describe('askErrorMessage', () => {
  it('uses the server message for a change that could not be made', () => {
    const err = new ApiError(422, 'not_done', {
      error: 'not_done',
      message: 'That task is in a project you can only view.',
    });
    expect(askErrorMessage(err)).toBe('That task is in a project you can only view.');
  });

  it('explains a refusal in terms of asking, not tasks', () => {
    expect(askErrorMessage(new ApiError(422, 'ai_refused', null))).toMatch(/answer that/);
  });

  it('falls back to the general text for anything else', () => {
    expect(askErrorMessage(new Error('offline'))).toMatch(/connection/);
  });
});
