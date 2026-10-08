import type { Task } from '@bokydo/shared';
import { useEffect } from 'react';
import { DatePicker } from '../components/pickers.js';
import { InlineAdd } from '../components/TaskEditor.js';
import { PlainTaskList } from '../components/TaskTree.js';
import { ReportPanel } from '../components/ReportPanel.js';
import { EmptyState, Page, ViewHeader } from '../components/ViewHeader.js';
import { useTaskActions } from '../lib/actions.js';
import { formatDate, makeDue, todayIn } from '../lib/dates.js';
import { usePreferences, useSyncState, useTimeZone } from '../lib/sync.js';
import { useTaskUI } from '../lib/task-ui.js';
import { useViewOptions } from '../lib/view-options.js';
import { groupTasks, projectOrderIndex, sortTasks, todayTasks } from '../lib/views.js';

export function TodayPage() {
  const state = useSyncState();
  const prefs = usePreferences();
  const today = todayIn(useTimeZone());
  const actions = useTaskActions();
  const { setViewDefaults } = useTaskUI();
  const [options, setOptions] = useViewOptions('today', { sort: 'date' });
  useEffect(
    () => setViewDefaults({ due: makeDue(today, null, today, prefs) }),
    [today, prefs, setViewDefaults],
  );

  const { overdue, today: due } = todayTasks(state, today);
  const order = projectOrderIndex(state);
  const sorted = (tasks: Task[]) => sortTasks(tasks, options.sort, order);
  const weekdayName = new Date(`${today}T00:00:00Z`).toLocaleDateString(undefined, {
    weekday: 'long',
    timeZone: 'UTC',
  });

  return (
    <Page>
      <ViewHeader
        title="Today"
        subtitle={`${weekdayName} ${formatDate(today, prefs)}`}
        options={options}
        setOptions={setOptions}
      />
      <ReportPanel target={{ kind: 'day' }} label="Plan my day" className="mb-6" />
      {overdue.length > 0 && (
        <section aria-label="Overdue" className="mb-6">
          <div className="flex items-center justify-between border-b border-line pb-1">
            <h2 className="font-semibold">Overdue</h2>
            <DatePicker
              value={null}
              onChange={(d) => actions.reschedule(overdue, d)}
              label="Reschedule"
            />
          </div>
          <PlainTaskList tasks={sorted(overdue)} />
        </section>
      )}
      {groupTasks(sorted(due), options.group, state, today).map((g) => (
        <section key={g.key} aria-label={g.title || 'Today'}>
          {g.title && <h2 className="mt-4 border-b border-line pb-1 font-semibold">{g.title}</h2>}
          <PlainTaskList tasks={g.tasks} />
        </section>
      ))}
      <InlineAdd defaults={{ due: makeDue(today, null, today, prefs) }} />
      {overdue.length + due.length === 0 && (
        <EmptyState title="You're all done for today">Enjoy the rest of your day.</EmptyState>
      )}
    </Page>
  );
}
