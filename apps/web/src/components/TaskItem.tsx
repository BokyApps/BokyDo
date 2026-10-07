import { Avatar } from './Sharing.js';
import type { Task } from '@bokydo/shared';
import type { DraggableAttributes, DraggableSyntheticListeners } from '@dnd-kit/core';
import {
  useId,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type Ref,
} from 'react';
import { useTaskActions } from '../lib/actions.js';
import { describeDate, describeDue, TONE_CLASS } from '../lib/dates.js';
import { usePreferences, useSyncState, useTimeZone } from '../lib/sync.js';
import { todayIn } from '../lib/dates.js';
import { useTaskUI } from '../lib/task-ui.js';
import { taskMoves } from '../lib/task-moves.js';
import { subtaskProgress } from '../lib/views.js';
import {
  CalendarIcon,
  CheckIcon,
  ChevronIcon,
  CommentIcon,
  CopyIcon,
  DeadlineIcon,
  DescriptionIcon,
  EditIcon,
  GripIcon,
  LinkIcon,
  MoreIcon,
  SubtaskIcon,
  TrashIcon,
} from './icons.js';
import { InlineMarkdown } from './Markdown.js';
import { DatePicker, PRIORITY_CLASS, ProjectDot } from './pickers.js';
import { MenuItem, Popover } from './ui.js';

const RING: Record<number, string> = {
  1: 'border-p1 bg-p1/10',
  2: 'border-p2 bg-p2/10',
  3: 'border-p3 bg-p3/10',
  4: 'border-p4',
};

export function TaskCheckbox({ task, onToggle }: { task: Task; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={task.isCompleted}
      // One name for both states: the checked state says whether it is done.
      aria-label={`Complete “${task.content}”`}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      // The button is a 24px target (WCAG 2.5.8); the visible circle is smaller, inside it.
      className="group/check -mt-0.5 -mr-1 -ml-1 flex size-6 shrink-0 items-center justify-center rounded-full"
    >
      <span
        className={`flex size-[1.15rem] items-center justify-center rounded-full border-2 ${RING[task.priority]} ${PRIORITY_CLASS[task.priority]} ${task.isCompleted ? 'bg-current' : ''}`}
      >
        <span
          className={`scale-75 ${task.isCompleted ? 'text-bg' : 'opacity-0 group-hover/check:opacity-100'}`}
        >
          <CheckIcon />
        </span>
      </span>
    </button>
  );
}

export interface TaskItemProps {
  task: Task;
  orderedIds: string[];
  showProject?: boolean;
  depth?: number;
  collapsed?: boolean;
  onToggleCollapsed?: () => void;
  dragHandle?: {
    attributes: DraggableAttributes;
    listeners: DraggableSyntheticListeners | undefined;
    /** Dragging here is pointer-only (the keyboard has another way): the grip stays out of the tab order. */
    pointerOnly?: boolean;
  };
  /** In a hand-ordered list: the menu offers Move up/down and nesting, as alternatives to dragging. */
  reorderable?: boolean;
  /** For a sortable list: the drag library's ref and transform go on the `<li>` itself. */
  listItem?: { ref?: Ref<HTMLLIElement>; style?: CSSProperties; className?: string };
  children?: ReactNode;
}

