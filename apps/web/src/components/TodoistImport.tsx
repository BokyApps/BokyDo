import {
  type TodoistCompletedWindow,
  type TodoistImportChoices,
  type TodoistImportPlanSummary,
  type TodoistImportRun,
  type TodoistImportWarning,
  type TodoistPreview,
  type TodoistPreviewFilter,
  type TodoistPreviewProject,
} from '@bokydo/shared';
import type { SyncState } from '@bokydo/sync-client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { useStore, useSyncState } from '../lib/sync.js';
import {
  buildChoicesBody,
  choiceFromValue,
  choiceValue,
  choicesKey,
  collaboratorOptions,
  countRows,
  defaultDraft,
  filterNotes,
  groupWarnings,
  mergeTargets,
  projectRows,
  runErrorMessage,
  teamOptions,
  type ImportDraft,
  type MergeTarget,
  type ProjectChoice,
} from '../lib/todoist-import.js';
import { Alert, Button, Card, Checkbox, SelectField, TextField } from './ui.js';

const CONNECT = '/api/v1/import/todoist/connect';
const DISCONNECT = '/api/v1/import/todoist/disconnect';
const PLAN = '/api/v1/import/todoist/plan';
const RUNS = '/api/v1/import/todoist/runs';
const LATEST = '/api/v1/import/todoist/runs/latest';
const LATEST_KEY = ['todoist-import-latest'];
const RUN_POLL_MS = 1500;

const isCode = (err: unknown, code: string) => err instanceof ApiError && err.code === code;
const withMember = (set: Set<string>, id: string, on: boolean) => {
  const next = new Set(set);
  if (on) next.add(id);
  else next.delete(id);
  return next;
};

/**
 * Settings → Your data → Import from Todoist. Connect (the token is sent once and dropped), choose
 * what comes over, check it with a dry run, then import in the background and watch the progress.
 */
export function TodoistImport() {
  const { t } = useTranslation();
  return (
    <Card>
      <h2 className="mb-1 font-semibold">{t('import.title')}</h2>
      <p className="mb-4 text-sm text-muted">{t('import.description')}</p>
      <TodoistImportFlow />
    </Card>
  );
}

