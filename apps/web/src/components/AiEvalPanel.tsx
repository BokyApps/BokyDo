import { EVAL_FEATURES, type EvalFeature, type EvalResponse } from '@bokydo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { aiCatalogQuery } from '../lib/queries.js';
import { Alert, Button, Card } from './ui.js';

const LABEL: Record<EvalFeature, string> = {
  'assist.filter': 'Filter Assist',
  'assist.task': 'Task Assist',
  'ramble.extract': 'Ramble',
  reports: 'Reports',
};

/**
 * Settings → AI: run a few fixed checks against the model routed for a feature, to see whether
 * it copes (small local models often don't). The checks use made-up tasks, never yours.
 */
export function AiEvalPanel() {
  const catalog = useQuery(aiCatalogQuery);
  const features = EVAL_FEATURES.filter((f) => catalog.data?.available.includes(f));
  const run = useMutation({
    mutationFn: (feature: EvalFeature) =>
      api<EvalResponse>('POST', '/api/v1/assist/eval', { feature }),
  });
  if (features.length === 0) return null;
  const result = run.data;
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Check a model</h2>
      <p className="mb-4 text-sm text-muted">
        Runs a few short checks with made-up tasks (none of yours) on the model chosen above for a
        feature, including ones that try to trick it. Each check is an AI call on that model.
      </p>
      <div className="flex flex-wrap gap-2">
        {features.map((f) => (
          <Button
            key={f}
            variant="secondary"
            busy={run.isPending && run.variables === f}
            disabled={run.isPending}
            onClick={() => run.mutate(f)}
          >
            Check {LABEL[f]}
          </Button>
        ))}
      </div>
      <div aria-live="polite" className="mt-4">
        {run.isPending && <p className="text-sm text-muted">Running checks…</p>}
        {run.isError && <Alert tone="error">{errorMessage(run.error)}</Alert>}
        {result && !run.isPending && (
          <div className="space-y-2">
            <p className="text-sm font-medium">
              {LABEL[result.feature]}: {result.passed} of {result.total} checks passed
            </p>
            <ul className="space-y-1 text-sm">
              {result.cases.map((c) => (
                <li key={c.name}>
                  <span className={c.passed ? 'text-fg' : 'text-danger'}>
                    {c.passed ? 'Passed' : 'Failed'}
                  </span>
                  {': '}
                  {c.name}
                  {c.detail && <span className="text-muted"> ({c.detail})</span>}
                  <span className="text-muted"> · {(c.ms / 1000).toFixed(1)} s</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
