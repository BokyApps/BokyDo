import { useMutation, useQuery } from '@tanstack/react-query';
import type { TriageResponse, TriageSuggestion } from '@bokydo/shared';
import { useId, useMemo, useState } from 'react';
import { api } from '../lib/api.js';
import { useConfirm } from '../lib/confirm.js';
import { errorMessage } from '../lib/messages.js';
import { aiCatalogQuery } from '../lib/queries.js';
import {
  buildRows,
  chooseTriageTasks,
  confidenceText,
  isNoChange,
  likelyRows,
  planPhrases,
  sharedWarning,
  triageCommands,
  type TriageContext,
  type TriageRow,
} from '../lib/triage.js';
import { useSend, useSyncState } from '../lib/sync.js';
import { projectTasks } from '../lib/views.js';
import { Alert, Button } from './ui.js';

const countText = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Inbox triage: asks where the open Inbox tasks probably belong, then shows each suggestion for
 * the user to apply or skip. Nothing moves until they do. Shown on the Inbox only, and only when
 * the server offers assist.task.
 */
export function TriageSuggest({ inboxId }: { inboxId: string }) {
  const catalog = useQuery(aiCatalogQuery);
  const state = useSyncState();
  const send = useSend();
  const confirm = useConfirm();
  const askId = useId();
  const headingId = useId();
  const [suggestions, setSuggestions] = useState<TriageSuggestion[] | null>(null);
  const [handled, setHandled] = useState<ReadonlySet<string>>(() => new Set());
  const [message, setMessage] = useState('');
  const rowId = (taskId: string) => `${headingId}-row-${taskId}`;
  const focusHeading = () => document.getElementById(headingId)?.focus();

  // The open top-level tasks, in the order the Inbox lists them.
  const open = useMemo(() => [...projectTasks(state, inboxId).values()].flat(), [state, inboxId]);
  const openById = useMemo(() => new Map(open.map((t) => [t.id, t])), [open]);
  const ctx: TriageContext = {
    projects: state.projects,
    members: state.members,
    userId: state.user?.id ?? null,
  };

  const suggest = useMutation({
    mutationFn: (taskIds: string[]) =>
      api<TriageResponse>('POST', '/api/v1/assist/triage', { taskIds }),
    onSuccess: ({ suggestions: next }) => {
      setSuggestions(next);
      setHandled(new Set());
      setMessage(`${countText(next.length, 'suggestion')} ready to review.`);
      // The heading mounts with the results, so focus it after React has drawn them.
      window.setTimeout(focusHeading, 0);
    },
  });

  if (!catalog.data?.available.includes('assist.task') || open.length === 0) return null;

  const rows: TriageRow[] =
    suggestions === null
      ? []
      : buildRows(
          suggestions.filter((s) => !handled.has(s.taskId)),
          openById,
          ctx,
        );
  const eligible = likelyRows(rows);

  const ask = () => {
    setSuggestions(null);
    setMessage('');
    suggest.mutate(chooseTriageTasks(open));
  };

  const dismiss = () => {
    setSuggestions(null);
    setHandled(new Set());
    setMessage('');
    document.getElementById(askId)?.focus();
  };

  // Once a row is gone, focus goes to the next row's first button, else the previous row's, else
  // the heading. A timeout, so it runs after React has removed the row.
  const focusAfter = (taskId: string) => {
    const i = rows.findIndex((r) => r.task.id === taskId);
    const neighbour = rows[i + 1] ?? rows[i - 1];
    window.setTimeout(() => {
      const button = neighbour
        ? document.getElementById(rowId(neighbour.task.id))?.querySelector('button')
        : null;
      (button ?? document.getElementById(headingId))?.focus();
    }, 0);
  };

  const applyRows = (picked: TriageRow[]) => {
    for (const row of picked)
      for (const c of triageCommands(row.task, row.plan)) send(c.type, c.args);
    setHandled((prev) => new Set([...prev, ...picked.map((r) => r.task.id)]));
  };

  const applyOne = async (row: TriageRow) => {
    // Moving a task into a shared project shows it to other people: ask first.
    if (row.plan.sharedWith > 0 && row.plan.projectId !== null) {
      const ok = await confirm({
        title: 'Move into a shared project?',
        message: `${sharedWarning(row.plan.sharedWith)}. Move “${row.task.content}” there?`,
        confirmLabel: 'Move',
      });
      if (!ok) return;
    }
    applyRows([row]);
    const phrases = planPhrases(row.plan);
    setMessage(`Applied “${row.task.content}”${phrases.length ? `: ${phrases.join('; ')}` : ''}.`);
    focusAfter(row.task.id);
  };

  const skipOne = (row: TriageRow) => {
    setHandled((prev) => new Set([...prev, row.task.id]));
    setMessage(`Skipped “${row.task.content}”.`);
    focusAfter(row.task.id);
  };

  const applyAll = async () => {
    const picked = eligible;
    const ok = await confirm({
      title: 'Apply likely suggestions?',
      message: `${countText(picked.length, 'task')} will move to the project suggested for ${picked.length === 1 ? 'it' : 'them'}, with any labels and priority the suggestion gives. Tasks whose project is shared with other people are left out.`,
      confirmLabel: 'Apply',
    });
    if (!ok) return;
    applyRows(picked);
    setMessage(`Applied ${countText(picked.length, 'suggestion')}.`);
    focusHeading();
  };

  const statusText = suggest.isPending ? 'Asking…' : message;

  return (
    <div className="mb-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button id={askId} variant="secondary" busy={suggest.isPending} onClick={ask}>
          Suggest where these go
        </Button>
        {/* Always mounted, so screen readers hear the status when it changes. */}
        <p aria-live="polite" className="text-sm text-muted">
          {statusText}
        </p>
      </div>

      {suggest.isError && <Alert>{errorMessage(suggest.error)}</Alert>}

      {suggestions !== null && (
        <section
          aria-labelledby={headingId}
          className="space-y-4 rounded-xl border border-line bg-surface p-4 text-sm"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 id={headingId} tabIndex={-1} className="font-semibold focus:outline-none">
              Where these go
            </h3>
            <div className="flex flex-wrap gap-2">
              {rows.length > 0 && (
                <Button
                  onClick={() => void applyAll()}
                  disabled={eligible.length === 0}
                  title={
                    eligible.length === 0
                      ? 'No suggestion is likely, with a project nobody else shares'
                      : undefined
                  }
                >
                  Apply all likely
                </Button>
              )}
              <Button variant="secondary" onClick={dismiss}>
                Close
              </Button>
            </div>
          </div>
          <p className="text-muted">
            Nothing moves until you apply it. “Apply all likely” takes only likely suggestions with
            a project that nobody else shares.
          </p>

          {rows.length === 0 ? (
            <p className="text-muted">All suggestions handled.</p>
          ) : (
            <ul aria-label="Suggested changes" className="divide-y divide-line">
              {rows.map((row) => (
                <TriageRowView
                  key={row.task.id}
                  id={rowId(row.task.id)}
                  row={row}
                  warnId={`${rowId(row.task.id)}-shared`}
                  onApply={() => void applyOne(row)}
                  onSkip={() => skipOne(row)}
                />
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function TriageRowView({
  id,
  row,
  warnId,
  onApply,
  onSkip,
}: {
  id: string;
  row: TriageRow;
  warnId: string;
  onApply: () => void;
  onSkip: () => void;
}) {
  const { task, suggestion, plan } = row;
  const noChange = isNoChange(plan);
  const phrases = planPhrases(plan);
  const shared = plan.sharedWith > 0 && plan.projectId !== null;
  return (
    <li id={id} className="space-y-2 py-3 first:pt-0 last:pb-0">
      <p className="font-medium text-fg">{task.content}</p>
      <p className="text-fg">{noChange ? 'Leave it here' : phrases.join('; ')}</p>
      <p className="text-muted">
        Confidence:{' '}
        <span className="font-medium text-fg">{confidenceText(suggestion.confidence)}</span>
      </p>
      {/* The model's words, shown as plain text only. */}
      {suggestion.why && <p className="text-muted">{suggestion.why}</p>}
      {shared && (
        <p
          id={warnId}
          className="rounded-md border border-warning/50 bg-warning/10 px-2 py-1 text-fg"
        >
          {sharedWarning(plan.sharedWith)}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        {!noChange && (
          <Button
            aria-label={`Apply suggestion for ${task.content}`}
            aria-describedby={shared ? warnId : undefined}
            onClick={onApply}
          >
            Apply
          </Button>
        )}
        <Button
          variant="secondary"
          aria-label={`Skip suggestion for ${task.content}`}
          onClick={onSkip}
        >
          Skip
        </Button>
      </div>
    </li>
  );
}
