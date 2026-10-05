import {
  localNow,
  parseQuickAdd,
  tokenKey,
  type QuickAddOptions,
  type QuickAddResult,
  type Token,
  type Trigger,
} from '@bokydo/nlp';
import type { Due } from '@bokydo/shared';
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTaskActions } from '../lib/actions.js';
import { useConfirm } from '../lib/confirm.js';
import { dueLabel, formatDate } from '../lib/dates.js';
import { quickAddCandidates, toTaskDue } from '../lib/quick-add.js';
import { usePreferences, useSyncState, useTimeZone } from '../lib/sync.js';
import type { AddDefaults } from '../lib/task-ui.js';
import { DatePicker, LabelPicker, PriorityPicker, ProjectDot, ProjectPicker } from './pickers.js';
import { SmartInput, TOKEN_CLASS, type Suggestion } from './SmartInput.js';
import { Button } from './ui.js';

const LABEL_NAME = /^[^\s@#]{1,60}$/;

/**
 * Task composer used inline ("Add task" under a list) and in Quick add. The name is parsed as
 * you type ("Call mom tomorrow 5pm #Family @phone p1"); recognised parts are highlighted and
 * shown as chips, and removing a chip keeps that text in the name instead.
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
  const prefs = usePreferences();
  const timeZone = useTimeZone();
  const actions = useTaskActions();
  const confirm = useConfirm();
  const [content, setContent] = useState('');
  const [description, setDescription] = useState('');
  const [due, setDue] = useState<Due | null>(defaults.due ?? null);
  const [priority, setPriority] = useState(4);
  const [labels, setLabels] = useState<string[]>(defaults.labels ?? []);
  const [where, setWhere] = useState({
    projectId: defaults.projectId ?? state.user?.inboxProjectId ?? '',
    sectionId: defaults.sectionId ?? null,
  });
  const [disabled, setDisabled] = useState<ReadonlySet<string>>(new Set());
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const isSubtask = Boolean(defaults.parentId);

  const candidates = useMemo(() => quickAddCandidates(state), [state]);
  const now = localNow(timeZone);
  const today = now.date;
  const options: QuickAddOptions = {
    now,
    weekStart: prefs.weekStart,
    dateOrder: prefs.dateFormat,
    smartDates: prefs.smartDateRecognition,
    // Reminders arrive with W6; until then "!" stays text.
    reminders: false,
    // A sub-task always lives with its parent.
    projects: isSubtask ? [] : candidates.projects,
    sections: isSubtask ? [] : candidates.sections,
    labels: candidates.labels,
    defaultProjectId: where.projectId,
    disabled,
  };

  // Parse each line (pasting several lines adds one task per line), with offsets into `content`.
  const lines: { text: string; result: QuickAddResult; offset: number }[] = [];
  let offset = 0;
  for (const text of content.split('\n')) {
    lines.push({ text, result: parseQuickAdd(text, options), offset });
    offset += text.length + 1;
  }
  const tokens: Token[] = lines.flatMap((l) =>
    l.result.tokens.map((t) => ({ ...t, start: t.start + l.offset, end: t.end + l.offset })),
  );
  const nonEmpty = lines.filter((l) => l.text.trim());
  const first = nonEmpty.length === 1 ? (nonEmpty[0]?.result ?? null) : null;

  /** What a line will create: parsed values win over the pickers. */
  const resolve = (r: QuickAddResult) => ({
    due: r.due ? toTaskDue(r.due, today, prefs) : due,
    priority: r.priority ?? priority,
    labels: [
      ...labels,
      ...r.labels.filter((l) => !labels.some((x) => x.toLowerCase() === l.toLowerCase())),
    ],
    projectId: r.projectId ?? where.projectId,
    sectionId: r.projectId ? r.sectionId : (r.sectionId ?? where.sectionId),
  });
  const shown = first ? resolve(first) : { due, priority, labels, ...where };

  const unparse = (keys: string[]) => setDisabled((d) => new Set([...d, ...keys]));
  const tokensOf = (kind: Token['kind']) =>
    first ? first.tokens.filter((t) => t.kind === kind).map(tokenKey) : [];

  const suggest = (trigger: Trigger): Suggestion[] => {
    const q = trigger.query.toLowerCase();
    if (trigger.kind === 'project') {
      const seen = new Set<string>();
      return (isSubtask ? [] : candidates.projects)
        .filter((p) => p.name.toLowerCase().includes(q))
        .filter((p) => !seen.has(p.name) && seen.add(p.name))
        .map((p) => ({
          value: p.name,
          label: (
            <span className="flex items-center gap-2">
              <ProjectDot
                color={state.projects.get(p.id)?.color ?? 'charcoal'}
                inbox={state.projects.get(p.id)?.isInbox ?? false}
              />
              {p.name}
            </span>
          ),
        }));
    }
    if (trigger.kind === 'section') {
      const projectId = first?.projectId ?? where.projectId;
      return (isSubtask ? [] : candidates.sections)
        .filter((s) => s.projectId === projectId && s.name.toLowerCase().includes(q))
        .map((s) => ({ value: s.name, label: <span>§ {s.name}</span> }));
    }
    if (trigger.kind === 'label') {
      const matches: Suggestion[] = candidates.labels
        .filter((l) => l.toLowerCase().includes(q))
        .map((l) => ({ value: l, label: `@${l}` }));
      if (LABEL_NAME.test(trigger.query) && !candidates.labels.some((l) => l.toLowerCase() === q))
        matches.push({ value: trigger.query, label: `+ New label “@${trigger.query}”` });
      return matches;
    }
    return [];
  };

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (nonEmpty.length === 0) return;
    if (
      nonEmpty.length > 1 &&
      !(await confirm({
        title: `Add ${nonEmpty.length} tasks?`,
        message: 'Each line of the text you entered becomes its own task.',
        confirmLabel: `Add ${nonEmpty.length} tasks`,
      }))
    )
      return;
    for (const { text, result } of nonEmpty) {
      const r = resolve(result);
      actions.add({
        // A line that was nothing but tokens ("tomorrow #Work") keeps its text as the name.
        content: (result.content || text.trim()).slice(0, 1000),
        ...(nonEmpty.length === 1 && description.trim() ? { description } : {}),
        ...(isSubtask
          ? { parentId: defaults.parentId }
          : { projectId: r.projectId, sectionId: r.sectionId }),
        priority: r.priority,
        due: r.due,
        labels: r.labels,
        ...(result.deadline ? { deadline: result.deadline } : {}),
        ...(result.durationMinutes ? { durationMinutes: result.durationMinutes } : {}),
      });
    }
    setContent('');
    setDescription('');
    setDisabled(new Set());
    if (keepOpen) contentRef.current?.focus();
    else onDone();
  };

  const chips: { key: string; kind: Token['kind']; label: ReactNode; keys: string[] }[] = [];
  if (first) {
    for (const t of first.tokens) {
      const key = tokenKey(t);
      let label: ReactNode = t.text;
      if (t.kind === 'due' && first.due)
        label = `${first.due.recurrence ? '↻ ' : ''}${dueLabel(toTaskDue(first.due, today, prefs), today, prefs)}`;
      if (t.kind === 'project' && first.projectId)
        label = `# ${state.projects.get(first.projectId)?.name ?? t.text}`;
      if (t.kind === 'section' && first.sectionId)
        label = `§ ${state.sections.get(first.sectionId)?.name ?? t.text}`;
      if (t.kind === 'deadline' && first.deadline)
        label = `Deadline ${formatDate(first.deadline, prefs)}`;
      if (t.kind === 'duration' && first.durationMinutes)
        label = formatDuration(first.durationMinutes);
      if (t.kind === 'priority') label = t.text.toUpperCase();
      chips.push({ key: `${t.kind}:${t.start}`, kind: t.kind, label, keys: [key] });
    }
  }

  return (
    <form
      onSubmit={(e) => void submit(e)}
      className="space-y-2 rounded-xl border border-line bg-surface p-3"
      onKeyDown={(e) => e.key === 'Escape' && !e.defaultPrevented && onDone()}
    >
      <SmartInput
        value={content}
        onChange={(v) => {
          setContent(v);
          if (!v) setDisabled(new Set());
        }}
        tokens={tokens}
        suggest={suggest}
        onSubmit={() => void submit()}
        inputRef={contentRef}
        placeholder={isSubtask ? 'Sub-task name' : 'e.g. Call mom tomorrow 5pm #Family p1'}
      />
      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label="Recognised in the task name">
          {chips.map((c) => (
            <li
              key={c.key}
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg ${TOKEN_CLASS[c.kind]}`}
            >
              {c.label}
              <button
                type="button"
                className="rounded px-0.5 text-muted hover:text-fg"
                aria-label={`Keep “${typeof c.label === 'string' ? c.label : c.kind}” as text`}
                title="Keep as text"
                onClick={() => {
                  unparse(c.keys);
                  contentRef.current?.focus();
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {nonEmpty.length > 1 && (
        <p className="text-xs text-muted">{nonEmpty.length} tasks, one per line</p>
      )}
      <textarea
        rows={1}
        aria-label="Description"
        placeholder="Description"
        className="w-full resize-none bg-transparent text-xs text-muted placeholder:text-muted/70 focus:outline-none"
        value={description}
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="flex flex-wrap gap-1.5">
        <DatePicker
          value={shown.due}
          onChange={(d) => {
            setDue(d);
            unparse(tokensOf('due'));
          }}
        />
        <PriorityPicker
          value={shown.priority}
          onChange={(p) => {
            setPriority(p);
            unparse(tokensOf('priority'));
          }}
        />
        <LabelPicker
          value={shown.labels}
          onChange={(next) => {
            const lower = next.map((l) => l.toLowerCase());
            // Unticking a label typed as @label keeps it as text instead.
            unparse(
              (first?.tokens ?? [])
                .filter((t) => t.kind === 'label' && !lower.includes(t.text.slice(1).toLowerCase()))
                .map(tokenKey),
            );
            setLabels(
              next.filter((l) => !first?.labels.some((x) => x.toLowerCase() === l.toLowerCase())),
            );
          }}
        />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-2">
        {isSubtask ? (
          <span />
        ) : (
          <ProjectPicker
            projectId={shown.projectId}
            sectionId={shown.sectionId}
            onChange={(to) => {
              setWhere(to);
              unparse([...tokensOf('project'), ...tokensOf('section')]);
            }}
          />
        )}
        <div className="flex gap-2">
          <Button variant="secondary" onClick={onDone}>
            Cancel
          </Button>
          <Button type="submit" disabled={nonEmpty.length === 0}>
            {nonEmpty.length > 1 ? `Add ${nonEmpty.length} tasks` : 'Add task'}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h} h` : '', m ? `${m} min` : ''].filter(Boolean).join(' ');
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
