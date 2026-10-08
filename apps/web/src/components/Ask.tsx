import type { AskResponse } from '@bokydo/shared';
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from '../lib/api.js';
import {
  answerTurn,
  askErrorMessage,
  askRequest,
  confirmBody,
  lookedAtText,
  planAsk,
  updateProposal,
  type AskTurn,
  type ProposalCard,
  type ProposalStatus,
} from '../lib/ask.js';
import { useStore } from '../lib/sync.js';
import { Alert, Button, Dialog, TextArea } from './ui.js';

/**
 * Ask your tasks: a chat about the person's own tasks. Answers are plain text. A proposed change
 * runs only when the person presses Do it. The conversation lives in the dialog, so closing it
 * clears it. Mounted only when the server offers ask.
 */
export function AskDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const opener = useRef<HTMLElement | null>(null);
  // Layout effects run before the dialog's own effect moves focus into it, so this is still the
  // control that opened the dialog.
  useLayoutEffect(() => {
    if (open && document.activeElement instanceof HTMLElement)
      opener.current = document.activeElement;
  }, [open]);
  const close = () => {
    onClose();
    queueMicrotask(() => {
      if (opener.current?.isConnected) opener.current.focus();
    });
  };
  return (
    <Dialog open={open} onClose={close} title="Ask your tasks" wide>
      <AskBody />
    </Dialog>
  );
}

function AskBody() {
  const store = useStore();
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [asking, setAsking] = useState(false);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const conversation = useRef<HTMLDivElement>(null);
  const inFlight = useRef(false);
  const running = turns.some((t) => t.proposals?.some((p) => p.status === 'running'));
  const plan = planAsk(turns, draft, asking);

  // Keep the newest message in view.
  useEffect(() => {
    const el = conversation.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, asking]);

  const send = async () => {
    if (!plan.canSend || inFlight.current) return;
    inFlight.current = true;
    const question = draft.trim();
    const request = askRequest(turns, question);
    const asked: AskTurn[] = [...turns, { role: 'user', content: question }];
    setTurns(asked);
    setDraft('');
    setAsking(true);
    setStatus('Thinking…');
    setError(null);
    try {
      const answer = await api<AskResponse>('POST', '/api/v1/assist/ask', request);
      setTurns([...asked, answerTurn(answer)]);
      setStatus('Answer ready.');
    } catch (err) {
      // Put the question back, so it can be edited and sent again.
      setTurns(turns);
      setDraft(question);
      setStatus('');
      setError(askErrorMessage(err));
    } finally {
      setAsking(false);
      inFlight.current = false;
    }
  };

  const setCard = (turn: number, card: number, next: ProposalStatus, message?: string) =>
    setTurns((t) => updateProposal(t, turn, card, next, message));

  const runProposal = async (turn: number, card: number, item: ProposalCard) => {
    setCard(turn, card, 'running');
    try {
      await api('POST', '/api/v1/assist/ask/confirm', confirmBody(item.proposal));
      setCard(turn, card, 'done');
      void store.pull();
    } catch (err) {
      setCard(turn, card, 'failed', askErrorMessage(err));
    }
  };

  const reset = () => {
    setTurns([]);
    setDraft('');
    setStatus('');
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted">
          Ask about your tasks, projects or filters. It can read your tasks. It only changes
          something when you press Do it.
        </p>
        <Button
          variant="secondary"
          onClick={reset}
          disabled={asking || running || turns.length === 0}
        >
          New conversation
        </Button>
      </div>

      <div
        ref={conversation}
        role="region"
        aria-label="Conversation"
        tabIndex={0}
        className="max-h-[50svh] min-h-32 space-y-4 overflow-y-auto rounded-lg border border-line bg-bg p-3 focus-visible:outline-2 focus-visible:outline-accent"
      >
        {turns.length === 0 ? (
          <p className="text-sm text-muted">
            For example: “What is due today?”, “Which tasks mention the budget?” or “Show me my
            saved filters.”
          </p>
        ) : (
          turns.map((turn, i) => (
            <Turn
              key={i}
              turn={turn}
              onRun={(card, item) => void runProposal(i, card, item)}
              onSkip={(card) => setCard(i, card, 'skipped')}
            />
          ))
        )}
      </div>

      <p aria-live="polite" className="min-h-5 text-sm text-muted">
        {status}
      </p>
      {error && <Alert>{error}</Alert>}

      <TextArea
        label="Ask about your tasks"
        rows={3}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        hint={plan.hint ?? 'Press Ctrl+Enter (or Cmd+Enter) to send.'}
      />
      <div className="flex justify-end">
        <Button onClick={() => void send()} disabled={!plan.canSend} busy={asking}>
          Send
        </Button>
      </div>
    </div>
  );
}

function Turn({
  turn,
  onRun,
  onSkip,
}: {
  turn: AskTurn;
  onRun: (card: number, item: ProposalCard) => void;
  onSkip: (card: number) => void;
}) {
  const mine = turn.role === 'user';
  const looked = turn.used ? lookedAtText(turn.used) : null;
  return (
    <div className={`flex flex-col gap-1 ${mine ? 'items-end' : 'items-start'}`}>
      <p
        className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm text-fg ${
          mine ? 'bg-accent/10' : 'bg-surface-alt'
        }`}
      >
        <span className="sr-only">{mine ? 'You: ' : 'Assistant: '}</span>
        {turn.content}
      </p>
      {looked && <p className="text-xs text-muted">{looked}</p>}
      {turn.proposals && turn.proposals.length > 0 && (
        <ul aria-label="Proposed changes" className="w-full max-w-[85%] space-y-2">
          {turn.proposals.map((card, j) => (
            <li key={j} className="rounded-lg border border-line bg-surface p-3">
              <p className="whitespace-pre-wrap text-sm text-fg">{card.proposal.summary}</p>
              {card.status === 'done' && (
                <p className="mt-2 text-sm font-medium text-success">Done</p>
              )}
              {card.status === 'skipped' && <p className="mt-2 text-sm text-muted">Skipped</p>}
              {card.status !== 'done' && card.status !== 'skipped' && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button busy={card.status === 'running'} onClick={() => onRun(j, card)}>
                    {card.status === 'running' ? 'Doing it…' : 'Do it'}
                    <span className="sr-only">: {card.proposal.summary}</span>
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={card.status === 'running'}
                    onClick={() => onSkip(j)}
                  >
                    Skip
                    <span className="sr-only">: {card.proposal.summary}</span>
                  </Button>
                </div>
              )}
              {card.status === 'failed' && card.message && (
                <p role="alert" className="mt-2 text-sm text-danger">
                  {card.message}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
