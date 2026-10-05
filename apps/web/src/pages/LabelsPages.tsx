import { COLORS, type Color, type Filter, type Label } from '@bokydo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { EditIcon, PlusIcon, StarIcon, TagIcon, TrashIcon } from '../components/icons.js';
import { ProjectDot } from '../components/pickers.js';
import { Board } from '../components/Board.js';
import { TaskCollection } from '../components/TaskViews.js';
import {
  Alert,
  Button,
  Checkbox,
  Dialog,
  IconButton,
  SelectField,
  TextField,
} from '../components/ui.js';
import { EmptyState, Page, ViewHeader } from '../components/ViewHeader.js';
import { useConfirm } from '../lib/confirm.js';
import { newId, useSend, useSyncState } from '../lib/sync.js';
import { useTaskUI } from '../lib/task-ui.js';
import { useViewOptions } from '../lib/view-options.js';
import { useFilter } from '../lib/filters.js';
import {
  allLabelNames,
  labelTasks,
  projectOrderIndex,
  projectTree,
  sortTasks,
} from '../lib/views.js';

const colorVar = (c: string) => `var(--bk-project-${c.replace(/_/g, '-')})`;
const colorOptions = COLORS.map((c) => ({
  value: c,
  label: c.replace(/_/g, ' ').replace(/^./, (x) => x.toUpperCase()),
}));

export function LabelPage({ name }: { name: string }) {
  const state = useSyncState();
  const { setViewDefaults } = useTaskUI();
  const [options, setOptions] = useViewOptions(`label.${name.toLowerCase()}`, { sort: 'manual' });
  useEffect(() => setViewDefaults({ labels: [name] }), [name, setViewDefaults]);
  const tasks = labelTasks(state, name);
  return (
    <Page wide={options.layout !== 'list'}>
      <ViewHeader
        title={`@${name}`}
        options={options}
        setOptions={setOptions}
        layout={{ value: options.layout, onChange: (layout) => setOptions({ layout }) }}
      />
      <TaskCollection tasks={tasks} options={options} addDefaults={{ labels: [name] }} />
      {tasks.length === 0 && options.layout === 'list' && (
        <EmptyState title={`No open tasks with @${name}`} />
      )}
    </Page>
  );
}

export function FilterPage({ id }: { id: string }) {
  const state = useSyncState();
  const send = useSend();
  const filter = state.filters.get(id);
  const [options, setOptions] = useViewOptions(`filter.${id}`, { sort: 'date' });
  const [editing, setEditing] = useState(false);
  const result = useFilter(filter?.query ?? 'all');
  if (!filter)
    return (
      <Page>
        <EmptyState title="Filter not found" />
      </Page>
    );
  const lists = result.ok ? result.lists : [];
  const multiple = lists.length > 1;
  return (
    <Page wide={options.layout !== 'list'}>
      <ViewHeader
        title={filter.name}
        subtitle={<code className="font-mono">{filter.query}</code>}
        options={options}
        setOptions={setOptions}
        layout={{ value: options.layout, onChange: (layout) => setOptions({ layout }) }}
        actions={
          <>
            <IconButton
              label={filter.isFavorite ? 'Remove from favourites' : 'Add to favourites'}
              onClick={() =>
                send('filter_update', { id: filter.id, isFavorite: !filter.isFavorite })
              }
            >
              <StarIcon filled={filter.isFavorite} />
            </IconButton>
            <IconButton label="Edit filter" onClick={() => setEditing(true)}>
              <EditIcon />
            </IconButton>
          </>
        }
      />
      {!result.ok && (
        <Alert tone="error">
          This filter doesn't work any more: {result.error.message}.{' '}
          <button type="button" className="underline" onClick={() => setEditing(true)}>
            Edit it
          </button>
        </Alert>
      )}
      {result.ok &&
        result.warnings.map((w) => (
          <p key={w} className="mb-2 text-sm text-muted">
            {w}
          </p>
        ))}
      {multiple && options.layout === 'board' ? (
        <Board
          columns={lists.map((l, i) => ({
            id: `list-${i}`,
            title: l.query,
            tasks: sortTasks(l.tasks, options.sort, projectOrderIndex(state)),
            droppable: false,
          }))}
          onDrop={() => undefined}
          showProject
        />
      ) : multiple && options.layout === 'list' ? (
        lists.map((l, i) => (
          <section key={i} className="mb-6">
            <h2 className="flex items-baseline justify-between border-b border-line pb-1 font-semibold">
              <code className="font-mono text-sm">{l.query}</code>
              <span className="text-xs font-normal text-muted">{l.tasks.length}</span>
            </h2>
            <TaskCollection tasks={l.tasks} options={options} showAdd={false} />
            {l.tasks.length === 0 && <p className="py-2 text-sm text-muted">Nothing here.</p>}
          </section>
        ))
      ) : (
        <TaskCollection
          tasks={[...new Map(lists.flatMap((l) => l.tasks).map((t) => [t.id, t])).values()]}
          options={options}
          showAdd={false}
        />
      )}
      {result.ok &&
        lists.every((l) => l.tasks.length === 0) &&
        options.layout === 'list' &&
        !multiple && <EmptyState title="No tasks match this filter" />}
      <FilterDialog value={editing ? filter : null} onClose={() => setEditing(false)} />
    </Page>
  );
}