function TodoistImportFlow() {
  const { t } = useTranslation();
  const store = useStore();
  const state = useSyncState();
  const queryClient = useQueryClient();
  const targets = useMemo(() => mergeTargets(state, t), [state, t]);
  const checkHintId = useId();
  const [token, setToken] = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<unknown>(null);
  const [expired, setExpired] = useState(false);
  const [preview, setPreview] = useState<TodoistPreview | null>(null);
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [planned, setPlanned] = useState<{ key: string; summary: TodoistImportPlanSummary } | null>(
    null,
  );
  const [runId, setRunId] = useState<string | null>(null);

  const latest = useQuery({
    queryKey: LATEST_KEY,
    queryFn: async () => (await api<{ run: TodoistImportRun | null }>('GET', LATEST)).run,
    staleTime: 0,
  });
  const run = useQuery({
    queryKey: ['todoist-import-run', runId],
    queryFn: async () => (await api<{ run: TodoistImportRun }>('GET', `${RUNS}/${runId}`)).run,
    enabled: runId !== null,
    refetchInterval: (q) =>
      q.state.status !== 'error' && (q.state.data?.status ?? 'running') === 'running'
        ? RUN_POLL_MS
        : false,
  });
  const runStatus = run.data?.status;
  const runActive =
    runId !== null && !run.isError && runStatus !== 'done' && runStatus !== 'failed';

  // A run started before this page opened (or in another tab) is followed here. The state is
  // adjusted while rendering, when the latest-run answer changes, rather than in an effect.
  const [seenLatest, setSeenLatest] = useState(latest.data);
  if (latest.data !== seenLatest) {
    setSeenLatest(latest.data);
    if (runId === null && latest.data?.status === 'running') setRunId(latest.data.id);
  }

  // When a run ends, pull so the new projects show up in the sidebar.
  useEffect(() => {
    if (runStatus === 'done' || runStatus === 'failed') {
      void store.pull();
      void queryClient.invalidateQueries({ queryKey: LATEST_KEY });
    }
  }, [runStatus, runId, store, queryClient]);

  const expire = () => {
    setExpired(true);
    setPreview(null);
    setDraft(null);
    setPlanned(null);
  };

  const plan = useMutation({
    mutationFn: async (body: TodoistImportChoices) => ({
      key: choicesKey(body),
      summary: await api<TodoistImportPlanSummary>('POST', PLAN, body),
    }),
    onSuccess: (result) => setPlanned(result),
    onError: (err) => {
      if (isCode(err, 'session_expired')) expire();
    },
  });
  const start = useMutation({
    mutationFn: (body: TodoistImportChoices) => api<{ id: string }>('POST', RUNS, body),
    onSuccess: ({ id }) => setRunId(id),
    onError: (err) => {
      if (isCode(err, 'session_expired')) expire();
      if (isCode(err, 'import_running'))
        void queryClient.invalidateQueries({ queryKey: LATEST_KEY });
    },
  });

  /** Any change to the choices makes the dry run stale. */
  const edit = (change: (d: ImportDraft) => ImportDraft) => {
    setDraft((d) => (d ? change(d) : d));
    setPlanned(null);
    plan.reset();
  };

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    // The token leaves the form state as soon as it is sent: only this request holds it.
    const value = token;
    setToken('');
    setConnecting(true);
    setConnectError(null);
    try {
      const next = await api<TodoistPreview>('POST', CONNECT, { token: value });
      setPreview(next);
      setDraft(defaultDraft(next, targets));
      setExpired(false);
      setPlanned(null);
      plan.reset();
      if (!runActive) setRunId(null);
    } catch (err) {
      setConnectError(err);
    } finally {
      setConnecting(false);
    }
  };

  const startOver = async () => {
    const sessionId = preview?.sessionId;
    setPreview(null);
    setDraft(null);
    setPlanned(null);
    setExpired(false);
    setRunId(null);
    plan.reset();
    start.reset();
    if (sessionId) await api('POST', DISCONNECT, { sessionId }).catch(() => undefined);
  };

  const body = preview && draft ? buildChoicesBody(preview, draft) : null;
  const key = body ? choicesKey(body) : null;
  const checked = planned && planned.key === key ? planned.summary : null;
  const canImport = checked !== null && !start.isPending && !runActive;

  return (
    <div className="space-y-6">
      {expired && <Alert tone="warning">{t('import.expired')}</Alert>}
      {runId !== null && <RunPanel run={run.data} error={run.isError ? run.error : null} />}

      {preview && draft ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-sm">
              {t('import.connectedAs', {
                name: preview.account.name,
                email: preview.account.email,
                until: new Date(preview.expiresAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit',
                }),
              })}
            </p>
            <Button variant="ghost" disabled={runActive} onClick={() => void startOver()}>
              {t('import.startOver')}
            </Button>
          </div>
          <ChooseSections
            preview={preview}
            draft={draft}
            state={state}
            targets={targets}
            edit={edit}
          />
          <div className="space-y-3 border-t border-line pt-4">
            <p aria-live="polite" className="text-sm font-medium">
              {checked ? t('import.checkFinished') : ''}
            </p>
            {plan.isError && <Alert tone="error">{errorMessage(plan.error)}</Alert>}
            {start.isError && <Alert tone="error">{errorMessage(start.error)}</Alert>}
            {checked && <PlanResult summary={checked} />}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                busy={plan.isPending}
                aria-describedby={checkHintId}
                onClick={() => body && plan.mutate(body)}
              >
                {t('import.check')}
              </Button>
              <Button
                busy={start.isPending}
                disabled={!canImport}
                aria-describedby={checkHintId}
                onClick={() => body && start.mutate(body)}
              >
                {t('import.import')}
              </Button>
            </div>
            <p id={checkHintId} className="text-xs text-muted">
              {runActive
                ? t('import.hintRunning')
                : checked
                  ? t('import.hintReady')
                  : t('import.hintCheckFirst')}
            </p>
          </div>
        </>
      ) : (
        <ConnectForm
          token={token}
          onToken={setToken}
          onSubmit={(e) => void connect(e)}
          busy={connecting}
          error={connectError}
        />
      )}
    </div>
  );
}

