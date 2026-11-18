import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui.js';
import { LinkIcon } from '../../components/icons.js';
import {
  createNote,
  linkNoteTask,
  noteErrorMessage,
  notesKeys,
  searchNoteOptions,
  taskNotesQuery,
  unlinkNoteTask,
} from '../../lib/notes.js';
import { useToast } from '../../lib/toasts.js';
import { ResourcePicker, type PickerItem } from './ResourcePicker.js';

/** The Notes section of a task's detail panel: the caller's own linked notes and ways to add one. */
export function TaskNotesSection({ taskId, taskContent }: { taskId: string; taskContent: string }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [pickerOpen, setPickerOpen] = useState(false);

  const list = useQuery(taskNotesQuery(taskId));
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: notesKeys.taskNotes(taskId) });
    void client.invalidateQueries({ queryKey: notesKeys.all });
  }, [client, taskId]);

  const link = useMutation({
    mutationFn: (noteId: string) => linkNoteTask(noteId, taskId),
    onSuccess: refresh,
    onError: (err) => toast({ tone: 'error', message: noteErrorMessage(err) }),
  });
  const unlink = useMutation({
    mutationFn: (noteId: string) => unlinkNoteTask(noteId, taskId),
    onSuccess: refresh,
    onError: (err) => toast({ tone: 'error', message: noteErrorMessage(err) }),
  });
  const newFromTask = useMutation({
    mutationFn: () => {
      const id = crypto.randomUUID();
      const label = taskContent.replace(/[\][()]/g, '').trim() || 'Task';
      return createNote({
        id,
        title: taskContent.slice(0, 200),
        body: `[${label}](bokydo:task/${taskId})`,
        tags: [],
        pinned: false,
      }).then(() => id);
    },
    onSuccess: async (id) => {
      await refresh();
      await navigate({ to: '/notes/$noteId', params: { noteId: id } });
    },
    onError: (err) => toast({ tone: 'error', message: noteErrorMessage(err) }),
  });

  const noteSearch = useCallback(
    (q: string): Promise<PickerItem[]> =>
      searchNoteOptions(q).then((r) => r.map((n) => ({ id: n.id, label: n.title }))),
    [],
  );

  return (
    <section
      aria-label={t('notes.taskSection', { defaultValue: 'Notes' })}
      className="border-t border-line pt-3"
    >
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">
          {t('notes.taskSection', { defaultValue: 'Notes' })}
        </h3>
        <div className="flex gap-1">
          <Button variant="ghost" onClick={() => setPickerOpen(true)}>
            <LinkIcon /> {t('notes.linkNote', { defaultValue: 'Link note' })}
          </Button>
          <Button variant="ghost" onClick={() => newFromTask.mutate()} busy={newFromTask.isPending}>
            {t('notes.newFromTask', { defaultValue: 'New note from task' })}
          </Button>
        </div>
      </div>

      {list.isError && (
        <p className="text-sm text-danger" role="alert">
          {noteErrorMessage(list.error)}{' '}
          <Button variant="ghost" onClick={() => void list.refetch()}>
            {t('common.retry', { defaultValue: 'Try again' })}
          </Button>
        </p>
      )}
      {list.data?.notes.length === 0 && (
        <p className="text-sm text-muted">
          {t('notes.taskSectionEmpty', { defaultValue: 'No notes linked to this task yet.' })}
        </p>
      )}
      <ul className="space-y-0.5 text-sm">
        {list.data?.notes.map((note) => (
          <li
            key={note.id}
            className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-surface-alt"
          >
            <Link
              to="/notes/$noteId"
              params={{ noteId: note.id }}
              className="min-w-0 flex-1 truncate hover:text-accent"
            >
              {note.title || t('notes.untitled', { defaultValue: 'Untitled' })}
            </Link>
            <button
              type="button"
              aria-label={t('notes.unlinkNote', { defaultValue: 'Unlink note' })}
              className="text-muted hover:text-danger"
              onClick={() => unlink.mutate(note.id)}
            >
              ×
            </button>
          </li>
        ))}
      </ul>

      <ResourcePicker
        open={pickerOpen}
        title={t('notes.linkNote', { defaultValue: 'Link note' })}
        placeholder={t('notes.linkNoteSearch', { defaultValue: 'Search notes' })}
        search={noteSearch}
        onPick={(id) => link.mutate(id)}
        onClose={() => setPickerOpen(false)}
      />
    </section>
  );
}
