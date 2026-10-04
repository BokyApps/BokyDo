import { COLORS, type Color, type Filter, type Label } from '@bokydo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { EditIcon, PlusIcon, StarIcon, TagIcon, TrashIcon } from '../components/icons.js';
import { ProjectDot } from '../components/pickers.js';
import { InlineAdd } from '../components/TaskEditor.js';
import { PlainTaskList } from '../components/TaskTree.js';
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
import { todayIn } from '../lib/dates.js';
import { useTimeZone } from '../lib/sync.js';
import { useTaskUI } from '../lib/task-ui.js';
import { useViewOptions } from '../lib/view-options.js';
import {
  allLabelNames,
  groupTasks,
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
  const today = todayIn(useTimeZone());
  const { setViewDefaults } = useTaskUI();
  const [options, setOptions] = useViewOptions(`label.${name.toLowerCase()}`, { sort: 'manual' });
  useEffect(() => setViewDefaults({ labels: [name] }), [name, setViewDefaults]);
  const tasks = sortTasks(labelTasks(state, name), options.sort, projectOrderIndex(state));
  return (
    <Page>
      <ViewHeader title={`@${name}`} options={options} setOptions={setOptions} />
      {groupTasks(tasks, options.group, state, today).map((g) => (
        <section key={g.key}>
          {g.title && <h2 className="mt-4 border-b border-line pb-1 font-semibold">{g.title}</h2>}
          <PlainTaskList tasks={g.tasks} />
        </section>
      ))}
      <InlineAdd defaults={{ labels: [name] }} />
      {tasks.length === 0 && <EmptyState title={`No open tasks with @${name}`} />}
    </Page>
  );
}

export function FilterPage({ id }: { id: string }) {
  const state = useSyncState();
  const filter = state.filters.get(id);
  if (!filter)
    return (
      <Page>
        <EmptyState title="Filter not found" />
      </Page>
    );
  return (
    <Page>
      <ViewHeader
        title={filter.name}
        subtitle={<code className="font-mono">{filter.query}</code>}
      />
      <Alert tone="info">
        Running filter queries (like <code>today &amp; #Work</code>) arrives with the filter
        language in deliverable W4. Your filter is saved.
      </Alert>
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
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !query.trim()) return;
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
        hint="e.g. today | overdue, #Work & p1, @errands. Queries run once W4 lands."
      />
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
        <Button type="submit">{filter ? 'Save' : 'Add'}</Button>
      </div>
    </form>
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