function ConnectForm({
  token,
  onToken,
  onSubmit,
  busy,
  error,
}: {
  token: string;
  onToken: (value: string) => void;
  onSubmit: (e: FormEvent) => void;
  busy: boolean;
  error: unknown;
}) {
  const { t } = useTranslation();
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <p className="text-sm text-muted">{t('import.connectIntro')}</p>
      <TextField
        label={t('import.token')}
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(e) => onToken(e.target.value)}
        required
      />
      {error !== null && <Alert tone="error">{errorMessage(error)}</Alert>}
      <Button type="submit" busy={busy} disabled={!token.trim()}>
        {t('import.connect')}
      </Button>
    </form>
  );
}

function ChooseSections({
  preview,
  draft,
  state,
  targets,
  edit,
}: {
  preview: TodoistPreview;
  draft: ImportDraft;
  state: SyncState;
  targets: MergeTarget[];
  edit: (change: (d: ImportDraft) => ImportDraft) => void;
}) {
  return (
    <>
      <ProjectsSection
        preview={preview}
        draft={draft}
        state={state}
        targets={targets}
        edit={edit}
      />
      <LabelsSection preview={preview} draft={draft} edit={edit} />
      <FiltersSection preview={preview} draft={draft} edit={edit} />
      <CommentsSection preview={preview} draft={draft} edit={edit} />
      <PeopleSection preview={preview} draft={draft} state={state} edit={edit} />
    </>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="space-y-3 border-t border-line pt-4">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {children}
    </section>
  );
}

