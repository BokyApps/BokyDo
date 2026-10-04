import { generateKeyBetween, type CommandArgs, type Due, type Task } from '@bokydo/shared';
import { useMemo } from 'react';
import { useConfirm } from './confirm.js';
import { newId, useSend, useStore } from './sync.js';
import { useToast } from './toasts.js';
import { byOrder, childrenOf } from './views.js';

export type TaskPatch = Omit<CommandArgs<'task_update'>, 'id'>;

/** Task operations shared by every view, with undo where Todoist offers it. */
export function useTaskActions() {
  const send = useSend();
  const store = useStore();
  const toast = useToast();
  const confirm = useConfirm();

  return useMemo(() => {
    const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

    const actions = {
      add: (args: Omit<CommandArgs<'task_add'>, 'id'>) => {
        const id = newId();
        send('task_add', { id, ...args });
        return id;
      },

      update: (id: string, patch: TaskPatch) => send('task_update', { id, ...patch }),

      complete: (tasks: Task[]) => {
        for (const t of tasks) send('task_complete', { id: t.id });
        toast({
          message:
            tasks.length === 1 ? 'Task completed' : `${plural(tasks.length, 'task')} completed`,
          action: {
            label: 'Undo',
            onClick: () => tasks.forEach((t) => send('task_uncomplete', { id: t.id })),
          },
        });
      },

      uncomplete: (task: Task) => send('task_uncomplete', { id: task.id }),

      reschedule: (tasks: Task[], due: Due | null) => {
        const before = tasks.map((t) => ({ id: t.id, due: t.due }));
        for (const t of tasks) send('task_update', { id: t.id, due });
        toast({
          message: due ? `Scheduled for ${due.string}` : 'Date removed',
          action: {
            label: 'Undo',
            onClick: () => before.forEach((b) => send('task_update', { id: b.id, due: b.due })),
          },
        });
      },

      setPriority: (tasks: Task[], priority: number) =>
        tasks.forEach((t) => send('task_update', { id: t.id, priority })),

      addLabel: (tasks: Task[], label: string) =>
        tasks.forEach((t) => {
          if (!t.labels.some((l) => l.toLowerCase() === label.toLowerCase()))
            send('task_update', { id: t.id, labels: [...t.labels, label] });
        }),

      move: (
        tasks: Task[],
        to: { projectId: string; sectionId?: string | null },
        projectName?: string,
      ) => {
        const before = tasks.map((t) => ({
          id: t.id,
          projectId: t.projectId,
          sectionId: t.sectionId,
          parentId: t.parentId,
        }));
        for (const t of tasks)
          send('task_move', { id: t.id, projectId: to.projectId, sectionId: to.sectionId ?? null });
        toast({
          message: `Moved ${tasks.length === 1 ? 'task' : plural(tasks.length, 'task')}${projectName ? ` to ${projectName}` : ''}`,
          action: {
            label: 'Undo',
            onClick: () =>
              before.forEach((b) =>
                b.parentId
                  ? send('task_move', { id: b.id, parentId: b.parentId })
                  : send('task_move', { id: b.id, projectId: b.projectId, sectionId: b.sectionId }),
              ),
          },
        });
      },

      /** Reorder / re-parent from drag-and-drop or keyboard. */
      place: (
        task: Task,
        to: {
          projectId: string;
          sectionId: string | null;
          parentId: string | null;
          childOrder: string;
        },
      ) =>
        to.parentId
          ? send('task_move', { id: task.id, parentId: to.parentId, childOrder: to.childOrder })
          : send('task_move', {
              id: task.id,
              projectId: to.projectId,
              sectionId: to.sectionId,
              parentId: null,
              childOrder: to.childOrder,
            }),

      remove: async (tasks: Task[]) => {
        const subtasks = tasks.reduce((n, t) => n + childrenOf(store.state, t.id).length, 0);
        const ok = await confirm({
          title: tasks.length === 1 ? 'Delete task?' : `Delete ${plural(tasks.length, 'task')}?`,
          message:
            tasks.length === 1
              ? `“${tasks[0]?.content ?? ''}”${subtasks ? ' and its sub-tasks' : ''} will be permanently deleted.`
              : 'They will be permanently deleted, with their sub-tasks.',
          confirmLabel: 'Delete',
          danger: true,
        });
        if (ok) for (const t of tasks) send('task_delete', { id: t.id });
        return ok;
      },

      /** Copy a task and its sub-tasks, placed right after the original. */
      duplicate: (task: Task) => {
        const siblings = [...store.state.tasks.values()]
          .filter(
            (t) =>
              t.projectId === task.projectId &&
              t.sectionId === task.sectionId &&
              t.parentId === task.parentId,
          )
          .sort(byOrder);
        const next = siblings[siblings.findIndex((t) => t.id === task.id) + 1];
        const copy = (t: Task, parentId: string | null, childOrder?: string) => {
          const id = newId();
          send('task_add', {
            id,
            projectId: t.projectId,
            sectionId: t.sectionId,
            parentId,
            content: t.content,
            description: t.description,
            priority: t.priority,
            due: t.due,
            deadline: t.deadline,
            durationMinutes: t.durationMinutes,
            labels: t.labels,
            ...(childOrder ? { childOrder } : {}),
          });
          for (const kid of childrenOf(store.state, t.id).filter((k) => !k.isCompleted))
            copy(kid, id);
        };
        copy(task, task.parentId, generateKeyBetween(task.childOrder, next?.childOrder ?? null));
        toast({ message: 'Task duplicated' });
      },

      copyLink: (task: Task) => {
        void navigator.clipboard
          .writeText(`${window.location.origin}/task/${task.id}`)
          .then(() => toast({ message: 'Link copied' }));
      },
    };
    return actions;
  }, [send, store, toast, confirm]);
}
