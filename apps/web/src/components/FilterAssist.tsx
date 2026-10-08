import { useMutation, useQuery } from '@tanstack/react-query';
import { ASSIST_LIMITS, type FilterAssistResponse } from '@bokydo/shared';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { api } from '../lib/api.js';
import { matchesText } from '../lib/assist.js';
import { errorMessage } from '../lib/messages.js';
import { aiCatalogQuery } from '../lib/queries.js';
import { Alert, Button, TextField } from './ui.js';

/**
 * Filter Assist: describe a filter in words and get a query to review. Nothing is saved here;
 * "Use this query" only fills the query field of the form around it. Shown only when the server
 * offers assist.filter. It renders inside a <form>, so Enter never submits that form.
 */
export function FilterAssist({ onUse }: { onUse: (query: string) => void }) {
  const catalog = useQuery(aiCatalogQuery);
  const headingId = useId();
  const [text, setText] = useState('');
  const [result, setResult] = useState<FilterAssistResponse | null>(null);

  const write = useMutation({
    mutationFn: (value: string) =>
      api<FilterAssistResponse>('POST', '/api/v1/assist/filter', { text: value }),
    onSuccess: (r) => setResult(r),
  });

  // Focus moves to the suggested query when it appears.
  const open = result !== null;
  useEffect(() => {
    if (open) document.getElementById(headingId)?.focus();
  }, [open, headingId]);

  if (!catalog.data?.available.includes('assist.filter')) return null;

  const ask = () => {
    const value = text.trim();
    if (!value) return;
    setResult(null);
    write.mutate(value);
  };
  // Enter asks rather than submitting the filter form around this field.
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      ask();
    }
  };
  const use = () => {
    if (!result) return;
    onUse(result.query);
    setResult(null);
  };

  const status = write.isPending ? 'Asking…' : result ? 'Query ready to review.' : '';

  return (
    <div className="space-y-3">
      <TextField
        label="Describe it"
        hint="For example: overdue work tasks with priority 1, or anything for Ana this week"
        maxLength={ASSIST_LIMITS.filterText}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="secondary"
          busy={write.isPending}
          disabled={text.trim() === ''}
          onClick={ask}
        >
          Write the query
        </Button>
        {/* Always mounted, so screen readers hear the status when it changes. */}
        <p aria-live="polite" className="text-sm text-muted">
          {status}
        </p>
      </div>

      {write.isError && <Alert>{errorMessage(write.error)}</Alert>}

      {result && (
        <section
          aria-labelledby={headingId}
          className="space-y-2 rounded-lg border border-line p-3 text-sm"
        >
          <h3 id={headingId} tabIndex={-1} className="font-medium focus:outline-none">
            Suggested query
          </h3>
          {/* The model's words and the query are shown as plain text only. */}
          <p>
            <code className="font-mono text-xs break-all">{result.query}</code>
          </p>
          <p>{result.explanation}</p>
          <p className="text-muted">{matchesText(result.matches)}</p>
          {result.warnings.length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-warning">
              {result.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
          <div className="flex justify-end">
            <Button variant="secondary" onClick={use}>
              Use this query
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