/** One task row, Todoist-style: checkbox, title, description preview, meta chips, hover actions. */
export function TaskItem({
  task,
  orderedIds,
  showProject = false,
  depth = 0,
  collapsed,
  onToggleCollapsed,
  dragHandle,
  reorderable = false,
  listItem,
  children,
}: TaskItemProps) {
  const uid = useId();
  const state = useSyncState();
  const prefs = usePreferences();
  const today = todayIn(useTimeZone());
  const actions = useTaskActions();
  const ui = useTaskUI();
  const progress = subtaskProgress(state, task.id);
  const project = state.projects.get(task.projectId);
  const section = task.sectionId ? state.sections.get(task.sectionId) : undefined;
  const due = task.due ? describeDue(task.due, today, prefs) : null;
  const deadline = task.deadline ? describeDate(task.deadline, null, today, prefs) : null;
  const selected = ui.selected.has(task.id);
  const moves = reorderable ? taskMoves(state, task) : null;
  const readOnly = project ? !['owner', 'admin', 'editor'].includes(project.role) : true;
  const firstLine = task.description.split('\n').find((l) => l.trim()) ?? '';
  const assignee = task.assigneeId ? state.collaborators.get(task.assigneeId) : undefined;
  let commentCount = 0;
  for (const c of state.comments.values()) if (c.taskId === task.id) commentCount++;

  const onClick = (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey) ui.select(task.id, 'toggle', orderedIds);
    else if (e.shiftKey) ui.select(task.id, 'range', orderedIds);
    else if (ui.selected.size > 0) ui.select(task.id, 'toggle', orderedIds);
    else ui.openTask(task.id);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    // Letters and digits only act when single-key shortcuts are on (WCAG 2.1.4); arrow keys,
    // Enter and Delete always work.
    if (!prefs.keyboardShortcuts && e.key.length === 1) return;
    const rows = [...document.querySelectorAll<HTMLElement>('[data-task-row]')];
    const i = rows.indexOf(e.currentTarget);
    const move = (d: number) => rows[i + d]?.focus();
    switch (e.key) {
      case 'ArrowDown':
      case 'j':
        e.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
      case 'k':
        e.preventDefault();
        move(-1);
        break;
      case 'Enter':
      case 'e':
        e.preventDefault();
        ui.openTask(task.id);
        break;
      case 'x':
        e.preventDefault();
        ui.select(task.id, 'toggle', orderedIds);
        break;
      case 'c':
        if (!readOnly) actions.complete([task]);
        break;
      case 'Delete':
      case 'Backspace':
        if (!readOnly) void actions.remove([task]);
        break;
      case '1':
      case '2':
      case '3':
      case '4':
        if (!readOnly) actions.setPriority([task], Number(e.key));
        break;
    }
  };

  return (
    <li
      ref={listItem?.ref}
      style={listItem?.style}
      className={`list-none ${listItem?.className ?? ''}`}
    >
      <div
        data-task-row
        tabIndex={0}
        role="group"
        aria-labelledby={`${uid}-title`}
        aria-describedby={`${uid}-details`}
        onClick={onClick}
        onKeyDown={onKeyDown}
        className={`group relative flex cursor-pointer items-start gap-2 border-b border-line px-1 py-[var(--bk-row-py)] focus-visible:bg-surface-alt focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent ${selected ? 'bg-accent/10' : 'hover:bg-surface-alt/60'}`}
        style={{ paddingLeft: `${0.25 + depth * 1.75}rem` }}
      >
        {dragHandle && !readOnly ? (
          <button
            type="button"
            {...dragHandle.attributes}
            {...dragHandle.listeners}
            aria-label="Drag to reorder"
            {...(dragHandle.pointerOnly
              ? {
                  tabIndex: -1,
                  'aria-hidden': true,
                  role: undefined,
                  'aria-describedby': undefined,
                  'aria-roledescription': undefined,
                }
              : {})}
            className="absolute top-1 -left-6 flex size-6 cursor-grab items-center justify-center rounded text-muted opacity-0 group-hover:opacity-100 hover:text-fg focus-visible:opacity-100"
            onClick={(e) => e.stopPropagation()}
          >
            <GripIcon />
          </button>
        ) : null}
        {onToggleCollapsed ? (
          <button
            type="button"
            aria-label={collapsed ? 'Show sub-tasks' : 'Hide sub-tasks'}
            aria-expanded={!collapsed}
            className="absolute top-2 text-muted hover:text-fg"
            style={{ left: `${depth * 1.75 - 1.1}rem` }}
            onClick={(e) => {
              e.stopPropagation();
              onToggleCollapsed();
            }}
          >
            <ChevronIcon open={!collapsed} />
          </button>
        ) : null}
        <TaskCheckbox
          task={task}
          onToggle={() =>
            readOnly
              ? undefined
              : task.isCompleted
                ? actions.uncomplete(task)
                : actions.complete([task])
          }
        />
        <div className="min-w-0 flex-1">
          <div
            id={`${uid}-title`}
            className={`text-sm leading-snug break-words ${task.isCompleted ? 'text-muted line-through' : ''}`}
          >
            <InlineMarkdown text={task.content} />
          </div>
          {firstLine && <div className="truncate text-xs text-muted">{firstLine}</div>}
          <div
            id={`${uid}-details`}
            className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted"
          >
            {selected && <span className="sr-only">Selected.</span>}
            {due && (
              <span className={`inline-flex items-center gap-1 ${TONE_CLASS[due.tone]}`}>
                <CalendarIcon /> {due.label}
                {task.due?.recurrence && <span aria-label="repeats">↻</span>}
              </span>
            )}
            {deadline && (
              <span
                className={`inline-flex items-center gap-1 ${deadline.tone === 'overdue' ? 'text-danger' : ''}`}
                title="Deadline"
              >
                <DeadlineIcon /> {deadline.label}
              </span>
            )}
            {task.durationMinutes && (
              <span>
                {task.durationMinutes >= 60
                  ? `${task.durationMinutes / 60}h`
                  : `${task.durationMinutes}m`}
              </span>
            )}
            {progress && (
              <span className="inline-flex items-center gap-1">
                <SubtaskIcon /> {progress.done}/{progress.total}
              </span>
            )}
            {task.description && !firstLine && <DescriptionIcon />}
            {commentCount > 0 && (
              <span className="inline-flex items-center gap-1" title={`${commentCount} comments`}>
                <CommentIcon /> {commentCount}
              </span>
            )}
            {task.labels.map((l) => (
              <span key={l} className="text-p3">
                @{l}
              </span>
            ))}
            {assignee && (
              <span
                className="inline-flex items-center gap-1"
                title={`Assigned to ${assignee.username}`}
              >
                <Avatar name={assignee.username} /> {assignee.username}
              </span>
            )}
            {showProject && project && (
              <span className="ml-auto inline-flex items-center gap-1">
                {project.isInbox ? 'Inbox' : project.name}
                {section && ` / ${section.name}`}
                <ProjectDot color={project.color} />
              </span>
            )}
          </div>
        </div>
        {!readOnly && (
          <div
            className="hidden shrink-0 items-start gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 md:flex"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              aria-label="Edit task"
              className="rounded p-1 text-muted hover:bg-surface-alt hover:text-fg"
              onClick={() => ui.openTask(task.id)}
            >
              <EditIcon />
            </button>
            <DatePicker
              value={task.due}
              onChange={(d) => actions.reschedule([task], d)}
              chip={false}
              label=""
            />
            <Popover
              align="right"
              trigger={(p) => (
                <button
                  type="button"
                  aria-label="More actions"
                  className="rounded p-1 text-muted hover:bg-surface-alt hover:text-fg"
                  {...p}
                >
                  <MoreIcon />
                </button>
              )}
            >
              {(close) => (
                <>
                  <MenuItem
                    icon={<CopyIcon />}
                    onClick={() => {
                      actions.duplicate(task);
                      close();
                    }}
                  >
                    Duplicate
                  </MenuItem>
                  <MenuItem
                    icon={<LinkIcon />}
                    onClick={() => {
                      actions.copyLink(task);
                      close();
                    }}
                  >
                    Copy link
                  </MenuItem>
                  {moves && (moves.up || moves.down || moves.indent || moves.outdent) && (
                    <>
                      <div className="my-1 border-t border-line" />
                      {(
                        [
                          ['Move up', moves.up],
                          ['Move down', moves.down],
                          ['Make sub-task of the task above', moves.indent],
                          ['Move out of parent task', moves.outdent],
                        ] as const
                      ).map(([label, to]) =>
                        to ? (
                          <MenuItem
                            key={label}
                            onClick={() => {
                              actions.place(task, to);
                              close();
                            }}
                          >
                            {label}
                          </MenuItem>
                        ) : null,
                      )}
                    </>
                  )}
                  <div className="my-1 flex gap-1 px-3">
                    {[1, 2, 3, 4].map((p) => (
                      <button
                        key={p}
                        type="button"
                        aria-label={`Priority ${p}`}
                        className={`rounded p-1 hover:bg-surface-alt ${PRIORITY_CLASS[p]}`}
                        onClick={() => {
                          actions.setPriority([task], p);
                          close();
                        }}
                      >
                        ⚑
                      </button>
                    ))}
                  </div>
                  <MenuItem
                    icon={<TrashIcon />}
                    danger
                    onClick={() => {
                      close();
                      void actions.remove([task]);
                    }}
                  >
                    Delete
                  </MenuItem>
                </>
              )}
            </Popover>
          </div>
        )}
      </div>
      {children}
    </li>
  );
}