export function FiltersLabelsPage() {
  const state = useSyncState();
  const send = useSend();
  const confirm = useConfirm();
  const [editingLabel, setEditingLabel] = useState<Label | 'new' | null>(null);
  const [editingFilter, setEditingFilter] = useState<Filter | 'new' | null>(null);
  const labels = [...state.labels.values()].sort((a, b) => (a.itemOrder < b.itemOrder ? -1 : 1));
  const own = new Set(labels.map((l) => l.name.toLowerCase()));
  const shared = allLabelNames(state).filter((n) => !own.has(n.toLowerCase()));
  const count = (name: string) => labelTasks(state, name).length;
  const filters = [...state.filters.values()].sort((a, b) => (a.itemOrder < b.itemOrder ? -1 : 1));

  return (
    <Page>
      <ViewHeader title="Filters & Labels" />
      <section className="mb-8">
        <div className="flex items-center justify-between border-b border-line pb-1">
          <h2 className="font-semibold">Filters</h2>
          <IconButton label="Add filter" onClick={() => setEditingFilter('new')}>
            <PlusIcon />
          </IconButton>
        </div>
        <ul>
          {filters.map((f) => (
            <li
              key={f.id}
              className="group flex items-center gap-2 border-b border-line py-2 text-sm"
            >
              <span style={{ color: colorVar(f.color) }}>⚲</span>
              <Link
                to="/filter/$filterId"
                params={{ filterId: f.id }}
                className="flex-1 hover:underline"
              >
                {f.name}
              </Link>
              <code className="hidden truncate font-mono text-xs text-muted sm:block">
                {f.query}
              </code>
              <RowActions
                favorite={f.isFavorite}
                onFavorite={() => send('filter_update', { id: f.id, isFavorite: !f.isFavorite })}
                onEdit={() => setEditingFilter(f)}
                onDelete={() =>
                  void confirm({
                    title: 'Delete filter?',
                    message: `“${f.name}” will be deleted.`,
                    confirmLabel: 'Delete',
                    danger: true,
                  }).then((ok) => ok && send('filter_delete', { id: f.id }))
                }
              />
            </li>
          ))}
        </ul>
        {filters.length === 0 && <p className="py-2 text-sm text-muted">No filters yet.</p>}
      </section>

      <section>
        <div className="flex items-center justify-between border-b border-line pb-1">
          <h2 className="font-semibold">Labels</h2>
          <IconButton label="Add label" onClick={() => setEditingLabel('new')}>
            <PlusIcon />
          </IconButton>
        </div>
        <ul>
          {labels.map((l) => (
            <li
              key={l.id}
              className="group flex items-center gap-2 border-b border-line py-2 text-sm"
            >
              <span style={{ color: colorVar(l.color) }}>
                <TagIcon />
              </span>
              <Link to="/label/$name" params={{ name: l.name }} className="flex-1 hover:underline">
                {l.name}
              </Link>
              <span className="text-xs text-muted">{count(l.name) || ''}</span>
              <RowActions
                favorite={l.isFavorite}
                onFavorite={() => send('label_update', { id: l.id, isFavorite: !l.isFavorite })}
                onEdit={() => setEditingLabel(l)}
                onDelete={() =>
                  void confirm({
                    title: 'Delete label?',
                    message: `@${l.name} will be removed from all tasks you can edit.`,
                    confirmLabel: 'Delete',
                    danger: true,
                  }).then((ok) => ok && send('label_delete', { id: l.id }))
                }
              />
            </li>
          ))}
          {shared.map((n) => (
            <li key={n} className="flex items-center gap-2 border-b border-line py-2 text-sm">
              <span className="text-muted">
                <TagIcon />
              </span>
              <Link to="/label/$name" params={{ name: n }} className="flex-1 hover:underline">
                {n}
              </Link>
              <span className="text-xs text-muted">{count(n) || ''} · used on tasks</span>
            </li>
          ))}
        </ul>
        {labels.length + shared.length === 0 && (
          <p className="py-2 text-sm text-muted">
            No labels yet. Add one here or type a new one when tagging a task.
          </p>
        )}
      </section>
      <LabelDialog value={editingLabel} onClose={() => setEditingLabel(null)} />
      <FilterDialog value={editingFilter} onClose={() => setEditingFilter(null)} />
    </Page>
  );
}

