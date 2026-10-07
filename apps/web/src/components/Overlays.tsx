import type { Task } from '@bokydo/shared';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useTaskActions } from '../lib/actions.js';
import { api } from '../lib/api.js';
import { usePreferences, useSyncState } from '../lib/sync.js';
import { useTaskUI } from '../lib/task-ui.js';
import { liveTasks } from '../lib/views.js';
import { CheckIcon, SearchIcon, TrashIcon } from './icons.js';
import { DatePicker, LabelPicker, PriorityPicker, ProjectDot, ProjectPicker } from './pickers.js';
import { TaskEditor } from './TaskEditor.js';
import { Button, Dialog, inputClass, Kbd } from './ui.js';

export function QuickAddDialog() {
  const ui = useTaskUI();
  return (
    <Dialog open={ui.quickAdd !== null} onClose={ui.closeQuickAdd} title="Quick add">
      {ui.quickAdd && <TaskEditor defaults={ui.quickAdd} onDone={ui.closeQuickAdd} />}
    </Dialog>
  );
}

/** Appears while tasks are multi-selected (ctrl/cmd/shift-click or x). */
export function BulkBar() {
  const ui = useTaskUI();
  const state = useSyncState();
  const actions = useTaskActions();
  const tasks = [...ui.selected]
    .map((id) => state.tasks.get(id))
    .filter((t): t is Task => Boolean(t));
  useEffect(() => {
    const onKey = (e: KeyboardEvent) =>
      e.key === 'Escape' && ui.selected.size > 0 && ui.clearSelection();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui]);
  if (tasks.length === 0) return null;
  const done = () => ui.clearSelection();
  return (
    <div
      role="toolbar"
      aria-label="Selected tasks"
      className="fixed inset-x-0 bottom-4 z-40 mx-auto flex w-fit max-w-[calc(100%-2rem)] flex-wrap items-center gap-1.5 rounded-xl border border-line bg-surface px-3 py-2 text-sm shadow-xl"
    >
      <span className="mr-2 font-medium">{tasks.length} selected</span>
      <Button
        variant="ghost"
        onClick={() => {
          actions.complete(tasks);
          done();
        }}
      >
        <CheckIcon /> Complete
      </Button>
      <DatePicker
        value={null}
        onChange={(d) => {
          actions.reschedule(tasks, d);
          done();
        }}
        label="Schedule"
      />
      <PriorityPicker
        value={4}
        onChange={(p) => {
          actions.setPriority(tasks, p);
          done();
        }}
      />
      <LabelPicker
        value={[]}
        onChange={(labels) => {
          const added = labels.at(-1);
          if (added) actions.addLabel(tasks, added);
          done();
        }}
      />
      <ProjectPicker
        projectId={tasks[0]?.projectId ?? ''}
        sectionId={null}
        onChange={(to, p) => {
          actions.move(tasks, to, p.name);
          done();
        }}
      />
      <Button
        variant="ghost"
        className="text-danger"
        onClick={() => void actions.remove(tasks).then((ok) => ok && done())}
      >
        <TrashIcon /> Delete
      </Button>
      <Button variant="ghost" onClick={done}>
        Clear
      </Button>
    </div>
  );
}

