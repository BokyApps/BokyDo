import type { Due } from '@bokydo/shared';
import { useRef, useState, type FormEvent } from 'react';
import { useTaskActions } from '../lib/actions.js';
import { useSyncState } from '../lib/sync.js';
import type { AddDefaults } from '../lib/task-ui.js';
import { DatePicker, LabelPicker, PriorityPicker, ProjectPicker } from './pickers.js';
import { Button } from './ui.js';

/**
 * Task composer used inline ("Add task" under a list) and in Quick add. Plain text for now:
 * natural-language parsing ("tomorrow 5pm #Work p1") arrives with W3.
 */
export function TaskEditor({
  defaults,
  onDone,
  keepOpen = false,
}: {
  defaults: AddDefaults;
  onDone: () => void;
  keepOpen?: boolean;
}) {
  const state = useSyncState();
  const actions = useTaskActions();
  const [content, setContent] = useState('');
  const [description, setDescription] = useState('');
  const [due, setDue] = useState<Due | null>(defaults.due ?? null);
  const [priority, setPriority] = useState(4);
  const [labels, setLabels] = useState<string[]>(defaults.labels ?? []);
  const [where, setWhere] = useState({
    projectId: defaults.projectId ?? state.user?.inboxProjectId ?? '',
    sectionId: defaults.sectionId ?? null,
  });
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const isSubtask = Boolean(defaults.parentId);

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    // Pasting several lines creates one task per line (as in Todoist).
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
    if (lines.length === 0) return;
    for (const line of lines) {
      actions.add({
        content: line.slice(0, 1000),
        ...(lines.length === 1 && description.trim() ? { description } : {}),
        ...(isSubtask
          ? { parentId: defaults.parentId }
          : { projectId: where.projectId, sectionId: where.sectionId }),
        priority,
        due,
        labels,
      });
    }
    setContent('');
    setDescription('');
    if (keepOpen) contentRef.current?.focus();
    else onDone();
  };

  return (
    <form
      onSubmit={submit}
      className="space-y-2 rounded-xl border border-line bg-surface p-3"
      onKeyDown={(e) => e.key === 'Escape' && onDone()}
    >
      <textarea
        ref={contentRef}
        autoFocus
        rows={1}
        aria-label="Task name"
        placeholder="Task name"
        className="w-full resize-none bg-transparent text-sm font-medium text-fg placeholder:text-muted focus:outline-none"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <textarea
        rows={1}
        aria-label="Description"
        placeholder="Description"
        className="w-full resize-none bg-transparent text-xs text-muted placeholder:text-muted/70 focus:outline-none"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex flex-wrap gap-1.5">
        <DatePicker value={due} onChange={setDue} />
        <PriorityPicker value={priority} onChange={setPriority} />
        <LabelPicker value={labels} onChange={setLabels} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
        {isSubtask ? (
          <span />
        ) : (
          <ProjectPicker
            projectId={where.projectId}
            sectionId={where.sectionId}
            onChange={(to) => setWhere(to)}
          />
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={!content.trim()}>
            Add task
          </Button>
        </div>
      </div>
    </form>
  );
}

export function InlineAdd({
  defaults,
  label = 'Add task',
}: {
  defaults: AddDefaults;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  if (open)
    return (
      <div className="py-2">
        <TaskEditor defaults={defaults} onDone={() => setOpen(false)} keepOpen />
      </div>
    );
  return (
    <button
      type="button"
      onClick={() => setOpen(true)}
      className="group flex w-full items-center gap-2 px-1 py-2 text-sm text-muted hover:text-accent"
    >
      <span className="flex size-[1.15rem] items-center justify-center rounded-full text-accent group-hover:bg-accent group-hover:text-on-accent">
        +
      </span>
      {label}
    </button>
  );
}
