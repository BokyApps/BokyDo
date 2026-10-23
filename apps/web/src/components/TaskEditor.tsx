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
import { useTranslation } from 'react-i18next';
import { useTaskActions } from '../lib/actions.js';
import { useConfirm } from '../lib/confirm.js';
import { dueLabel, formatDate } from '../lib/dates.js';
import { reminderLabel } from '../lib/reminders.js';
import { quickAddCandidates, toTaskDue } from '../lib/quick-add.js';
import { newId, usePreferences, useSend, useSyncState, useTimeZone } from '../lib/sync.js';
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
  const { t } = useTranslation();
  const state = useSyncState();
  const prefs = usePreferences();
  const timeZone = useTimeZone();
  const actions = useTaskActions();
  const send = useSend();
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
    reminders: true,
    // A sub-task always lives with its parent.
    projects: isSubtask ? [] : candidates.projects,
    sections: isSubtask ? [] : candidates.sections,
    labels: candidates.labels,
    members: candidates.members,
    defaultProjectId: isSubtask
      ? (state.tasks.get(defaults.parentId ?? '')?.projectId ?? where.projectId)
      : where.projectId,
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
    if (trigger.kind === 'assignee') {
      const projectId = first?.projectId ?? options.defaultProjectId;
      return candidates.members
        .filter((m) => m.projectId === projectId && m.name.toLowerCase().includes(q))
        .map((m) => ({ value: m.name, label: `+${m.name}` }));
    }
    if (trigger.kind === 'label') {
      const matches: Suggestion[] = candidates.labels
        .filter((l) => l.toLowerCase().includes(q))
        .map((l) => ({ value: l, label: `@${l}` }));
      if (LABEL_NAME.test(trigger.query) && !candidates.labels.some((l) => l.toLowerCase() === q))
        matches.push({
          value: trigger.query,
          label: t('task.newLabel', { name: trigger.query }),
        });
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
        title: t('task.confirmAddManyTitle', { count: nonEmpty.length }),
        message: t('task.confirmAddManyMessage'),
        confirmLabel: t('task.addTasks', { count: nonEmpty.length }),
      }))
    )
      return;
    for (const { text, result } of nonEmpty) {
      const r = resolve(result);
      const taskId = actions.add({
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
        ...(result.assigneeId ? { assigneeId: result.assigneeId } : {}),
      });
      for (const rem of result.reminders)
        send(
          'reminder_add',
          rem.type === 'relative'
            ? { id: newId(), taskId, type: 'relative', minutesBefore: rem.minutesBefore }
            : { id: newId(), taskId, type: 'absolute', date: rem.date, time: rem.time },
        );
    }
    setContent('');
    setDescription('');
    setDisabled(new Set());
    if (keepOpen) contentRef.current?.focus();
    else onDone();
  };

  const chips: { key: string; kind: Token['kind']; label: ReactNode; keys: string[] }[] = [];
  if (first) {
    let reminderIndex = 0;
    for (const tok of first.tokens) {
      const key = tokenKey(tok);
      let label: ReactNode = tok.text;
      if (tok.kind === 'due' && first.due)
        label = `${first.due.recurrence ? '↻ ' : ''}${dueLabel(toTaskDue(first.due, today, prefs), today, prefs)}`;
      if (tok.kind === 'project' && first.projectId)
        label = `# ${state.projects.get(first.projectId)?.name ?? tok.text}`;
      if (tok.kind === 'section' && first.sectionId)
        label = `§ ${state.sections.get(first.sectionId)?.name ?? tok.text}`;
      if (tok.kind === 'deadline' && first.deadline)
        label = t('task.deadlineValue', { date: formatDate(first.deadline, prefs) });
      if (tok.kind === 'duration' && first.durationMinutes)
        label = formatDuration(first.durationMinutes);
      if (tok.kind === 'priority') label = tok.text.toUpperCase();
      if (tok.kind === 'reminder') {
        const rem = first.reminders[reminderIndex++];
        if (rem)
          label = `⏰ ${reminderLabel(
            rem.type === 'relative'
              ? { type: 'relative', minutesBefore: rem.minutesBefore, date: null, time: null }
              : { type: 'absolute', minutesBefore: null, date: rem.date, time: rem.time },
            today,
            prefs,
          )}${rem.type === 'relative' && !resolve(first).due?.time ? ` ${t('task.needsTime')}` : ''}`;
      }
      if (tok.kind === 'assignee' && first.assigneeId)
        label = `→ ${state.collaborators.get(first.assigneeId)?.username ?? tok.text}`;
      chips.push({ key: `${tok.kind}:${tok.start}`, kind: tok.kind, label, keys: [key] });
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
        placeholder={isSubtask ? t('task.subtaskName') : t('task.namePlaceholder')}
      />
      {chips.length > 0 && (
        <ul className="flex flex-wrap gap-1" aria-label={t('task.recognised')}>
          {chips.map((c) => (
            <li
              key={c.key}
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-fg ${TOKEN_CLASS[c.kind]}`}
            >
              {c.label}
              <button
                type="button"
                className="rounded px-0.5 text-muted hover:text-fg"
                aria-label={t('task.keepAsTextAria', {
                  label: typeof c.label === 'string' ? c.label : c.kind,
                })}
                title={t('task.keepAsText')}
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
        <p className="text-xs text-muted">{t('task.onePerLine', { count: nonEmpty.length })}</p>
      )}
      <textarea
        rows={1}
        aria-label={t('task.description')}
        placeholder={t('task.description')}
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
            {t('task.cancel')}
          </Button>
          <Button type="submit" disabled={nonEmpty.length === 0}>
            {nonEmpty.length > 1
              ? t('task.addTasks', { count: nonEmpty.length })
              : t('task.addTask')}
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

export function InlineAdd({ defaults, label }: { defaults: AddDefaults; label?: string }) {
  const { t } = useTranslation();
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
      {label ?? t('task.addTask')}
    </button>
  );
}
