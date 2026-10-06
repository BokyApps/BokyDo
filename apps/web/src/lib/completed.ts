/**
 * URL for the completed-task history. Without a projectId the server returns completed tasks from
 * every project the caller can see; `cursor` pages backwards in completion time.
 */
export function completedTasksPath(projectId?: string, cursor?: string | null): string {
  const params = new URLSearchParams();
  if (projectId) params.set('projectId', projectId);
  if (cursor) params.set('before', cursor);
  const query = params.toString();
  return `/api/v1/tasks/completed${query ? `?${query}` : ''}`;
}
