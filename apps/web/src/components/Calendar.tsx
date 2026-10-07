import type { Due, Task } from '@bokydo/shared';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useState } from 'react';
import { useTaskActions } from '../lib/actions.js';
import { announcementsFor, dayName, taskName } from '../lib/dnd-announcements.js';
import {
  addDays,
  formatTime,
  makeDue,
  monthGrid,
  startOfWeek,
  todayIn,
  weekdayNames,
} from '../lib/dates.js';
import { usePreferences, useTimeZone } from '../lib/sync.js';
import { useTaskUI, type AddDefaults } from '../lib/task-ui.js';
import { PRIORITY_CLASS } from './pickers.js';
import { Button } from './ui.js';

const MAX_PER_DAY = 3;

/** Same occurrence time, new day; a repeating task keeps its pattern. */
function moveTo(
  due: Due | null,
  date: string,
  today: string,
  prefs: Parameters<typeof makeDue>[3],
): Due {
  if (due?.recurrence) return { ...due, date };
  return makeDue(date, due?.time ?? null, today, prefs);
}

/**
 * Month or week calendar of tasks by due date. Drag a task to another day to reschedule it;
 * tasks without a date wait in a tray above and can be dragged onto a day.
 */
export function CalendarView({
  tasks,
  addDefaults,
  readOnly = false,
}: {
  tasks: Task[];
  addDefaults?: AddDefaults;
  readOnly?: boolean;
}) {
  const prefs = usePreferences();
  const today = todayIn(useTimeZone());
  const ui = useTaskUI();
  const actions = useTaskActions();
  const [mode, setMode] = useState<'month' | 'week'>(() =>
    typeof window !== 'undefined' && window.innerWidth < 640 ? 'week' : 'month',
  );
  const [anchor, setAnchor] = useState(today);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragging, setDragging] = useState<Task | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const announcements = announcementsFor((id) => {
    const key = String(id);
    if (key.startsWith('day:')) return dayName(key.slice(4));
    const task = tasks.find((t) => t.id === key);
    return task ? taskName(task.content) : null;
  });

  const days =
    mode === 'month'
      ? monthGrid(anchor, prefs.weekStart).flat()
      : Array.from({ length: 7 }, (_, i) => addDays(startOfWeek(anchor, prefs.weekStart), i));
  const weeks = Array.from({ length: Math.ceil(days.length / 7) }, (_, i) =>
    days.slice(i * 7, i * 7 + 7),
  );
  const byDay = new Map<string, Task[]>();
  const undated: Task[] = [];
  for (const t of tasks) {
    if (!t.due) {
      undated.push(t);
      continue;
    }
    const list = byDay.get(t.due.date) ?? [];
    list.push(t);
    byDay.set(t.due.date, list);
  }
  for (const list of byDay.values())
    list.sort(
      (a, b) => (a.due?.time ?? '99').localeCompare(b.due?.time ?? '99') || a.priority - b.priority,
    );

  const step = (n: number) =>
    setAnchor((a) =>
      mode === 'month'
        ? `${new Date(Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1 + n, 1)).toISOString().slice(0, 10)}`
        : addDays(a, 7 * n),
    );
  const title =
    mode === 'month'
      ? new Date(`${anchor.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString(undefined, {
          month: 'long',
          year: 'numeric',
          timeZone: 'UTC',
        })
      : `${new Date(`${days[0]}T00:00:00Z`).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          timeZone: 'UTC',
        })} – ${new Date(`${days[6]}T00:00:00Z`).toLocaleDateString(undefined, {
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          timeZone: 'UTC',
        })}`;

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    const task = active.data.current?.task as Task | undefined;
    const date = over ? String(over.id).replace(/^day:/, '') : null;
    if (!task || !date || task.due?.date === date) return;
    actions.reschedule([task], moveTo(task.due, date, today, prefs));
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      accessibility={{ announcements }}
      onDragStart={({ active }) => setDragging((active.data.current?.task as Task) ?? null)}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button variant="ghost" aria-label={`Previous ${mode}`} onClick={() => step(-1)}>
            ‹
          </Button>
          <Button variant="secondary" onClick={() => setAnchor(today)}>
            Today
          </Button>
          <Button variant="ghost" aria-label={`Next ${mode}`} onClick={() => step(1)}>
            ›
          </Button>
          <h2 className="ml-2 font-semibold" aria-live="polite">
            {title}
          </h2>
        </div>
        <div
          role="group"
          aria-label="Calendar range"
          className="flex rounded-lg border border-line p-0.5 text-sm"
        >
          {(['month', 'week'] as const).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1 capitalize ${mode === m ? 'bg-surface-alt font-medium' : 'text-muted'}`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {undated.length > 0 && !readOnly && (
        <div className="mb-3 rounded-lg border border-dashed border-line p-2 text-xs">
          <p className="mb-1 text-xs text-muted">No date ({undated.length}): drag onto a day</p>
          <ul className="flex flex-wrap gap-1">
            {undated.slice(0, 30).map((t) => (
              <Chip key={t.id} task={t} disabled={readOnly} />
            ))}
          </ul>
        </div>
      )}

      <div
        className={`grid border-t border-l border-line text-xs ${mode === 'week' ? 'grid-cols-1 sm:grid-cols-7' : 'grid-cols-7'}`}
        role="grid"
        aria-label={title}
      >
        <div role="row" className="contents">
          {weekdayNames(prefs.weekStart).map((d) => (
            <div
              key={d}
              role="columnheader"
              data-week={mode === 'week' || undefined}
              className={`border-r border-b border-line px-1 py-1 text-center font-medium text-muted ${mode === 'week' ? 'hidden sm:block' : ''}`}
            >
              {d}
            </div>
          ))}
        </div>
        {weeks.map((week) => (
          <div key={week[0]} role="row" className="contents">
            {week.map((day) => (
              <Day
                key={day}
                day={day}
                today={today}
                dim={mode === 'month' && day.slice(0, 7) !== anchor.slice(0, 7)}
                tasks={byDay.get(day) ?? []}
                tall={mode === 'week'}
                expanded={expanded === day}
                onExpand={() => setExpanded(expanded === day ? null : day)}
                onAdd={
                  readOnly
                    ? undefined
                    : () =>
                        ui.openQuickAdd({ ...addDefaults, due: makeDue(day, null, today, prefs) })
                }
                readOnly={readOnly}
                timeLabel={(time) => formatTime(time, prefs)}
              />
            ))}
          </div>
        ))}
      </div>
      <DragOverlay>{dragging && <ChipBody task={dragging} />}</DragOverlay>
    </DndContext>
  );
}

