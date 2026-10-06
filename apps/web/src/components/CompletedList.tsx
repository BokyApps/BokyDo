import type { Task } from '@bokydo/shared';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../lib/api.js';
import { completedTasksPath } from '../lib/completed.js';
import { errorMessage } from '../lib/messages.js';
import { PlainTaskList } from './TaskTree.js';
import { Alert, Button } from './ui.js';

/**
 * Completed tasks come from the server (sync only carries the last week of them). Without a
 * projectId it lists every project the user can see, and each row names its project.
 */
export function CompletedList({ projectId }: { projectId?: string }) {
  const [before, setBefore] = useState<string[]>([]);
  const pages = useQuery({
    queryKey: ['completed', projectId ?? 'all', before],
    // Keep the rows already on screen while the next page loads, so "Show more" doesn't blank them.
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const all: Task[] = [];
      let cursor: string | null = null;
      for (let i = 0; i <= before.length; i++) {
        const res: { tasks: Task[]; nextBefore: string | null } = await api(
          'GET',
          completedTasksPath(projectId, cursor),
        );
        all.push(...res.tasks);
        cursor = res.nextBefore;
        if (!cursor) break;
      }
      return { tasks: all, more: cursor };
    },
  });
  const tasks = (pages.data?.tasks ?? []).filter((t) => !t.parentId);

  if (pages.isPending)
    return (
      <p role="status" className="py-2 text-sm text-muted">
        Loading completed tasks…
      </p>
    );
  if (pages.isError)
    return (
      <Alert>
        {errorMessage(pages.error)}{' '}
        <button type="button" className="underline" onClick={() => void pages.refetch()}>
          Try again
        </button>
      </Alert>
    );
  return (
    <>
      {tasks.length ? (
        <PlainTaskList tasks={tasks} showProject={!projectId} />
      ) : (
        <p className="py-2 text-sm text-muted">No completed tasks.</p>
      )}
      {pages.data?.more && (
        <Button
          variant="ghost"
          busy={pages.isFetching}
          onClick={() => setBefore([...before, pages.data.more ?? ''])}
        >
          Show more
        </Button>
      )}
    </>
  );
}
