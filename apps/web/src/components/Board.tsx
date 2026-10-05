import { Avatar } from './Sharing.js';
import { generateKeyBetween, type Task } from '@bokydo/shared';
import {
  closestCorners,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useState, type ReactNode } from 'react';
import { useTaskActions } from '../lib/actions.js';
import { describeDate, describeDue, TONE_CLASS, todayIn } from '../lib/dates.js';
import { usePreferences, useSyncState, useTimeZone } from '../lib/sync.js';
import { useTaskUI, type AddDefaults } from '../lib/task-ui.js';
import { subtaskProgress } from '../lib/views.js';
import { CalendarIcon, ChevronIcon, CommentIcon, DeadlineIcon, SubtaskIcon } from './icons.js';
import { InlineMarkdown } from './Markdown.js';
import { ProjectDot } from './pickers.js';
import { InlineAdd } from './TaskEditor.js';
import { TaskCheckbox } from './TaskItem.js';

export interface BoardColumn {
  id: string;
  title: ReactNode;
  /** Plain-text name, when `title` is not a string (accessibility, collapsed strip). */
  label?: string;
  tasks: Task[];
  /** Shows "Add task" at the bottom of the column. */
  addDefaults?: AddDefaults;
  /** Extra header controls (e.g. the section menu). */
  menu?: ReactNode;
  /** Cards can be dropped here (default true). */
  droppable?: boolean;
}

/** Where a card landed: its column and its new neighbours. */
export interface BoardDrop {
  task: Task;
  columnId: string;
  before: Task | null;
  after: Task | null;
}

/** Fractional order key between two neighbours (tolerates equal or inverted keys). */
export function orderBetween(before: Task | null, after: Task | null): string {
  const a = before?.childOrder ?? null;
  const b = after?.childOrder ?? null;
  try {
    return generateKeyBetween(a, b && a && b <= a ? null : b);
  } catch {
    return generateKeyBetween(a, null);
  }
}

/**
 * Kanban board: columns of cards, dragged within and between columns (mouse, touch or keyboard:
 * space to lift, arrows to move, space to drop). Collapsed columns shrink to a strip.
 */
export function Board({
  columns,
  onDrop,
  trailing,
  showProject = false,
  readOnly = false,
}: {
  columns: BoardColumn[];
  onDrop: (drop: BoardDrop) => void;
  /** Rendered after the last column (e.g. "Add section"). */
  trailing?: ReactNode;
  showProject?: boolean;
  readOnly?: boolean;
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [dragging, setDragging] = useState<Task | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const byId = new Map(columns.map((c) => [c.id, c]));

  const onDragStart = ({ active }: DragStartEvent) =>
    setDragging((active.data.current?.task as Task | undefined) ?? null);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setDragging(null);
    const task = active.data.current?.task as Task | undefined;
    if (!task || !over) return;
    const columnId =
      (over.data.current?.sortable?.containerId as string | undefined) ??
      String(over.id).replace(/^column:/, '');
    const column = byId.get(columnId);
    if (!column || column.droppable === false) return;
    const from = active.data.current?.sortable?.containerId as string | undefined;
    const rest = column.tasks.filter((t) => t.id !== task.id);
    let at = rest.findIndex((t) => t.id === over.id);
    if (at === -1) at = rest.length;
    else if (from === columnId) {
      // Moving down within a column lands after the card it was dropped on.
      const oldIndex = column.tasks.findIndex((t) => t.id === task.id);
      const overIndex = column.tasks.findIndex((t) => t.id === over.id);
      if (oldIndex !== -1 && oldIndex < overIndex) at += 1;
    }
    const before = rest[at - 1] ?? null;
    const after = rest[at] ?? null;
    const idx = column.tasks.findIndex((t) => t.id === task.id);
    if (
      from === columnId &&
      column.tasks[idx - 1]?.id === before?.id &&
      column.tasks[idx + 1]?.id === after?.id
    )
      return; // dropped where it was
    onDrop({ task, columnId, before, after });
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(null)}
    >
      <div className="-mx-4 flex items-start gap-3 overflow-x-auto px-4 pb-4 sm:-mx-6 sm:px-6">
        {columns.map((c) => (
          <Column
            key={c.id}
            column={c}
            collapsed={collapsed.has(c.id)}
            onToggle={() =>
              setCollapsed((s) => {
                const next = new Set(s);
                if (next.has(c.id)) next.delete(c.id);
                else next.add(c.id);
                return next;
              })
            }
            showProject={showProject}
            readOnly={readOnly}
          />
        ))}
        {trailing && <div className="w-72 shrink-0">{trailing}</div>}
      </div>
      <DragOverlay>
        {dragging && <TaskCard task={dragging} showProject={showProject} lifted />}
      </DragOverlay>
    </DndContext>
  );
}