function Day({
  day,
  today,
  dim,
  tasks,
  tall,
  expanded,
  onExpand,
  onAdd,
  readOnly,
  timeLabel,
}: {
  day: string;
  today: string;
  dim: boolean;
  tasks: Task[];
  tall: boolean;
  expanded: boolean;
  onExpand: () => void;
  onAdd: (() => void) | undefined;
  readOnly: boolean;
  timeLabel: (time: string) => string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day}`, disabled: readOnly });
  const shown = tall || expanded ? tasks : tasks.slice(0, MAX_PER_DAY);
  const hidden = tasks.length - shown.length;
  const label = new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  });
  return (
    <div
      ref={setNodeRef}
      role="gridcell"
      aria-label={`${label}, ${tasks.length} task${tasks.length === 1 ? '' : 's'}`}
      className={`group/day relative flex min-w-0 flex-col gap-0.5 border-r border-b border-line p-1 ${tall ? 'min-h-16 sm:min-h-64' : 'min-h-24'} ${dim ? 'bg-surface-alt/30 text-muted' : ''} ${isOver ? 'bg-accent/10' : ''}`}
    >
      <div className="flex items-center justify-between">
        <span
          className={`inline-flex size-6 items-center justify-center rounded-full ${day === today ? 'bg-accent font-bold text-on-accent' : ''}`}
        >
          {Number(day.slice(8))}
        </span>
        {tall && (
          <span className="mr-auto ml-1 text-muted sm:hidden" aria-hidden>
            {new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
              weekday: 'short',
              timeZone: 'UTC',
            })}
          </span>
        )}
        {onAdd && (
          <button
            type="button"
            aria-label={`Add task on ${label}`}
            onClick={onAdd}
            className="rounded px-1 text-muted opacity-0 group-hover/day:opacity-100 focus:opacity-100 hover:text-accent"
          >
            +
          </button>
        )}
      </div>
      <ul className="flex min-w-0 flex-col gap-0.5">
        {shown.map((t) => (
          <Chip
            key={t.id}
            task={t}
            disabled={readOnly}
            time={t.due?.time ? timeLabel(t.due.time) : null}
          />
        ))}
      </ul>
      {hidden > 0 && (
        <button type="button" onClick={onExpand} className="text-left text-muted hover:text-fg">
          +{hidden} more
        </button>
      )}
      {expanded && tasks.length > MAX_PER_DAY && !tall && (
        <button type="button" onClick={onExpand} className="text-left text-muted hover:text-fg">
          Show less
        </button>
      )}
    </div>
  );
}

function Chip({
  task,
  disabled,
  time = null,
}: {
  task: Task;
  disabled: boolean;
  time?: string | null;
}) {
  const ui = useTaskUI();
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: task.id,
    data: { task },
    disabled,
  });
  return (
    <li ref={setNodeRef} className={`min-w-0 ${isDragging ? 'opacity-40' : ''}`}>
      <button
        type="button"
        {...attributes}
        {...listeners}
        aria-roledescription="draggable task"
        onClick={() => ui.openTask(task.id)}
        className="w-full min-w-0 rounded px-1 py-0.5 text-left hover:bg-surface-alt"
      >
        <ChipBody task={task} time={time} />
      </button>
    </li>
  );
}

function ChipBody({ task, time = null }: { task: Task; time?: string | null }) {
  return (
    <span className="flex min-w-0 items-center gap-1">
      <span
        className={`size-2 shrink-0 rounded-full bg-current ${PRIORITY_CLASS[task.priority]}`}
        aria-hidden
      />
      {time && <span className="hidden shrink-0 text-muted sm:inline">{time}</span>}
      <span className="truncate">{task.content}</span>
    </span>
  );
}
