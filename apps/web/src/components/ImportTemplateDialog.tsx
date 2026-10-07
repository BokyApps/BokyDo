import { countTemplate, type Command, type Template, type TemplateWarning } from '@bokydo/shared';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { planImport, type ImportTarget } from '../lib/templates/import-plan.js';
import { usePreferences, useStore, useSyncState, useTimeZone } from '../lib/sync.js';
import { Alert, Button, Checkbox, Dialog, SelectField, TextField } from './ui.js';

export interface TemplateChoice {
  template: Template;
  /** Notes from reading the file (rows that were skipped or adjusted). */
  warnings: TemplateWarning[];
  defaultName: string;
}

const PREVIEW_ROWS = 300;
const INDENT = ['pl-0', 'pl-4', 'pl-8', 'pl-12'] as const;
const WRITABLE = new Set(['owner', 'admin', 'editor']);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function ImportTemplateDialog({
  choice,
  onClose,
}: {
  choice: TemplateChoice | null;
  onClose: () => void;
}) {
  return (
    <Dialog open={choice !== null} onClose={onClose} title="Use this template" wide>
      {choice && <ImportForm key={choice.defaultName} choice={choice} onClose={onClose} />}
    </Dialog>
  );
}

function ImportForm({ choice, onClose }: { choice: TemplateChoice; onClose: () => void }) {
  const { template } = choice;
  const state = useSyncState();
  const store = useStore();
  const prefs = usePreferences();
  const timeZone = useTimeZone();
  const navigate = useNavigate();

  const writable = [...state.projects.values()]
    .filter((p) => !p.isArchived && WRITABLE.has(p.role))
    .sort((a, b) => Number(b.isInbox) - Number(a.isInbox) || a.name.localeCompare(b.name));
  const [kind, setKind] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState(choice.defaultName);
  const [existingId, setExistingId] = useState(writable[0]?.id ?? '');
  const [includeComments, setIncludeComments] = useState(true);
  const [stage, setStage] = useState<'review' | 'importing' | 'done'>('review');
  const [progress, setProgress] = useState({ saved: 0, total: 0 });
  const [result, setResult] = useState<{ projectId: string; added: number; total: number } | null>(
    null,
  );

  const counts = countTemplate(template);
  // Reading dates is the only thing that can go wrong after the file itself was accepted.
  const dateWarnings = useMemo(
    () =>
      planImport({
        template,
        target: { kind: 'new', name: 'preview' },
        state,
        prefs,
        timeZone,
      }).warnings,
    [template, state, prefs, timeZone],
  );
  const warnings = [...choice.warnings, ...dateWarnings];
  const target: ImportTarget =
    kind === 'new' ? { kind: 'new', name } : { kind: 'existing', projectId: existingId };
  const canImport = kind === 'new' ? name.trim() !== '' : existingId !== '';

  const run = async () => {
    const plan = planImport({ template, target, state, prefs, timeZone, includeComments });
    setProgress({ saved: 0, total: plan.commands.length });
    setStage('importing');
    // Ordinary commands: the server checks every one like anything typed by hand (permissions,
    // limits, validation), and rejects what it must. Large imports are paced by its rate limit.
    for (const c of plan.commands) store.enqueue({ ...c, uuid: crypto.randomUUID() } as Command);
    const deadline = Date.now() + 5 * 60_000;
    while (store.pendingCount > 0 && Date.now() < deadline) {
      setProgress({
        saved: plan.commands.length - store.pendingCount,
        total: plan.commands.length,
      });
      await sleep(300);
    }
    const added = plan.taskIds.filter((id) => store.state.tasks.has(id)).length;
    setResult({ projectId: plan.projectId, added, total: plan.taskIds.length });
    setStage('done');
  };

  if (stage === 'importing')
    return (
      <div role="status" className="space-y-3">
        <p className="text-sm">
          Importing… {progress.saved} of {progress.total} saved
        </p>
        <progress className="w-full" value={progress.saved} max={progress.total} />
        <p className="text-xs text-muted">You can leave this page: it keeps going.</p>
      </div>
    );

  if (stage === 'done' && result)
    return (
      <div className="space-y-4">
        {result.added === result.total ? (
          <Alert tone="success">
            Imported {result.added} {result.added === 1 ? 'task' : 'tasks'}.
          </Alert>
        ) : (
          <Alert tone="warning">
            Imported {result.added} of {result.total} tasks. The rest were turned down by the server
            (a limit was reached, or you can't add to that project) or are still waiting to be
            saved.
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => {
              onClose();
              void navigate({ to: '/project/$projectId', params: { projectId: result.projectId } });
            }}
          >
            Open project
          </Button>
        </div>
      </div>
    );

  const rows = [
    ...template.tasks.map((t) => ({ kind: 'task' as const, t })),
    ...template.sections.flatMap((s) => [
      { kind: 'section' as const, name: s.name },
      ...s.tasks.map((t) => ({ kind: 'task' as const, t })),
    ]),
  ];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {counts.tasks} {counts.tasks === 1 ? 'task' : 'tasks'}, {counts.sections}{' '}
        {counts.sections === 1 ? 'section' : 'sections'}, {counts.comments}{' '}
        {counts.comments === 1 ? 'comment' : 'comments'}. Nothing is added until you press Import.
      </p>
      <ul
        aria-label="What will be added"
        tabIndex={0}
        className="max-h-56 space-y-0.5 overflow-auto rounded-lg border border-line bg-surface-alt p-3 text-sm"
      >
        {rows.slice(0, PREVIEW_ROWS).map((row, i) =>
          row.kind === 'section' ? (
            <li key={i} className="pt-1 font-semibold">
              {row.name}
            </li>
          ) : (
            <li key={i} className={INDENT[row.t.depth] ?? 'pl-12'}>
              {row.t.content}
              {row.t.date && <span className="text-muted"> · {row.t.date}</span>}
            </li>
          ),
        )}
        {rows.length > PREVIEW_ROWS && (
          <li className="text-muted">…and {rows.length - PREVIEW_ROWS} more.</li>
        )}
      </ul>
      {warnings.length > 0 && (
        <details className="rounded-lg border border-line p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            {warnings.length} {warnings.length === 1 ? 'note' : 'notes'} about this file
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
            {warnings.map((w, i) => (
              <li key={i}>
                {w.row !== null && `Line ${w.row}: `}
                {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Add it to"
          value={kind}
          onChange={(e) => setKind(e.target.value as 'new' | 'existing')}
          options={[
            { value: 'new', label: 'A new project' },
            { value: 'existing', label: 'An existing project' },
          ]}
        />
        {kind === 'new' ? (
          <TextField
            label="Project name"
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        ) : (
          <SelectField
            label="Project"
            value={existingId}
            onChange={(e) => setExistingId(e.target.value)}
            options={writable.map((p) => ({ value: p.id, label: p.isInbox ? 'Inbox' : p.name }))}
          />
        )}
      </div>
      {counts.comments > 0 && (
        <Checkbox
          label="Include comments"
          checked={includeComments}
          onChange={(e) => setIncludeComments(e.target.checked)}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void run()} disabled={!canImport}>
          Import
        </Button>
      </div>
    </div>
  );
}
