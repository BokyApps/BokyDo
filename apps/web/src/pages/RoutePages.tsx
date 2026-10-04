import { useNavigate } from '@tanstack/react-router';
import { useEffect } from 'react';
import { Spinner } from '../components/ui.js';
import { usePreferences, useSyncState } from '../lib/sync.js';
import { useTaskUI } from '../lib/task-ui.js';
import { ProjectView } from './ProjectPage.js';

/** "/" goes to the user's chosen home view once their preferences have synced. */
export function HomeRedirect() {
  const state = useSyncState();
  const prefs = usePreferences();
  const navigate = useNavigate();
  useEffect(() => {
    if (state.user) void navigate({ to: `/${prefs.startPage}` as '/today', replace: true });
  }, [state.user, prefs.startPage, navigate]);
  return <Spinner />;
}

/** Shared task links (/task/:id): show the task's project with the task open. */
export function TaskLinkPage({ taskId }: { taskId: string }) {
  const state = useSyncState();
  const { openTask } = useTaskUI();
  const task = state.tasks.get(taskId);
  useEffect(() => {
    if (task) openTask(task.id);
  }, [task, openTask]);
  if (!state.user) return <Spinner />;
  return <ProjectView projectId={task?.projectId ?? state.user.inboxProjectId} />;
}