function ProjectsSection({
  preview,
  draft,
  state,
  targets,
  edit,
}: {
  preview: TodoistPreview;
  draft: ImportDraft;
  state: SyncState;
  targets: MergeTarget[];
  edit: (change: (d: ImportDraft) => ImportDraft) => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => projectRows(preview.projects), [preview.projects]);
  const teams = teamOptions(state);
  const actionOptions = [
    { value: 'new', label: t('import.actionNew') },
    ...targets.map((target) => ({
      value: `merge:${target.id}`,
      label: t('import.actionMerge', { name: target.label }),
    })),
    { value: 'skip', label: t('import.actionSkip') },
  ];
  const teamOptionsList = [
    { value: '', label: t('import.personalTeam') },
    ...teams.map((team) => ({ value: team.id, label: team.name })),
  ];
  const nameOf = (id: string) => state.projects.get(id)?.name ?? t('import.bokyDoProject');
  const setChoice = (id: string, choice: ProjectChoice) =>
    edit((d) => ({ ...d, projects: new Map(d.projects).set(id, choice) }));
  const { totals } = preview;

  return (
    <Section
      title={t('import.projectsTitle')}
      hint={t('import.projectsHint', {
        projects: t('import.countProject', { count: totals.projects }),
        tasks: t('import.countTask', { count: totals.tasks }),
        sections: t('import.countSection', { count: totals.sections }),
        comments: t('import.countComment', { count: totals.comments }),
      })}
    >
      <ul className="divide-y divide-line">
        {rows.map(({ project: p, depth }) => {
          const choice = draft.projects.get(p.id) ?? { action: 'skip' as const };
          const title = p.isInbox ? t('import.todoistInbox') : p.name;
          return (
            <li key={p.id} className="py-3" style={{ paddingLeft: `${depth * 1.25}rem` }}>
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="font-medium break-words">{title}</p>
                  <ProjectNotes project={p} nameOf={nameOf} />
                </div>
                <div className="w-full space-y-2 sm:w-64">
                  <SelectField
                    label={t('import.actionFor', { title })}
                    hideLabel
                    value={choiceValue(choice)}
                    options={actionOptions}
                    onChange={(e) => setChoice(p.id, choiceFromValue(e.target.value, choice))}
                  />
                  {choice.action === 'new' && !p.parentId && teams.length > 0 && (
                    <SelectField
                      label={t('import.teamFor', { title })}
                      hideLabel
                      value={choice.workspaceId ?? ''}
                      options={teamOptionsList}
                      onChange={(e) =>
                        setChoice(p.id, { action: 'new', workspaceId: e.target.value || null })
                      }
                    />
                  )}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function ProjectNotes({
  project: p,
  nameOf,
}: {
  project: TodoistPreviewProject;
  nameOf: (id: string) => string;
}) {
  const { t } = useTranslation();
  return (
    <>
      <p className="text-xs text-muted">
        {t('import.notesCounts', {
          tasks: t('import.countTask', { count: p.tasks }),
          sections: t('import.countSection', { count: p.sections }),
          comments: t('import.countComment', { count: p.comments }),
        })}
      </p>
      {p.isArchived && <p className="text-xs text-muted">{t('import.notesArchived')}</p>}
      {p.isShared && <p className="text-xs text-muted">{t('import.notesShared')}</p>}
      {p.importedAs && (
        <p className="text-xs text-muted">{t('import.notesImportedAs', { name: nameOf(p.importedAs) })}</p>
      )}
    </>
  );
}

function LabelsSection({
  preview,
  draft,
  edit,
}: {
  preview: TodoistPreview;
  draft: ImportDraft;
  edit: (change: (d: ImportDraft) => ImportDraft) => void;
}) {
  const { t } = useTranslation();
  return (
    <Section title={t('import.labelsTitle')}>
      {preview.labels.length === 0 && <p className="text-sm text-muted">{t('import.noLabels')}</p>}
      {preview.labels.map((l) => (
        <Checkbox
          key={l.id}
          label={l.name}
          hint={
            l.invalid
              ? t('import.labelInvalid')
              : `${t('import.countTask', { count: l.tasks })}${
                  l.exists ? t('import.labelMerges') : ''
                }`
          }
          disabled={l.invalid}
          checked={!l.invalid && draft.labels.has(l.id)}
          onChange={(e) =>
            edit((d) => ({ ...d, labels: withMember(d.labels, l.id, e.target.checked) }))
          }
        />
      ))}
    </Section>
  );
}

function FiltersSection({
  preview,
  draft,
  edit,
}: {
  preview: TodoistPreview;
  draft: ImportDraft;
  edit: (change: (d: ImportDraft) => ImportDraft) => void;
}) {
  const { t } = useTranslation();
  return (
    <Section title={t('import.filtersTitle')}>
      {preview.filters.length === 0 && <p className="text-sm text-muted">{t('import.noFilters')}</p>}
      {preview.filters.map((f: TodoistPreviewFilter) => (
        <Checkbox
          key={f.id}
          label={f.name}
          hint={
            <span className="block space-y-1">
              <code className="block font-mono break-all">{f.query}</code>
              {filterNotes(t, f, preview, draft).map((note) => (
                <span key={note} className="block">
                  {note}
                </span>
              ))}
            </span>
          }
          disabled={!f.supported}
          checked={f.supported && draft.filters.has(f.id)}
          onChange={(e) =>
            edit((d) => ({ ...d, filters: withMember(d.filters, f.id, e.target.checked) }))
          }
        />
      ))}
    </Section>
  );
}

function CommentsSection({
  preview,
  draft,
  edit,
}: {
  preview: TodoistPreview;
  draft: ImportDraft;
  edit: (change: (d: ImportDraft) => ImportDraft) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Section title={t('import.commentsTitle')}>
        <Checkbox
          label={t('import.commentsLabel')}
          hint={t('import.commentsHint', {
            comments: t('import.countComment', { count: preview.totals.comments }),
          })}
          checked={draft.comments}
          onChange={(e) => edit((d) => ({ ...d, comments: e.target.checked }))}
        />
      </Section>
      <Section title={t('import.completedTitle')}>
        <Checkbox
          label={t('import.completedLabel')}
          hint={
            preview.totals.completed > 0
              ? t('import.completedHint', {
                  completed: t('import.countCompleted', { count: preview.totals.completed }),
                })
              : t('import.completedNone')
          }
          checked={draft.completed}
          onChange={(e) => edit((d) => ({ ...d, completed: e.target.checked }))}
        />
        {draft.completed && (
          <div className="mt-4">
            <SelectField
              label={t('import.completedWindow')}
              value={draft.completedWindow}
              onChange={(e) =>
                edit((d) => ({ ...d, completedWindow: e.target.value as TodoistCompletedWindow }))
              }
              options={[
                { value: '1m', label: t('import.completedWindow1m') },
                { value: '3m', label: t('import.completedWindow3m') },
              ]}
              hint={t('import.completedWindowHint')}
            />
          </div>
        )}
      </Section>
    </>
  );
}

function PeopleSection({
  preview,
  draft,
  state,
  edit,
}: {
  preview: TodoistPreview;
  draft: ImportDraft;
  state: SyncState;
  edit: (change: (d: ImportDraft) => ImportDraft) => void;
}) {
  const { t } = useTranslation();
  const others = preview.people.filter((p) => !p.isYou);
  const userOptions = [
    { value: '', label: t('import.leaveUnassigned') },
    ...collaboratorOptions(state).map((c) => ({ value: c.id, label: c.username })),
  ];
  return (
    <Section
      title={t('import.peopleTitle')}
      hint={t('import.peopleHint')}
    >
      {others.length === 0 && (
        <p className="text-sm text-muted">{t('import.noOthers')}</p>
      )}
      {others.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium break-words">{p.name}</p>
            {p.email && <p className="text-xs text-muted break-all">{p.email}</p>}
          </div>
          <div className="w-full sm:w-64">
            <SelectField
              label={t('import.userFor', { name: p.name })}
              hideLabel
              value={draft.people.get(p.id) ?? ''}
              options={userOptions}
              onChange={(e) =>
                edit((d) => ({
                  ...d,
                  people: new Map(d.people).set(p.id, e.target.value || null),
                }))
              }
            />
          </div>
        </div>
      ))}
    </Section>
  );
}

function PlanResult({ summary }: { summary: TodoistImportPlanSummary }) {
  const { t } = useTranslation();
  return (
    <div className="space-y-3 rounded-lg bg-surface-alt p-3">
      <p className="text-sm font-medium">{t('import.planHeading')}</p>
      <CountList rows={countRows(t, summary.counts)} />
      <WarningGroups warnings={summary.warnings} more={summary.moreWarnings} />
    </div>
  );
}

function CountList({ rows }: { rows: { label: string; value: number }[] }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
      {rows.map((r) => (
        <div key={r.label}>
          <dt className="text-xs text-muted">{r.label}</dt>
          <dd className="font-medium tabular-nums">{r.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function WarningGroups({ warnings, more }: { warnings: TodoistImportWarning[]; more: number }) {
  const { t } = useTranslation();
  const groups = groupWarnings(t, warnings);
  if (groups.length === 0 && more === 0)
    return <p className="text-sm text-muted">{t('import.noWarnings')}</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t('import.thingsToCheck')}</p>
      {groups.map((g) => (
        <details
          key={g.kind}
          open={g.messages.length <= 3}
          className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"
        >
          <summary className="cursor-pointer font-medium">
            {t('import.warningGroup', { label: g.label, count: g.messages.length })}
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
            {g.messages.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </details>
      ))}
      {more > 0 && <p className="text-sm text-muted">{t('import.andMoreWarning', { count: more })}</p>}
    </div>
  );
}

function RunPanel({ run, error }: { run: TodoistImportRun | undefined; error: unknown }) {
  const { t } = useTranslation();
  const headingId = useId();
  const progressId = useId();
  if (error !== null) return <Alert tone="error">{errorMessage(error)}</Alert>;
  if (!run) return <p className="text-sm text-muted">{t('import.startingRun')}</p>;
  const status =
    run.status === 'running'
      ? t('import.statusRunning')
      : run.status === 'done'
        ? t('import.statusDone')
        : t('import.statusFailed');
  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-lg border border-line p-4">
      <h3 id={headingId} className="text-sm font-semibold">
        {t('import.title')}
      </h3>
      <p aria-live="polite" className="text-sm font-medium">
        {status}
      </p>
      {run.status === 'running' && (
        <div className="space-y-1">
          <p id={progressId} className="text-sm">
            {t('import.progress', { done: run.done, total: run.total })}
          </p>
          <progress
            aria-labelledby={progressId}
            value={run.total > 0 ? run.done : undefined}
            max={run.total > 0 ? run.total : undefined}
            className="h-2 w-full accent-accent"
          />
        </div>
      )}
      {run.status === 'done' && run.counts && (
        <>
          <CountList rows={countRows(t, run.counts)} />
          <WarningGroups warnings={run.warnings} more={0} />
        </>
      )}
      {run.status === 'failed' && <Alert tone="error">{runErrorMessage(t, run.error)}</Alert>}
    </section>
  );
}