function RowActions({
  favorite,
  onFavorite,
  onEdit,
  onDelete,
}: {
  favorite: boolean;
  onFavorite: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <span className="flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
      <IconButton
        label={favorite ? 'Remove from favourites' : 'Add to favourites'}
        onClick={onFavorite}
      >
        <StarIcon filled={favorite} />
      </IconButton>
      <IconButton label="Edit" onClick={onEdit}>
        <EditIcon />
      </IconButton>
      <IconButton label="Delete" onClick={onDelete}>
        <TrashIcon />
      </IconButton>
    </span>
  );
}

function LabelDialog({ value, onClose }: { value: Label | 'new' | null; onClose: () => void }) {
  const label = value === 'new' ? null : value;
  return (
    <Dialog open={value !== null} onClose={onClose} title={label ? 'Edit label' : 'Add label'}>
      <LabelForm key={label?.id ?? 'new'} label={label} onClose={onClose} />
    </Dialog>
  );
}

function LabelForm({ label, onClose }: { label: Label | null; onClose: () => void }) {
  const send = useSend();
  const [name, setName] = useState(label?.name ?? '');
  const [color, setColor] = useState<Color>(label?.color ?? 'charcoal');
  const [favorite, setFavorite] = useState(label?.isFavorite ?? false);
  const valid = /^[^\s@#]{1,60}$/.test(name.trim());
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    if (label)
      send('label_update', { id: label.id, name: name.trim(), color, isFavorite: favorite });
    else send('label_add', { id: newId(), name: name.trim(), color, isFavorite: favorite });
    onClose();
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <TextField
        label="Name"
        autoFocus
        required
        maxLength={60}
        value={name}
        onChange={(e) => setName(e.target.value)}
        hint="No spaces, @ or #."
      />
      <SelectField
        label="Colour"
        value={color}
        onChange={(e) => setColor(e.target.value as Color)}
        options={colorOptions}
      />
      <Checkbox
        label="Add to favourites"
        checked={favorite}
        onChange={(e) => setFavorite(e.target.checked)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid}>
          {label ? 'Save' : 'Add'}
        </Button>
      </div>
    </form>
  );
}

function FilterDialog({ value, onClose }: { value: Filter | 'new' | null; onClose: () => void }) {
  const filter = value === 'new' ? null : value;
  return (
    <Dialog open={value !== null} onClose={onClose} title={filter ? 'Edit filter' : 'Add filter'}>
      <FilterForm key={filter?.id ?? 'new'} filter={filter} onClose={onClose} />
    </Dialog>
  );
}

