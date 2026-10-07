import { localNow, parseDate } from '@bokydo/nlp';
import type { Due, Project, Section } from '@bokydo/shared';
import { useMemo, useState, type ReactNode } from 'react';
import {
  addDays,
  diffDays,
  dueLabel,
  formatTime,
  makeDue,
  monthGrid,
  startOfWeek,
  weekday,
  weekdayNames,
} from '../lib/dates.js';
import { toTaskDue } from '../lib/quick-add.js';
import { usePreferences, useSyncState, useTimeZone } from '../lib/sync.js';
import { allLabelNames, flattenTree, projectTree, sectionsOf } from '../lib/views.js';
import { CalendarIcon, CheckIcon, FlagIcon, InboxIcon, TagIcon } from './icons.js';
import { Button, inputClass, Popover } from './ui.js';

export const PRIORITY_CLASS: Record<number, string> = {
  1: 'text-p1',
  2: 'text-p2',
  3: 'text-p3',
  4: 'text-p4',
};

function Chip({
  children,
  active,
  ...rest
}: { children: ReactNode; active?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs ${active ? 'border-line bg-surface-alt text-fg' : 'border-line text-muted hover:bg-surface-alt'}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Date + optional time: type it ("next fri 5pm", "every mon"), pick a shortcut, or use the
 * calendar. Picking a day for a recurring task moves this occurrence and keeps the pattern.
 */
export function DatePicker({
  value,
  onChange,
  chip = true,
  label,
}: {
  value: Due | null;
  onChange: (due: Due | null) => void;
  chip?: boolean;
  label?: string;
}) {
  const prefs = usePreferences();
  const now = localNow(useTimeZone());
  const today = now.date;
  const [month, setMonth] = useState((value?.date ?? today).slice(0, 7) + '-01');
  const [time, setTime] = useState(value?.time ?? '');
  const [text, setText] = useState('');
  const grid = useMemo(() => monthGrid(month, prefs.weekStart), [month, prefs.weekStart]);
  const typed = text.trim()
    ? parseDate(text, { now, weekStart: prefs.weekStart, dateOrder: prefs.dateFormat })
    : null;
  const at = (date: string, t: string | null): Due =>
    value?.recurrence ? { ...value, date, time: t } : makeDue(date, t, today, prefs);
  const pick = (date: string | null, close: () => void) => {
    onChange(date ? at(date, time || null) : null);
    setText('');
    close();
  };
  const applyTyped = (close: () => void) => {
    if (!typed) return;
    onChange(toTaskDue(typed, today, prefs));
    setTime(typed.time ?? '');
    setText('');
    close();
  };
  const daysToSaturday = (6 - weekday(today) + 7) % 7 || 7;
  const nextWeek = addDays(startOfWeek(today, prefs.weekStart), 7);
  const shortcuts: [string, string | null, string][] = [
    ['Today', today, ''],
    ['Tomorrow', addDays(today, 1), ''],
    ['This weekend', addDays(today, daysToSaturday), ''],
    ['Next week', nextWeek, ''],
    ['No date', null, ''],
  ];
  const monthTitle = new Date(`${month}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <Popover
      trigger={(p) =>
        chip ? (
          <Chip {...p} active={Boolean(value)}>
            <CalendarIcon /> {value ? dueLabel(value, today, prefs) : (label ?? 'Date')}
          </Chip>
        ) : (
          <Button variant="ghost" {...p} {...(value || label ? {} : { 'aria-label': 'Schedule' })}>
            <CalendarIcon /> {value ? dueLabel(value, today, prefs) : (label ?? 'Schedule')}
          </Button>
        )
      }
      panelClassName="w-72"
    >
      {(close) => (
        <div className="space-y-2 p-1">
          <div>
            <input
              className={`${inputClass} py-1`}
              placeholder="Type a date: next fri 5pm, every mon…"
              aria-label="Type a date"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  applyTyped(close);
                }
              }}
              autoFocus
            />
            {text.trim() && (
              <button
                type="button"
                disabled={!typed}
                onClick={() => applyTyped(close)}
                className="mt-1 flex w-full flex-col rounded-md px-2 py-1.5 text-left hover:bg-surface-alt disabled:cursor-default disabled:hover:bg-transparent"
              >
                {typed ? (
                  <>
                    <span className="font-medium">
                      {typed.recurrence ? '↻ ' : ''}
                      {dueLabel(toTaskDue(typed, today, prefs), today, prefs)}
                    </span>
                    <span className="text-xs text-muted">
                      {typed.recurrence ? 'First: ' : ''}
                      {new Date(`${typed.date}T00:00:00Z`).toLocaleDateString(undefined, {
                        weekday: 'short',
                        day: 'numeric',
                        month: 'short',
                        year: typed.date.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric',
                        timeZone: 'UTC',
                      })}
                      {typed.time ? ` · ${formatTime(typed.time, prefs)}` : ''}
                    </span>
                  </>
                ) : (
                  <span className="text-muted">No date recognised</span>
                )}
              </button>
            )}
          </div>
          <ul>
            {shortcuts.map(([name, date]) => (
              <li key={name}>
                <button
                  type="button"
                  className="flex w-full justify-between rounded-md px-2 py-1.5 hover:bg-surface-alt"
                  onClick={() => pick(date, close)}
                >
                  <span>{name}</span>
                  {date && (
                    <span className="text-muted">
                      {new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, {
                        weekday: 'short',
                        timeZone: 'UTC',
                      })}
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <div className="border-t border-line pt-2">
            <div className="mb-1 flex items-center justify-between px-1">
              <span className="font-medium">{monthTitle}</span>
              <span>
                <button
                  type="button"
                  aria-label="Previous month"
                  className="rounded px-2 hover:bg-surface-alt"
                  onClick={() => setMonth(addDays(month, -1).slice(0, 7) + '-01')}
                >
                  ‹
                </button>
                <button
                  type="button"
                  aria-label="Next month"
                  className="rounded px-2 hover:bg-surface-alt"
                  onClick={() => setMonth(addDays(month, 32).slice(0, 7) + '-01')}
                >
                  ›
                </button>
              </span>
            </div>
            <div
              className="grid grid-cols-7 text-center text-xs"
              role="grid"
              aria-label={monthTitle}
            >
              {weekdayNames(prefs.weekStart, 'narrow').map((d, i) => (
                <span key={i} className="py-1 text-muted">
                  {d}
                </span>
              ))}
              {grid.flat().map((d) => {
                const selected = value?.date === d;
                const past = diffDays(d, today) < 0;
                return (
                  <button
                    key={d}
                    type="button"
                    onClick={() => pick(d, close)}
                    aria-pressed={selected}
                    aria-label={d}
                    className={`m-0.5 rounded-full py-1 ${selected ? 'bg-accent text-on-accent' : d === today ? 'font-bold text-accent' : d.slice(0, 7) !== month.slice(0, 7) || past ? 'text-muted' : ''} hover:bg-surface-alt`}
                  >
                    {Number(d.slice(8))}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex items-center gap-2 border-t border-line pt-2">
            <label className="text-xs text-muted" htmlFor="due-time">
              Time
            </label>
            <input
              id="due-time"
              type="time"
              className={`${inputClass} py-1`}
              value={time}
              onChange={(e) => {
                setTime(e.target.value);
                if (value) onChange(at(value.date, e.target.value || null));
              }}
            />
          </div>
          {value?.recurrence && (
            <div className="flex items-center justify-between border-t border-line pt-2 text-xs">
              <span className="truncate text-muted">↻ {value.string}</span>
              <button
                type="button"
                className="rounded px-2 py-1 text-accent hover:bg-surface-alt"
                onClick={() => {
                  onChange(makeDue(value.date, value.time, today, prefs));
                  close();
                }}
              >
                Stop repeating
              </button>
            </div>
          )}
        </div>
      )}
    </Popover>
  );
}

export function PriorityPicker({
  value,
  onChange,
}: {
  value: number;
  onChange: (p: number) => void;
}) {
  return (
    <Popover
      trigger={(p) => (
        <Chip
          {...p}
          active={value !== 4}
          aria-label={value === 4 ? 'Priority 4' : `P${value} priority`}
        >
          <FlagIcon
            className={PRIORITY_CLASS[value]}
            fill={value !== 4 ? 'currentColor' : 'none'}
          />{' '}
          {value === 4 ? 'Priority' : `P${value}`}
        </Chip>
      )}
    >
      {(close) =>
        [1, 2, 3, 4].map((p) => (
          <button
            key={p}
            type="button"
            className="flex w-full items-center gap-2 rounded-md px-3 py-1.5 hover:bg-surface-alt"
            onClick={() => {
              onChange(p);
              close();
            }}
          >
            <FlagIcon className={PRIORITY_CLASS[p]} fill={p !== 4 ? 'currentColor' : 'none'} />
            Priority {p}
            {value === p && (
              <span className="ml-auto text-accent">
                <CheckIcon />
              </span>
            )}
          </button>
        ))
      }
    </Popover>
  );
}

export function LabelPicker({
  value,
  onChange,
}: {
  value: string[];
  onChange: (labels: string[]) => void;
}) {
  const state = useSyncState();
  const [query, setQuery] = useState('');
  const names = allLabelNames(state);
  const q = query.trim().replace(/^@/, '');
  const filtered = names.filter((n) => n.toLowerCase().includes(q.toLowerCase()));
  const has = (n: string) => value.some((v) => v.toLowerCase() === n.toLowerCase());
  const toggle = (n: string) =>
    onChange(has(n) ? value.filter((v) => v.toLowerCase() !== n.toLowerCase()) : [...value, n]);
  const valid = /^[^\s@#]{1,60}$/.test(q);
  return (
    <Popover
      trigger={(p) => (
        <Chip {...p} active={value.length > 0}>
          <TagIcon /> {value.length ? value.map((l) => `@${l}`).join(' ') : 'Labels'}
        </Chip>
      )}
      panelClassName="w-60"
    >
      <div className="space-y-1 p-1">
        <input
          className={`${inputClass} py-1`}
          placeholder="Type a label"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Find or create label"
          autoFocus
        />
        <ul className="max-h-56 overflow-y-auto">
          {filtered.map((n) => (
            <li key={n}>
              <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 hover:bg-surface-alt">
                <input
                  type="checkbox"
                  className="accent-accent"
                  checked={has(n)}
                  onChange={() => toggle(n)}
                />
                @{n}
              </label>
            </li>
          ))}
        </ul>
        {q && valid && !names.some((n) => n.toLowerCase() === q.toLowerCase()) && (
          <button
            type="button"
            className="w-full rounded-md px-2 py-1 text-left text-accent hover:bg-surface-alt"
            onClick={() => {
              toggle(q);
              setQuery('');
            }}
          >
            + Add “@{q}”
          </button>
        )}
      </div>
    </Popover>
  );
}

/** Project (and optional section) chooser, showing the project tree. */
export function ProjectPicker({
  projectId,
  sectionId,
  onChange,
  trigger,
}: {
  projectId: string;
  sectionId: string | null;
  onChange: (to: { projectId: string; sectionId: string | null }, project: Project) => void;
  trigger?: (
    props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'dialog' },
    label: string,
  ) => ReactNode;
}) {
  const state = useSyncState();
  const [query, setQuery] = useState('');
  const inbox = state.user ? state.projects.get(state.user.inboxProjectId) : undefined;
  const rows: { project: Project; section?: Section; depth: number }[] = [];
  const add = (project: Project, depth: number) => {
    rows.push({ project, depth });
    for (const section of sectionsOf(state, project.id))
      rows.push({ project, section, depth: depth + 1 });
  };
  if (inbox) add(inbox, 0);
  for (const { project, depth } of flattenTree(projectTree(state)))
    if (['owner', 'admin', 'editor'].includes(project.role)) add(project, depth);
  const q = query.toLowerCase();
  const shown = q
    ? rows.filter((r) => (r.section?.name ?? r.project.name).toLowerCase().includes(q))
    : rows;
  const current = state.projects.get(projectId);
  const currentSection = sectionId ? state.sections.get(sectionId) : undefined;
  const label = `${current?.name ?? 'Project'}${currentSection ? ` / ${currentSection.name}` : ''}`;
  return (
    <Popover
      trigger={(p) =>
        trigger?.(p, label) ?? (
          <Chip {...p}>
            <InboxIcon /> {label}
          </Chip>
        )
      }
      panelClassName="w-64"
    >
      {(close) => (
        <div className="space-y-1 p-1">
          <input
            className={`${inputClass} py-1`}
            placeholder="Type a project name"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label="Find project"
            autoFocus
          />
          <ul className="max-h-64 overflow-y-auto">
            {shown.map((r) => (
              <li key={r.section?.id ?? r.project.id}>
                <button
                  type="button"
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-alt"
                  style={{ paddingLeft: `${0.5 + r.depth * 0.9}rem` }}
                  onClick={() => {
                    onChange(
                      { projectId: r.project.id, sectionId: r.section?.id ?? null },
                      r.project,
                    );
                    close();
                  }}
                >
                  {r.section ? (
                    <span className="text-muted">§</span>
                  ) : (
                    <ProjectDot color={r.project.color} inbox={r.project.isInbox} />
                  )}
                  <span className="truncate">{r.section?.name ?? r.project.name}</span>
                  {r.project.id === projectId && (r.section?.id ?? null) === sectionId && (
                    <span className="ml-auto text-accent">
                      <CheckIcon />
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Popover>
  );
}

export function ProjectDot({ color, inbox = false }: { color: string; inbox?: boolean }) {
  if (inbox)
    return (
      <span className="text-p3">
        <InboxIcon />
      </span>
    );
  return (
    <span
      className="inline-block size-2.5 shrink-0 rounded-full"
      style={{ backgroundColor: `var(--bk-project-${color.replace(/_/g, '-')})` }}
      aria-hidden
    />
  );
}
