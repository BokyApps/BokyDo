import type { Task } from '@bokydo/shared';
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
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
const Collapsed = createContext<{
  isCollapsed: (id: string) => boolean;
  toggle: (id: string) => void;
  showCompleted: boolean;
}>({
  isCollapsed: () => false,
  toggle: () => undefined,
  showCompleted: false,
});

/** Horizontal drag distance (px) that turns a move into indent/outdent. */
const NEST_PX = 48;

/**
 * Drag-and-drop for a project's lists. Drop between tasks to reorder (also across sections);
 * drag right onto the task above to make a sub-task, left to promote it back out.
 */
export function TaskDnd({
  children,
  showCompleted = false,
}: {
  children: ReactNode;
  showCompleted?: boolean;
}) {
  const [registry] = useState(() => new Map<string, Container>());
  const state = useSyncState();
  const actions = useTaskActions();
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
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
  const onDragEnd = ({ active, over, delta }: DragEndEvent) => {
    const task = state.tasks.get(String(active.id));
    if (!task || !over) return;
    const fromKey = active.data.current?.sortable?.containerId as string | undefined;
    const toKey =
      (over.data.current?.sortable?.containerId as string | undefined) ?? String(over.id);
    const target = registry.get(toKey);
    if (!target) return;

    let ids: string[];
    if (fromKey === toKey) {
      const from = target.ids.indexOf(task.id);
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
          collisionDetection={closestCenter}
          onDragEnd={onDragEnd}
          accessibility={{ announcements }}
        >
          {children}
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
  const ids = tasks.map((t) => t.id).join(',');
  useLayoutEffect(() => {
    registry?.set(id, { projectId, sectionId, parentId, ids: ids ? ids.split(',') : [] });
    return () => void registry?.delete(id);
  }, [registry, id, projectId, sectionId, parentId, ids]);
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <SortableContext id={id} items={tasks.map((t) => t.id)} strategy={verticalListSortingStrategy}>
      <ul
        ref={setNodeRef}
        className={`min-h-2 ${isOver && tasks.length === 0 ? 'rounded bg-accent/10' : ''}`}
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
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
  });
  const kids = childrenOf(state, task.id).filter((k) => showCompleted || !k.isCompleted);
  const collapsed = isCollapsed(task.id);
  return (
    <TaskItem
      task={task}
      depth={depth}
      orderedIds={orderedIds}
      dragHandle={{ attributes, listeners }}
      reorderable
      listItem={{
        ref: setNodeRef,
        style: { transform: CSS.Translate.toString(transform), transition },
        className: isDragging ? 'relative z-10 opacity-60' : '',
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
