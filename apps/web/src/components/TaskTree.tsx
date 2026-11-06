import type { Task } from '@bokydo/shared';
import {
  closestCenter,
  pointerWithin,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type CollisionDetection,
  type DragOverEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { createContext, useContext, useLayoutEffect, useState, type ReactNode } from 'react';
import { useTaskActions } from '../lib/actions.js';
import { useSyncState } from '../lib/sync.js';
import { announcementsFor, taskName } from '../lib/dnd-announcements.js';
import { between } from '../lib/task-moves.js';
import { byOrder, childrenOf } from '../lib/views.js';
import { TaskItem } from './TaskItem.js';

interface Container {
  projectId: string;
  sectionId: string | null;
  parentId: string | null;
  ids: string[];
}

const Registry = createContext<Map<string, Container> | null>(null);
const DropFeedback = createContext<{
  activeId: string | null;
  fromKey: string | undefined;
  overId: string | null;
  overKey: string | undefined;
  edge: 'before' | 'after';
  dragging: boolean;
  readOnly: boolean;
}>({
  activeId: null,
  fromKey: undefined,
  overId: null,
  overKey: undefined,
  edge: 'before',
  dragging: false,
  readOnly: false,
});
const Collapsed = createContext<{
  isCollapsed: (id: string) => boolean;
  toggle: (id: string) => void;
  showCompleted: boolean;
}>({
  isCollapsed: () => false,
  toggle: () => undefined,
  showCompleted: false,
});

/** Desktop grips sit outside the row; keep their gutter and outdent gesture hittable. */
const listCollisionDetection: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return closestCenter(args);
  const task = args.active.data.current?.task as Task | undefined;
  const gutter = task?.parentId ? 96 : 32;
  const droppableRects = new Map(
    [...args.droppableRects].map(([id, rect]) => [
      id,
      {
        top: rect.top,
        bottom: rect.bottom,
        height: rect.height,
        left: rect.left - gutter,
        right: rect.right,
        width: rect.width + gutter,
      },
    ]),
  );
  return pointerWithin({ ...args, droppableRects });
};

/** Horizontal drag distance (px) that turns a move into indent/outdent. */
const NEST_PX = 48;

/**
 * Drag-and-drop for a project's lists. Drop between tasks to reorder (also across sections);
 * drag right onto the task above to make a sub-task, left to promote it back out.
 */