/** Ctrl/Cmd+K or "/": instant local search, plus completed tasks from the server. */
export function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const state = useSyncState();
  const ui = useTaskUI();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [remote, setRemote] = useState<Task[]>([]);
  const needle = q.trim().toLowerCase();
  const local = useMemo(() => {
    if (!needle)
      return { tasks: [] as Task[], projects: [] as { id: string; name: string; color: string }[] };
    return {
      tasks: liveTasks(state)
        .filter(
          (t) =>
            !t.isCompleted &&
            (t.content.toLowerCase().includes(needle) ||
              t.description.toLowerCase().includes(needle)),
        )
        .slice(0, 20),
      projects: [...state.projects.values()]
        .filter((p) => !p.isInbox && p.name.toLowerCase().includes(needle))
        .slice(0, 5),
    };
  }, [needle, state]);
  useEffect(() => {
    if (needle.length < 2) return;
    const timer = setTimeout(() => {
      void api<{ tasks: Task[] }>('GET', `/api/v1/search?q=${encodeURIComponent(needle)}`).then(
        (r) => setRemote(r.tasks.filter((t) => t.isCompleted)),
        () => setRemote([]),
      );
    }, 250);
    return () => clearTimeout(timer);
  }, [needle]);
  const close = () => {
    setQ('');
    onClose();
  };
  return (
    <Dialog open={open} onClose={close} title="Search">
      <div className="space-y-3">
        <div className="relative">
          <span className="absolute top-2.5 left-3 text-muted">
            <SearchIcon />
          </span>
          <input
            autoFocus
            className={`${inputClass} pl-10`}
            placeholder="Search tasks and projects"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label="Search"
          />
        </div>
        <ul className="max-h-96 space-y-0.5 overflow-y-auto text-sm">
          {local.projects.map((p) => (
            <li key={p.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-alt"
                onClick={() => {
                  close();
                  void navigate({ to: '/project/$projectId', params: { projectId: p.id } });
                }}
              >
                <ProjectDot color={p.color} /> {p.name}
              </button>
            </li>
          ))}
          {[...local.tasks, ...(needle.length >= 2 ? remote : [])].map((t) => (
            <li key={t.id}>
              <button
                type="button"
                className={`w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-alt ${t.isCompleted ? 'text-muted line-through' : ''}`}
                onClick={() => {
                  close();
                  ui.openTask(t.id);
                }}
              >
                {t.content}
                <span className="ml-2 text-xs text-muted">
                  {state.projects.get(t.projectId)?.name}
                </span>
              </button>
            </li>
          ))}
          {needle &&
            local.tasks.length +
              local.projects.length +
              (needle.length >= 2 ? remote.length : 0) ===
              0 && <li className="px-2 py-4 text-center text-muted">Nothing found.</li>}
        </ul>
      </div>
    </Dialog>
  );
}

export const SHORTCUTS: [string, string][] = [
  ['q', 'Quick add'],
  ['/ or Ctrl+K', 'Search'],
  ['g then i / t / u / f / c', 'Go to Inbox / Today / Upcoming / Filters & Labels / Completed'],
  ['↑ ↓ or j k', 'Move between tasks'],
  ['Enter or e', 'Open task'],
  ['c', 'Complete task'],
  ['1 – 4', 'Set priority'],
  ['x / Shift-click / Ctrl-click', 'Select tasks'],
  ['Delete', 'Delete task'],
  ['Ctrl+Z', 'Undo'],
  ['Esc', 'Close / clear selection'],
  ['?', 'This help'],
];

/** What still works with single-key shortcuts off: only keys that aren't a letter or digit. */
export const ALWAYS_ON_SHORTCUTS: [string, string][] = [
  ['Ctrl+K', 'Search'],
  ['↑ ↓', 'Move between tasks'],
  ['Enter', 'Open task'],
  ['Delete', 'Delete task'],
  ['Ctrl+Z', 'Undo'],
  ['Esc', 'Close / clear selection'],
];

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const enabled = usePreferences().keyboardShortcuts;
  const list = enabled ? SHORTCUTS : ALWAYS_ON_SHORTCUTS;
  return (
    <Dialog open={open} onClose={onClose} title="Keyboard shortcuts">
      <p className="mb-3 text-sm text-muted">
        {enabled
          ? 'You can turn single-key shortcuts off in Settings → General.'
          : 'Single-key shortcuts are off (Settings → General). These still work:'}
      </p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        {list.map(([k, v]) => (
          <div key={k} className="contents">
            <dt>
              <Kbd>{k}</Kbd>
            </dt>
            <dd className="text-muted">{v}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  );
}