function FilterForm({ filter, onClose }: { filter: Filter | null; onClose: () => void }) {
  const send = useSend();
  const [name, setName] = useState(filter?.name ?? '');
  const [query, setQuery] = useState(filter?.query ?? '');
  const [color, setColor] = useState<Color>(filter?.color ?? 'charcoal');
  const result = useFilter(query.trim() || 'all');
  const valid = Boolean(query.trim()) && result.ok;
  const matches = result.ok
    ? new Set(result.lists.flatMap((l) => l.tasks.map((t) => t.id))).size
    : 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !valid) return;
    if (filter)
      send('filter_update', { id: filter.id, name: name.trim(), query: query.trim(), color });
    else send('filter_add', { id: newId(), name: name.trim(), query: query.trim(), color });
    onClose();
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <TextField
        label="Name"
        autoFocus
        required
        maxLength={120}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField
        label="Query"
        required
        maxLength={1024}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-invalid={Boolean(query.trim()) && !result.ok}
        hint="e.g. today | overdue, #Work & p1, @errands & !no date"
      />
      {query.trim() && (
        <div className="-mt-2 text-sm" aria-live="polite">
          {!result.ok ? (
            <p className="text-danger">
              {result.error.message}
              {result.error.end > result.error.start &&
                !result.error.message.includes(
                  query.slice(result.error.start, result.error.end).trim(),
                ) && <> (at “{query.slice(result.error.start, result.error.end)}”)</>}
            </p>
          ) : (
            <>
              <p className="text-muted">
                Matches {matches} open task{matches === 1 ? '' : 's'}
                {result.lists.length > 1 ? ` in ${result.lists.length} lists` : ''}
              </p>
              {result.warnings.map((w) => (
                <p key={w} className="text-warning">
                  {w}
                </p>
              ))}
            </>
          )}
        </div>
      )}
      <FilterHelp />
      <SelectField
        label="Colour"
        value={color}
        onChange={(e) => setColor(e.target.value as Color)}
        options={colorOptions}
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!valid || !name.trim()}>
          {filter ? 'Save' : 'Add'}
        </Button>
      </div>
    </form>
  );
}

const SYNTAX: [string, string][] = [
  ['today, tomorrow, overdue', 'Due today, tomorrow, or before now'],
  ['7 days, -7 days, next week', 'Due in the next 7 days, the past 7, next week'],
  ['due before: fri, due after: jan 3', 'Before or after a date (also deadline:, created:)'],
  ['no date, no time, recurring', 'Without a date, without a time, repeating'],
  ['p1 … p4', 'Priority'],
  ['#Work, ##Work, /Next up', 'Project, project with sub-projects, section'],
  ['@errands, @home*, no labels', 'Label (with * as a wildcard), unlabelled'],
  ['search: invoice', 'Task name contains the text'],
  ['assigned to: me, subtask', 'Assigned to you, sub-tasks only'],
  ['&  |  !  ( )', 'And, or, not, grouping'],
  ['today, overdue', 'A comma shows separate lists'],
];

function FilterHelp() {
  return (
    <details className="rounded-lg border border-line px-3 py-2 text-sm">
      <summary className="cursor-pointer text-muted">Filter syntax</summary>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        {SYNTAX.map(([code, meaning]) => (
          <div key={code} className="contents">
            <dt>
              <code className="font-mono text-xs">{code}</code>
            </dt>
            <dd className="text-muted">{meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

export function ArchivedPage() {
  const state = useSyncState();
  const send = useSend();
  const navigate = useNavigate();
  const archived = projectTree(state, true).map((n) => n.project);
  return (
    <Page>
      <ViewHeader title="Archived projects" />
      <ul>
        {archived.map((p) => (
          <li key={p.id} className="flex items-center gap-2 border-b border-line py-2 text-sm">
            <ProjectDot color={p.color} />
            <button
              type="button"
              className="flex-1 text-left hover:underline"
              onClick={() =>
                void navigate({ to: '/project/$projectId', params: { projectId: p.id } })
              }
            >
              {p.name}
            </button>
            {['owner', 'admin'].includes(p.role) && (
              <Button variant="ghost" onClick={() => send('project_unarchive', { id: p.id })}>
                Unarchive
              </Button>
            )}
          </li>
        ))}
      </ul>
      {archived.length === 0 && <EmptyState title="No archived projects" />}
    </Page>
  );
}
