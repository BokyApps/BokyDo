import {
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
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
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
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Import from Todoist</h2>
      <p className="mb-4 text-sm text-muted">
        Bring projects, tasks, labels, filters and comments over from Todoist. You choose what comes
        and can check what would happen before anything is written. Running it again only adds what
        was skipped before.
      </p>
      <TodoistImportFlow />
    </Card>
  );
}

function TodoistImportFlow() {
  const store = useStore();
  const state = useSyncState();
  const queryClient = useQueryClient();
  const targets = useMemo(() => mergeTargets(state), [state]);
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
      {expired && (
        <Alert tone="warning">
          A Todoist connection lasts 30 minutes. Connect again to continue.
        </Alert>
      )}
      {runId !== null && <RunPanel run={run.data} error={run.isError ? run.error : null} />}

      {preview && draft ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <p className="text-sm">
              Connected as <strong>{preview.account.name}</strong> ({preview.account.email}). The
              connection lasts until{' '}
              {new Date(preview.expiresAt).toLocaleTimeString([], {
                hour: '2-digit',
                minute: '2-digit',
              })}
              .
            </p>
            <Button variant="ghost" disabled={runActive} onClick={() => void startOver()}>
              Start over
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
              {checked ? 'Check finished. Nothing has been imported yet.' : ''}
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
                Check
              </Button>
              <Button
                busy={start.isPending}
                disabled={!canImport}
                aria-describedby={checkHintId}
                onClick={() => body && start.mutate(body)}
              >
                Import
              </Button>
            </div>
            <p id={checkHintId} className="text-xs text-muted">
              {runActive
                ? 'An import is running. Its progress is shown above.'
                : checked
                  ? 'Import starts the import with these choices.'
                  : 'Check first to see what the import would do. Import is available once you have checked the current choices.'}
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
  return (
    <form onSubmit={onSubmit} className="space-y-3">
      <p className="text-sm text-muted">
        In Todoist, open Settings → Integrations → Developer and copy your API token. BokyDo uses it
        once to read your account and does not store it.
      </p>
      <TextField
        label="Todoist API token"
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={token}
        onChange={(e) => onToken(e.target.value)}
        required
      />
      {error !== null && <Alert tone="error">{errorMessage(error)}</Alert>}
      <Button type="submit" busy={busy} disabled={!token.trim()}>
        Connect to Todoist
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
  const rows = useMemo(() => projectRows(preview.projects), [preview.projects]);
  const teams = teamOptions(state);
  const actionOptions = [
    { value: 'new', label: 'Import as new' },
    ...targets.map((t) => ({ value: `merge:${t.id}`, label: `Add to ${t.label}` })),
    { value: 'skip', label: 'Skip' },
  ];
  const teamOptionsList = [
    { value: '', label: 'Personal (only you)' },
    ...teams.map((t) => ({ value: t.id, label: t.name })),
  ];
  const nameOf = (id: string) => state.projects.get(id)?.name ?? 'a BokyDo project';
  const setChoice = (id: string, choice: ProjectChoice) =>
    edit((d) => ({ ...d, projects: new Map(d.projects).set(id, choice) }));
  const { totals } = preview;

  return (
    <Section
      title="Projects"
      hint={`Found ${count(totals.projects, 'project')}, ${count(totals.tasks, 'task')}, ${count(totals.sections, 'section')} and ${count(totals.comments, 'comment')}. Projects set to Skip are not imported.`}
    >
      <ul className="divide-y divide-line">
        {rows.map(({ project: p, depth }) => {
          const choice = draft.projects.get(p.id) ?? { action: 'skip' as const };
          const title = p.isInbox ? 'Todoist Inbox' : p.name;
          return (
            <li key={p.id} className="py-3" style={{ paddingLeft: `${depth * 1.25}rem` }}>
              <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                  <p className="font-medium break-words">{title}</p>
                  <ProjectNotes project={p} nameOf={nameOf} />
                </div>
                <div className="w-full space-y-2 sm:w-64">
                  <SelectField
                    label={`What to do with ${title}`}
                    hideLabel
                    value={choiceValue(choice)}
                    options={actionOptions}
                    onChange={(e) => setChoice(p.id, choiceFromValue(e.target.value, choice))}
                  />
                  {choice.action === 'new' && !p.parentId && teams.length > 0 && (
                    <SelectField
                      label={`Team for ${title}`}
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
  return (
    <>
      <p className="text-xs text-muted">
        {count(p.tasks, 'task')} · {count(p.sections, 'section')} · {count(p.comments, 'comment')}
      </p>
      {p.isArchived && (
        <p className="text-xs text-muted">Archived in Todoist, so skipped by default.</p>
      )}
      {p.isShared && <p className="text-xs text-muted">Shared in Todoist.</p>}
      {p.importedAs && (
        <p className="text-xs text-muted">
          Imported before into {nameOf(p.importedAs)}. Only tasks not brought over yet are added.
        </p>
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
  return (
    <Section title="Labels">
      {preview.labels.length === 0 && <p className="text-sm text-muted">No labels.</p>}
      {preview.labels.map((l) => (
        <Checkbox
          key={l.id}
          label={l.name}
          hint={
            l.invalid
              ? "Can't import: has spaces, @ or #"
              : `${count(l.tasks, 'task')}${l.exists ? '. You already have this label, so it merges with yours.' : ''}`
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
  return (
    <Section title="Filters">
      {preview.filters.length === 0 && <p className="text-sm text-muted">No filters.</p>}
      {preview.filters.map((f: TodoistPreviewFilter) => (
        <Checkbox
          key={f.id}
          label={f.name}
          hint={
            <span className="block space-y-1">
              <code className="block font-mono break-all">{f.query}</code>
              {filterNotes(f, preview, draft).map((note) => (
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
  return (
    <Section title="Comments">
      <Checkbox
        label="Import comments"
        hint={`${count(preview.totals.comments, 'comment')} on tasks and projects. Attached files are not copied; a comment keeps a link to the file on Todoist.`}
        checked={draft.comments}
        onChange={(e) => edit((d) => ({ ...d, comments: e.target.checked }))}
      />
    </Section>
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
  const others = preview.people.filter((p) => !p.isYou);
  const userOptions = [
    { value: '', label: 'Leave unassigned' },
    ...collaboratorOptions(state).map((c) => ({ value: c.id, label: c.username })),
  ];
  return (
    <Section
      title="People"
      hint="Tasks assigned to someone on Todoist go to the BokyDo user you pick, or stay unassigned. Nobody is invited: their tasks are kept only where that user is already a member of the project."
    >
      {others.length === 0 && (
        <p className="text-sm text-muted">
          No one else is on this Todoist account&apos;s projects.
        </p>
      )}
      {others.map((p) => (
        <div key={p.id} className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="text-sm font-medium break-words">{p.name}</p>
            {p.email && <p className="text-xs text-muted break-all">{p.email}</p>}
          </div>
          <div className="w-full sm:w-64">
            <SelectField
              label={`BokyDo user for ${p.name}`}
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
  return (
    <div className="space-y-3 rounded-lg bg-surface-alt p-3">
      <p className="text-sm font-medium">What an import with these choices would do:</p>
      <CountList rows={countRows(summary.counts)} />
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
  const groups = groupWarnings(warnings);
  if (groups.length === 0 && more === 0) return <p className="text-sm text-muted">No warnings.</p>;
  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">Things to check</p>
      {groups.map((g) => (
        <details
          key={g.kind}
          open={g.messages.length <= 3}
          className="rounded-lg border border-line bg-surface px-3 py-2 text-sm"
        >
          <summary className="cursor-pointer font-medium">
            {g.label} ({g.messages.length})
          </summary>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-muted">
            {g.messages.map((m, i) => (
              <li key={i}>{m}</li>
            ))}
          </ul>
        </details>
      ))}
      {more > 0 && <p className="text-sm text-muted">and {more} more</p>}
    </div>
  );
}

function RunPanel({ run, error }: { run: TodoistImportRun | undefined; error: unknown }) {
  const headingId = useId();
  const progressId = useId();
  if (error !== null) return <Alert tone="error">{errorMessage(error)}</Alert>;
  if (!run) return <p className="text-sm text-muted">Starting the import…</p>;
  const status =
    run.status === 'running'
      ? 'Import running.'
      : run.status === 'done'
        ? 'Import finished.'
        : 'Import failed.';
  return (
    <section aria-labelledby={headingId} className="space-y-3 rounded-lg border border-line p-4">
      <h3 id={headingId} className="text-sm font-semibold">
        Import from Todoist
      </h3>
      <p aria-live="polite" className="text-sm font-medium">
        {status}
      </p>
      {run.status === 'running' && (
        <div className="space-y-1">
          <p id={progressId} className="text-sm">
            Changes applied: {run.done} of {run.total}
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
          <CountList rows={countRows(run.counts)} />
          <WarningGroups warnings={run.warnings} more={0} />
        </>
      )}
      {run.status === 'failed' && <Alert tone="error">{runErrorMessage(run.error)}</Alert>}
    </section>
  );
}