export function TaskDnd({
  children,
  showCompleted = false,
  readOnly = false,
}: {
  children: ReactNode;
  showCompleted?: boolean;
  readOnly?: boolean;
}) {
  const [registry] = useState(() => new Map<string, Container>());
  const state = useSyncState();
  const actions = useTaskActions();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [draggingTask, setDraggingTask] = useState<Task | null>(null);
  const [draggingWidth, setDraggingWidth] = useState<number | undefined>();
  const [dragFeedback, setDragFeedback] = useState<{
    activeId: string | null;
    fromKey: string | undefined;
    overId: string | null;
    overKey: string | undefined;
    edge: 'before' | 'after';
  }>({ activeId: null, fromKey: undefined, overId: null, overKey: undefined, edge: 'before' });
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const announcements = announcementsFor((id) => {
    const key = String(id);
    const task = state.tasks.get(key);
    if (task) return taskName(task.content);
    if (key === 'section:none') return 'the tasks without a section';
    if (key.startsWith('section:'))
      return `the section “${state.sections.get(key.slice(8))?.name ?? ''}”`;
    if (key.startsWith('children:'))
      return `the sub-tasks of ${taskName(state.tasks.get(key.slice(9))?.content ?? '')}`;
    return null;
  });

  const orderOf = (id: string | undefined) =>
    id ? (state.tasks.get(id)?.childOrder ?? null) : null;
  const validTarget = (taskId: string, target: Container) => {
    const seen = new Set<string>();
    for (let parent = target.parentId; parent; parent = state.tasks.get(parent)?.parentId ?? null) {
      if (parent === taskId || seen.has(parent)) return false;
      seen.add(parent);
    }
    return true;
  };
  const onDragStart = ({ active }: DragStartEvent) => {
    if (readOnly) return;
    const id = String(active.id);
    setDraggingTask(state.tasks.get(id) ?? null);
    setDraggingWidth(active.rect.current.initial?.width);
    setDragFeedback({
      activeId: id,
      fromKey: active.data.current?.sortable?.containerId as string | undefined,
      overId: id,
      overKey: active.data.current?.sortable?.containerId as string | undefined,
      edge: 'before',
    });
  };
  const onDragOver = ({ active, over }: DragOverEvent) => {
    const fromKey = active.data.current?.sortable?.containerId as string | undefined;
    const overId = over ? String(over.id) : null;
    const overKey = over
      ? ((over.data.current?.sortable?.containerId as string | undefined) ?? String(over.id))
      : undefined;
    const source = fromKey ? registry.get(fromKey) : undefined;
    const target = overKey ? registry.get(overKey) : undefined;
    if (!target || !validTarget(String(active.id), target)) {
      setDragFeedback({
        activeId: String(active.id),
        fromKey,
        overId: null,
        overKey: undefined,
        edge: 'before',
      });
      return;
    }
    const edge =
      fromKey && fromKey === overKey && source && overId && overId !== String(active.id)
        ? source.ids.indexOf(String(active.id)) < source.ids.indexOf(overId)
          ? 'after'
          : 'before'
        : 'before';
    setDragFeedback({ activeId: String(active.id), fromKey, overId, overKey, edge });
  };
  const clearDragFeedback = () => {
    setDraggingTask(null);
    setDraggingWidth(undefined);
    setDragFeedback({
      activeId: null,
      fromKey: undefined,
      overId: null,
      overKey: undefined,
      edge: 'before',
    });
  };
  const onDragEnd = ({ active, over, delta }: DragEndEvent) => {
    clearDragFeedback();
    if (readOnly) return;
    const task = state.tasks.get(String(active.id));
    if (!task || !over) return;
    const fromKey = active.data.current?.sortable?.containerId as string | undefined;
    const toKey =
      (over.data.current?.sortable?.containerId as string | undefined) ?? String(over.id);
    const target = registry.get(toKey);
    if (!target || !validTarget(task.id, target)) return;

    let ids: string[];
    if (fromKey === toKey) {
      const from = target.ids.indexOf(task.id);
      if (from < 0) return;
      const to = target.ids.indexOf(String(over.id));
      ids = arrayMove(target.ids, from, to === -1 ? target.ids.length - 1 : to);
    } else {
      ids = target.ids.filter((id) => id !== task.id);
      const at = ids.indexOf(String(over.id));
      ids.splice(at === -1 ? ids.length : at, 0, task.id);
    }
    const pos = ids.indexOf(task.id);
    const prevId = ids[pos - 1];

    // Indent: make it the last sub-task of the task above.
    if (delta.x > NEST_PX && prevId) {
      const kids = childrenOf(state, prevId);
      actions.place(task, {
        projectId: target.projectId,
        sectionId: target.sectionId,
        parentId: prevId,
        childOrder: between(kids.at(-1)?.childOrder ?? null, null),
      });
      return;
    }
    // Outdent: place right after the current parent, one level up.
    if (delta.x < -NEST_PX && target.parentId) {
      const parent = state.tasks.get(target.parentId);
      if (parent) {
        const siblings = [...state.tasks.values()]
          .filter(
            (t) =>
              t.projectId === parent.projectId &&
              t.sectionId === parent.sectionId &&
              t.parentId === parent.parentId,
          )
          .sort(byOrder);
        const after = siblings[siblings.findIndex((t) => t.id === parent.id) + 1];
        actions.place(task, {
          projectId: parent.projectId,
          sectionId: parent.sectionId,
          parentId: parent.parentId,
          childOrder: between(parent.childOrder, after?.childOrder ?? null),
        });
        return;
      }
    }
    if (fromKey === toKey && ids.join() === target.ids.join()) return;
    actions.place(task, {
      projectId: target.projectId,
      sectionId: target.sectionId,
      parentId: target.parentId,
      childOrder: between(orderOf(prevId), orderOf(ids[pos + 1])),
    });
  };

  return (
    <Registry.Provider value={registry}>
      <Collapsed.Provider
        value={{
          isCollapsed: (id) => collapsed.has(id),
          toggle: (id) =>
            setCollapsed((s) =>
              s.has(id) ? new Set([...s].filter((x) => x !== id)) : new Set([...s, id]),
            ),
          showCompleted,
        }}
      >
        <DndContext
          sensors={sensors}
          collisionDetection={listCollisionDetection}
          onDragStart={onDragStart}
          onDragOver={onDragOver}
          onDragEnd={onDragEnd}
          onDragCancel={clearDragFeedback}
          accessibility={{ announcements }}
        >
          <DropFeedback.Provider
            value={{ ...dragFeedback, dragging: draggingTask !== null, readOnly }}
          >
            {children}
          </DropFeedback.Provider>
          <DragOverlay dropAnimation={{ duration: 180, easing: 'ease' }}>
            {draggingTask && <TaskDragPreview task={draggingTask} width={draggingWidth} />}
          </DragOverlay>
        </DndContext>
      </Collapsed.Provider>
    </Registry.Provider>
  );
}

