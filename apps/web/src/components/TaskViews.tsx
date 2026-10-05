import type { Task } from '@bokydo/shared';
import { useTaskActions } from '../lib/actions.js';
import { dueLabel, makeDue, todayIn } from '../lib/dates.js';
import { usePreferences, useSyncState, useTimeZone } from '../lib/sync.js';
import type { AddDefaults } from '../lib/task-ui.js';
import type { ViewOptions } from '../lib/view-options.js';
import { groupTasks, projectOrderIndex, sortTasks } from '../lib/views.js';
import { Board, type BoardColumn, type BoardDrop } from './Board.js';
import { CalendarView } from './Calendar.js';
import { InlineAdd } from './TaskEditor.js';
import { PlainTaskList } from './TaskTree.js';

const WRITABLE = ['owner', 'admin', 'editor'];

/**
 * A computed set of tasks (a label, a filter list) in the chosen layout. On a board, dropping a
 * card into another group applies that group's value: its priority, date or project.
 */
export function TaskCollection({
  tasks,
  options,
  addDefaults,
  showAdd = true,
}: {
  tasks: Task[];
  options: ViewOptions;
  addDefaults?: AddDefaults;
  showAdd?: boolean;
}) {
  const state = useSyncState();
  const prefs = usePreferences();
  const today = todayIn(useTimeZone());
  const actions = useTaskActions();
  const sorted = sortTasks(tasks, options.sort, projectOrderIndex(state));
  const groups = groupTasks(sorted, options.group, state, today);

  if (options.layout === 'calendar')
    return <CalendarView tasks={sorted} {...(addDefaults ? { addDefaults } : {})} />;

  if (options.layout === 'board') {
    const mode = options.group;
    const droppable = mode === 'priority' || mode === 'date' || mode === 'project';
    const defaultsFor = (key: string, base: AddDefaults): AddDefaults => {
      if (mode === 'date' && /^\d/.test(key))
        return { ...base, due: makeDue(key, null, today, prefs) };
      if (mode === 'project') return { ...base, projectId: key };
      return base;
    };
    const columns: BoardColumn[] = groups.map((g) => ({
      id: g.key,
      title: g.title || 'Tasks',
      tasks: g.tasks,
      droppable: droppable && g.key !== '!overdue',
      ...(showAdd && addDefaults ? { addDefaults: defaultsFor(g.key, addDefaults) } : {}),
    }));
    const onDrop = ({ task, columnId }: BoardDrop) => {
      // Reordering inside a computed group has no meaning; only moving between groups does.
      if (groups.find((g) => g.tasks.includes(task))?.key === columnId) return;
      if (mode === 'priority') actions.setPriority([task], Number(columnId.slice(1)));
      else if (mode === 'date') {
        if (columnId === '~') actions.reschedule([task], null);
        else
          actions.reschedule(
            [task],
            task.due?.recurrence
              ? { ...task.due, date: columnId }
              : makeDue(columnId, task.due?.time ?? null, today, prefs),
          );
      } else if (mode === 'project') {
        const target = state.projects.get(columnId);
        if (target && WRITABLE.includes(target.role) && target.id !== task.projectId)
          actions.move([task], { projectId: target.id, sectionId: null }, target.name);
      }
    };
    return <Board columns={columns} onDrop={onDrop} showProject={mode !== 'project'} />;
  }

  return (
    <>
      {groups.map((g) => (
        <section key={g.key}>
          {g.title && (
            <h2 className="mt-4 border-b border-line pb-1 font-semibold">
              {options.group === 'date' && /^\d/.test(g.key)
                ? dueLabel(makeDue(g.key, null, today, prefs), today, prefs)
                : g.title}
            </h2>
          )}
          <PlainTaskList tasks={g.tasks} />
        </section>
      ))}
      {showAdd && addDefaults && <InlineAdd defaults={addDefaults} />}
    </>
  );
}
