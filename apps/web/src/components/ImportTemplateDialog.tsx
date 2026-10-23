import { countTemplate, type Command, type Template, type TemplateWarning } from '@bokydo/shared';
import { useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  return (
    <Dialog open={choice !== null} onClose={onClose} title={t('import.useTemplate')} wide>
      {choice && <ImportForm key={choice.defaultName} choice={choice} onClose={onClose} />}
    </Dialog>
  );
}

function ImportForm({ choice, onClose }: { choice: TemplateChoice; onClose: () => void }) {
  const { t } = useTranslation();
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
          {t('import.importing', { saved: progress.saved, total: progress.total })}
        </p>
        <progress className="w-full" value={progress.saved} max={progress.total} />
        <p className="text-xs text-muted">{t('import.keepsGoing')}</p>
      </div>
    );

  if (stage === 'done' && result)
    return (
      <div className="space-y-4">
        {result.added === result.total ? (
          <Alert tone="success">{t('import.importedAll', { count: result.added })}</Alert>
        ) : (
          <Alert tone="warning">
            {t('import.importedPartial', { added: result.added, total: result.total })}
          </Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            {t('import.close')}
          </Button>
          <Button
            onClick={() => {
              onClose();
              void navigate({ to: '/project/$projectId', params: { projectId: result.projectId } });
            }}
          >
            {t('import.openProject')}
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
        {t('import.previewSummary', {
          tasks: t('import.countTask', { count: counts.tasks }),
          sections: t('import.countSection', { count: counts.sections }),
          comments: t('import.countComment', { count: counts.comments }),
        })}
      </p>
      <ul
        aria-label={t('import.previewAria')}
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
          <li className="text-muted">
            {t('import.andMore', { count: rows.length - PREVIEW_ROWS })}
          </li>
        )}
      </ul>
      {warnings.length > 0 && (
        <details className="rounded-lg border border-line p-3 text-sm">
          <summary className="cursor-pointer font-medium">
            {t('import.notes', { count: warnings.length })}
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
            {warnings.map((w, i) => (
              <li key={i}>
                {w.row !== null && t('import.line', { row: w.row })}
                {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label={t('import.addTo')}
          value={kind}
          onChange={(e) => setKind(e.target.value as 'new' | 'existing')}
          options={[
            { value: 'new', label: t('import.newProject') },
            { value: 'existing', label: t('import.existingProject') },
          ]}
        />
        {kind === 'new' ? (
          <TextField
            label={t('import.projectName')}
            value={name}
            maxLength={120}
            onChange={(e) => setName(e.target.value)}
          />
        ) : (
          <SelectField
            label={t('task.project')}
            value={existingId}
            onChange={(e) => setExistingId(e.target.value)}
            options={writable.map((p) => ({
              value: p.id,
              label: p.isInbox ? t('project.inbox') : p.name,
            }))}
          />
        )}
      </div>
      {counts.comments > 0 && (
        <Checkbox
          label={t('import.includeComments')}
          checked={includeComments}
          onChange={(e) => setIncludeComments(e.target.checked)}
        />
      )}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => void run()} disabled={!canImport}>
          {t('import.import')}
        </Button>
      </div>
    </div>
  );
}