/** A sortable list of sibling tasks (a section's top level, or one task's sub-tasks). */
export function SortableTaskList({
  id,
  tasks,
  projectId,
  sectionId,
  parentId = null,
  depth = 0,
  orderedIds,
  footer,
}: {
  id: string;
  tasks: Task[];
  projectId: string;
  sectionId: string | null;
  parentId?: string | null;
  depth?: number;
  orderedIds: string[];
  footer?: ReactNode;
}) {
  const registry = useContext(Registry);
  const { dragging, readOnly, overKey } = useContext(DropFeedback);
  const ids = tasks.map((t) => t.id).join(',');
  useLayoutEffect(() => {
    registry?.set(id, { projectId, sectionId, parentId, ids: ids ? ids.split(',') : [] });
    return () => void registry?.delete(id);
  }, [registry, id, projectId, sectionId, parentId, ids]);
  const { setNodeRef, isOver } = useDroppable({ id, disabled: readOnly });
  return (
    <SortableContext id={id} items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
      <ul
        ref={setNodeRef}
        className={`min-h-2 rounded transition-colors ${tasks.length === 0 ? `min-h-12 border border-dashed ${dragging ? 'border-line/80' : 'border-transparent'}` : ''} ${isOver && overKey === id ? 'border-accent bg-accent/10 ring-1 ring-accent/40' : ''}`}
      >
        {tasks.map((t) => (
          <SortableTask key={t.id} task={t} depth={depth} orderedIds={orderedIds} />
        ))}
      </ul>
      {footer}
    </SortableContext>
  );
}

function SortableTask({
  task,
  depth,
  orderedIds,
}: {
  task: Task;
  depth: number;
  orderedIds: string[];
}) {
  const state = useSyncState();
  const { isCollapsed, toggle, showCompleted } = useContext(Collapsed);
  const { activeId, edge, overId, readOnly } = useContext(DropFeedback);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } =
    useSortable({ id: task.id, data: { task }, disabled: readOnly });
  const highlighted = isOver && overId === task.id && activeId !== task.id;
  const kids = childrenOf(state, task.id).filter((k) => showCompleted || !k.isCompleted);
  const collapsed = isCollapsed(task.id);
  return (
    <TaskItem
      task={task}
      depth={depth}
      orderedIds={orderedIds}
      {...(!readOnly ? { dragHandle: { attributes, listeners } } : {})}
      reorderable={!readOnly}
      listItem={{
        ref: setNodeRef,
        style: { transform: CSS.Translate.toString(transform), transition },
        className: [
          isDragging ? 'relative z-10 opacity-25' : '',
          isDragging ? 'rounded-md outline-1 -outline-offset-1 outline-dashed outline-muted' : '',
          highlighted ? 'relative z-[1] rounded-md bg-accent/10 ring-2 ring-accent/50' : '',
          highlighted && edge === 'after'
            ? 'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-accent'
            : '',
          highlighted && edge === 'before'
            ? 'before:absolute before:inset-x-0 before:-top-px before:h-0.5 before:bg-accent'
            : '',
        ]
          .filter(Boolean)
          .join(' '),
      }}
      {...(kids.length ? { collapsed, onToggleCollapsed: () => toggle(task.id) } : {})}
    >
      {kids.length > 0 && !collapsed && (
        <SortableTaskList
          id={`children:${task.id}`}
          tasks={kids}
          projectId={task.projectId}
          sectionId={task.sectionId}
          parentId={task.id}
          depth={depth + 1}
          orderedIds={orderedIds}
        />
      )}
    </TaskItem>
  );
}

/** A visual-only row snapshot for the overlay; it has no task controls or event handlers. */
function TaskDragPreview({ task, width }: { task: Task; width?: number | undefined }) {
  return (
    <div
      aria-hidden="true"
      style={{ width: width ? `min(${width}px, calc(100vw - 2rem))` : undefined }}
      className="pointer-events-none w-[min(34rem,calc(100vw-2rem))] rounded-md border border-accent/50 bg-surface px-2 py-2 shadow-xl ring-1 ring-black/5"
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          className={`mt-0.5 size-4 shrink-0 rounded-full border-2 ${task.isCompleted ? 'border-accent bg-accent/50' : 'border-muted'}`}
        />
        <div className="min-w-0 flex-1">
          <div
            className={`break-words text-sm ${task.isCompleted ? 'text-muted line-through' : ''}`}
          >
            {task.content}
          </div>
          {task.description.trim() && (
            <div className="mt-1 line-clamp-1 text-xs text-muted">{task.description}</div>
          )}
          {task.labels.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {task.labels.map((label) => (
                <span
                  key={label}
                  className="rounded bg-surface-alt px-1.5 py-0.5 text-xs text-muted"
                >
                  @{label}
                </span>
              ))}
            </div>
          )}
        </div>
        <span
          className={`mt-1 size-2 shrink-0 rounded-full ${
            task.priority === 1
              ? 'bg-p1'
              : task.priority === 2
                ? 'bg-p2'
                : task.priority === 3
                  ? 'bg-p3'
                  : 'bg-p4'
          }`}
        />
      </div>
    </div>
  );
}

/** Read-only-order list (Today, labels, search): no drag, optional project names. */
export function PlainTaskList({
  tasks,
  showProject = true,
}: {
  tasks: Task[];
  showProject?: boolean;
}) {
  const ids = tasks.map((t) => t.id);
  return (
    <ul>
      {tasks.map((t) => (
        <TaskItem key={t.id} task={t} orderedIds={ids} showProject={showProject} />
      ))}
    </ul>
  );
}