function Column({
  column,
  collapsed,
  onToggle,
  showProject,
  readOnly,
}: {
  column: BoardColumn;
  collapsed: boolean;
  onToggle: () => void;
  showProject: boolean;
  readOnly: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({
    id: `column:${column.id}`,
    disabled: column.droppable === false,
  });
  const count = column.tasks.length;
  const name = column.label ?? (typeof column.title === 'string' ? column.title : 'Column');
  if (collapsed)
    return (
      <section
        ref={setNodeRef}
        aria-label={`${name} (collapsed)`}
        className={`flex w-10 shrink-0 flex-col items-center gap-2 rounded-xl bg-surface-alt/60 py-3 ${isOver ? 'ring-2 ring-accent' : ''}`}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-label="Expand column"
          aria-expanded={false}
          className="rounded p-0.5 text-muted hover:text-fg"
        >
          <ChevronIcon open={false} />
        </button>
        <span className="text-xs text-muted">{count}</span>
        <span className="text-sm font-semibold [writing-mode:vertical-rl]">{name}</span>
      </section>
    );
  return (
    <section
      aria-label={name}
      className="flex w-72 shrink-0 flex-col rounded-xl bg-surface-alt/40 p-2"
    >
      <header className="mb-2 flex items-center gap-1 px-1">
        <button
          type="button"
          onClick={onToggle}
          aria-label="Collapse column"
          aria-expanded
          className="rounded p-0.5 text-muted hover:text-fg"
        >
          <ChevronIcon open />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{column.title}</h2>
        <span className="text-xs text-muted">{count || ''}</span>
        {column.menu}
      </header>
      <SortableContext
        id={column.id}
        items={column.tasks.map((t) => t.id)}
        strategy={verticalListSortingStrategy}
      >
        <ul
          ref={setNodeRef}
          className={`flex min-h-12 flex-col gap-2 rounded-lg ${isOver ? 'bg-accent/10' : ''}`}
        >
          {column.tasks.map((t) => (
            <SortableCard key={t.id} task={t} showProject={showProject} disabled={readOnly} />
          ))}
        </ul>
      </SortableContext>
      {column.addDefaults && !readOnly && <InlineAdd defaults={column.addDefaults} />}
    </section>
  );
}

function SortableCard({
  task,
  showProject,
  disabled,
}: {
  task: Task;
  showProject: boolean;
  disabled: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { task },
    disabled,
  });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={`rounded-lg focus-visible:outline-2 focus-visible:outline-accent ${isDragging ? 'opacity-40' : ''}`}
      {...attributes}
      {...listeners}
      aria-roledescription="draggable task card"
      aria-label={task.content}
    >
      <TaskCard task={task} showProject={showProject} />
    </li>
  );
}

/** A task as a board card: checkbox, title, and its dates, labels and sub-task count. */
export function TaskCard({
  task,
  showProject = false,
  lifted = false,
}: {
  task: Task;
  showProject?: boolean;
  lifted?: boolean;
}) {
  const state = useSyncState();
  const prefs = usePreferences();
  const today = todayIn(useTimeZone());
  const ui = useTaskUI();
  const actions = useTaskActions();
  const progress = subtaskProgress(state, task.id);
  const due = task.due ? describeDue(task.due, today, prefs) : null;
  const deadline = task.deadline ? describeDate(task.deadline, null, today, prefs) : null;
  const project = state.projects.get(task.projectId);
  let comments = 0;
  for (const c of state.comments.values()) if (c.taskId === task.id) comments++;
  return (
    <div
      onClick={() => ui.openTask(task.id)}
      className={`cursor-pointer rounded-lg border border-line bg-surface p-2.5 text-sm ${lifted ? 'rotate-1 shadow-xl' : 'shadow-sm hover:border-muted/60'}`}
    >
      <div className="flex items-start gap-2">
        <TaskCheckbox
          task={task}
          onToggle={() => (task.isCompleted ? actions.uncomplete(task) : actions.complete([task]))}
        />
        <button
          type="button"
          className="min-w-0 flex-1 text-left break-words"
          onClick={(e) => {
            e.stopPropagation();
            ui.openTask(task.id);
          }}
        >
          <InlineMarkdown text={task.content} />
        </button>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs text-muted">
        {due && (
          <span className={`inline-flex items-center gap-1 ${TONE_CLASS[due.tone]}`}>
            <CalendarIcon /> {due.label}
            {task.due?.recurrence && <span aria-label="repeats">↻</span>}
          </span>
        )}
        {deadline && (
          <span
            className={`inline-flex items-center gap-1 ${deadline.tone === 'overdue' ? 'text-danger' : ''}`}
          >
            <DeadlineIcon /> {deadline.label}
          </span>
        )}
        {progress && (
          <span className="inline-flex items-center gap-1">
            <SubtaskIcon /> {progress.done}/{progress.total}
          </span>
        )}
        {comments > 0 && (
          <span className="inline-flex items-center gap-1">
            <CommentIcon /> {comments}
          </span>
        )}
        {task.labels.map((l) => (
          <span key={l} className="text-p3">
            @{l}
          </span>
        ))}
        {task.assigneeId && state.collaborators.get(task.assigneeId) && (
          <Avatar name={state.collaborators.get(task.assigneeId)?.username ?? ''} />
        )}
        {showProject && project && (
          <span className="ml-auto inline-flex items-center gap-1">
            {project.isInbox ? 'Inbox' : project.name}
            <ProjectDot color={project.color} inbox={project.isInbox} />
          </span>
        )}
      </div>
    </div>
  );
}
