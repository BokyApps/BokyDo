import type { Task } from '@bokydo/shared';
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { TaskItem } from '../components/TaskItem.js';
import { InlineAdd } from '../components/TaskEditor.js';
import { Button, IconButton } from '../components/ui.js';
import { Page, ViewHeader } from '../components/ViewHeader.js';
import { useTaskActions } from '../lib/actions.js';
import { addDays, describeDate, formatDate, makeDue, startOfWeek, todayIn } from '../lib/dates.js';
import { usePreferences, useSyncState, useTimeZone } from '../lib/sync.js';
import { useTaskUI } from '../lib/task-ui.js';
import { projectOrderIndex, sortTasks, tasksDueBetween, todayTasks } from '../lib/views.js';

const DAYS = 21;

/** Day-by-day agenda with a week strip; drag a task onto another day to reschedule it. */
export function UpcomingPage() {
  const state = useSyncState();
  const prefs = usePreferences();
  const today = todayIn(useTimeZone());
  const actions = useTaskActions();
  const { setViewDefaults } = useTaskUI();
  const [weekOf, setWeekOf] = useState(() => startOfWeek(today, prefs.weekStart));
  const dayRefs = useRef(new Map<string, HTMLElement>());
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }));
  useEffect(() => setViewDefaults({}), [setViewDefaults]);

  const from = weekOf < today ? today : weekOf;
  const days = useMemo(() => Array.from({ length: DAYS }, (_, i) => addDays(from, i)), [from]);
  const order = projectOrderIndex(state);
  const byDay = new Map<string, Task[]>();
  for (const t of tasksDueBetween(state, from, addDays(from, DAYS - 1))) {
    if (t.due) byDay.set(t.due.date, [...(byDay.get(t.due.date) ?? []), t]);
  }
  const overdue = weekOf <= today ? todayTasks(state, today).overdue : [];

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    const task = state.tasks.get(String(active.id));
    const day = over ? String(over.id).replace(/^day:/, '') : null;
    if (!task || !day || task.due?.date === day) return;
    actions.reschedule([task], makeDue(day, task.due?.time ?? null, today, prefs));
  };

  const jump = (d: string) =>
    dayRefs.current.get(d)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  const week = Array.from({ length: 7 }, (_, i) => addDays(weekOf, i));
  const monthLabel = new Date(`${from}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });

  return (
    <Page>
      <ViewHeader
        title="Upcoming"
        subtitle={monthLabel}
        actions={
          <>
            <IconButton
              label="Previous week"
              onClick={() => setWeekOf(addDays(weekOf, -7))}
              disabled={weekOf <= startOfWeek(today, prefs.weekStart)}
            >
              ‹
            </IconButton>
            <Button
              variant="secondary"
              className="px-2 py-1"
              onClick={() => setWeekOf(startOfWeek(today, prefs.weekStart))}
            >
              Today
            </Button>
            <IconButton label="Next week" onClick={() => setWeekOf(addDays(weekOf, 7))}>
              ›
            </IconButton>
          </>
        }
      />
      <div
        className="mb-6 grid grid-cols-7 gap-1 border-b border-line pb-2 text-center"
        role="list"
        aria-label="Week"
      >
        {week.map((d) => {
          const past = d < today;
          const count = byDay.get(d)?.length ?? 0;
          return (
            <button
              key={d}
              type="button"
              role="listitem"
              disabled={past}
              onClick={() => jump(d)}
              className={`rounded-lg py-1.5 text-sm ${d === today ? 'bg-accent text-on-accent' : past ? 'text-muted/60' : 'hover:bg-surface-alt'}`}
            >
              <div className="text-xs">
                {new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, {
                  weekday: 'short',
                  timeZone: 'UTC',
                })}
              </div>
              <div className="font-semibold">{Number(d.slice(8))}</div>
              <div className="h-1.5">
                {count > 0 && (
                  <span
                    className={`mx-auto block size-1 rounded-full ${d === today ? 'bg-on-accent' : 'bg-muted'}`}
                  />
                )}
              </div>
            </button>
          );
        })}
      </div>
      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        {overdue.length > 0 && (
          <section aria-label="Overdue" className="mb-6">
            <h2 className="border-b border-line pb-1 font-semibold text-danger">Overdue</h2>
            <ul>
              {sortTasks(overdue, 'date', order).map((t) => (
                <DraggableTask key={t.id} task={t} />
              ))}
            </ul>
          </section>
        )}
        {days.map((d) => (
          <DaySection
            key={d}
            day={d}
            today={today}
            tasks={sortTasks(byDay.get(d) ?? [], 'date', order)}
            refCb={(el) => (el ? dayRefs.current.set(d, el) : dayRefs.current.delete(d))}
          />
        ))}
      </DndContext>
    </Page>
  );
}

function DaySection({
  day,
  today,
  tasks,
  refCb,
}: {
  day: string;
  today: string;
  tasks: Task[];
  refCb: (el: HTMLElement | null) => void;
}) {
  const prefs = usePreferences();
  const { setNodeRef, isOver } = useDroppable({ id: `day:${day}` });
  const rel = describeDate(day, null, today, prefs).label;
  const date = formatDate(day, prefs);
  const weekday = new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    timeZone: 'UTC',
  });
  const title =
    rel === weekday || rel === date ? `${date} · ${weekday}` : `${date} · ${rel} · ${weekday}`;
  return (
    <section
      ref={(el) => {
        setNodeRef(el);
        refCb(el);
      }}
      aria-label={title}
      className={`mb-4 scroll-mt-4 rounded-lg ${isOver ? 'bg-accent/10' : ''}`}
    >
      <h2 className="border-b border-line pb-1 text-sm font-semibold">{title}</h2>
      <ul>
        {tasks.map((t) => (
          <DraggableTask key={t.id} task={t} />
        ))}
      </ul>
      <InlineAdd defaults={{ due: makeDue(day, null, today, prefs) }} />
    </section>
  );
}

function DraggableTask({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: task.id,
  });
  return (
    <div
      ref={setNodeRef}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      className={isDragging ? 'relative z-10 opacity-70' : ''}
    >
      <TaskItem
        task={task}
        orderedIds={[task.id]}
        showProject
        dragHandle={{ attributes, listeners }}
      />
    </div>
  );
}
