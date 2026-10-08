import { useMutation, useQuery } from '@tanstack/react-query';
import type { Task, TaskAssistResponse } from '@bokydo/shared';
import { useEffect, useId, useState } from 'react';
import { api } from '../lib/api.js';
import {
  appliedText,
  assistCommands,
  defaultChoices,
  offeredChanges,
  offeredCount,
  pickedCount,
  NO_PRIORITY,
  suggestionsText,
  type OfferedChanges,
  type TaskAssistChoices,
} from '../lib/assist.js';
import { dueLabel, todayIn } from '../lib/dates.js';
import { aiCatalogQuery } from '../lib/queries.js';
import { errorMessage } from '../lib/messages.js';
import { newId, usePreferences, useSend, useSyncState, useTimeZone } from '../lib/sync.js';
import { useToast } from '../lib/toasts.js';
import { childrenOf } from '../lib/views.js';
import { Alert, Button, Checkbox } from './ui.js';

interface Review {
  why: string;
  offered: OfferedChanges;
  choices: TaskAssistChoices;
}

/**
 * Task Assist: ask for next steps, a clearer title, a date and a priority. Nothing changes until
 * the user ticks what to keep and presses Apply. Shown only when the server offers assist.task.
 */
export function TaskAssist({ task, readOnly }: { task: Task; readOnly: boolean }) {
  const catalog = useQuery(aiCatalogQuery);
  const state = useSyncState();
  const send = useSend();
  const toast = useToast();
  const prefs = usePreferences();
  const today = todayIn(useTimeZone());
  const askId = useId();
  const headingId = useId();
  const [review, setReview] = useState<Review | null>(null);

  const suggest = useMutation({
    mutationFn: () => api<TaskAssistResponse>('POST', '/api/v1/assist/task', { taskId: task.id }),
    onSuccess: ({ suggestion }) => {
      const existing = childrenOf(state, task.id).map((k) => k.content);
      const offered = offeredChanges(task, suggestion, existing);
      setReview({ why: suggestion.why, offered, choices: defaultChoices(task, offered) });
    },
  });

  // Focus moves to the panel when it opens, and back to the button when it closes (see dismiss).
  const open = review !== null;
  useEffect(() => {
    if (open) document.getElementById(headingId)?.focus();
  }, [open, headingId]);

  if (!catalog.data?.available.includes('assist.task') || readOnly) return null;

  const ask = () => {
    setReview(null);
    suggest.mutate();
  };
  const dismiss = () => {
    setReview(null);
    document.getElementById(askId)?.focus();
  };
  const apply = () => {
    if (!review) return;
    const commands = assistCommands(task, review.offered, review.choices, newId);
    for (const c of commands) send(c.type, c.args);
    const message = appliedText(commands);
    if (message) toast({ message });
    dismiss();
  };
  const setChoices = (next: TaskAssistChoices) =>
    setReview((r) => (r ? { ...r, choices: next } : r));

  const offered = review?.offered;
  const choices = review?.choices;
  const status = suggest.isPending
    ? 'Asking…'
    : review && offered
      ? suggestionsText(offeredCount(offered))
      : '';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button id={askId} variant="secondary" busy={suggest.isPending} onClick={ask}>
          Suggest steps
        </Button>
        {/* Always mounted, so screen readers hear the status when it changes. */}
        <p aria-live="polite" className="text-sm text-muted">
          {status}
        </p>
      </div>

      {suggest.isError && <Alert>{errorMessage(suggest.error)}</Alert>}

      {review && offered && choices && (
        <section
          aria-labelledby={headingId}
          className="space-y-4 rounded-xl border border-line bg-surface p-4 text-sm"
        >
          <h3 id={headingId} tabIndex={-1} className="font-semibold focus:outline-none">
            Suggestions
          </h3>
          {/* The model's words, shown as plain text only. */}
          <p className="text-muted">{review.why}</p>

          {offered.title !== null && (
            <Checkbox
              label="Use this title"
              hint={`Suggested: ${offered.title}`}
              checked={choices.title}
              onChange={(e) => setChoices({ ...choices, title: e.target.checked })}
            />
          )}

          {offered.subtasks.length > 0 && (
            <fieldset className="space-y-2">
              <legend className="mb-2 font-medium">Sub-tasks to add</legend>
              {offered.subtasks.map((sub, i) => (
                <Checkbox
                  key={`${i}-${sub.content}`}
                  label={sub.content}
                  hint={sub.due ? dueLabel(sub.due, today, prefs) : undefined}
                  checked={choices.subtasks[i] ?? false}
                  onChange={(e) =>
                    setChoices({
                      ...choices,
                      subtasks: choices.subtasks.map((on, j) => (j === i ? e.target.checked : on)),
                    })
                  }
                />
              ))}
            </fieldset>
          )}

          {offered.due !== null && (
            <Checkbox
              label={`Due ${dueLabel(offered.due, today, prefs)}`}
              hint={task.due ? `Replaces ${dueLabel(task.due, today, prefs)}` : undefined}
              checked={choices.due}
              onChange={(e) => setChoices({ ...choices, due: e.target.checked })}
            />
          )}

          {offered.priority !== null && (
            <Checkbox
              label={`Priority p${offered.priority}`}
              hint={task.priority !== NO_PRIORITY ? `Replaces p${task.priority}` : undefined}
              checked={choices.priority}
              onChange={(e) => setChoices({ ...choices, priority: e.target.checked })}
            />
          )}

          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={dismiss}>
              Dismiss
            </Button>
            {offeredCount(offered) > 0 && (
              <Button onClick={apply} disabled={pickedCount(offered, choices) === 0}>
                Apply
              </Button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
