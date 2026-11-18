import type { Note, NotePatch } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Page } from '../../components/ViewHeader.js';
import { Alert, Button, IconButton, Popover, Spinner, inputClass } from '../../components/ui.js';
import {
  ArchiveIcon,
  DownloadIcon,
  LinkIcon,
  StarIcon,
  TrashIcon,
} from '../../components/icons.js';
import { ApiError } from '../../lib/api.js';
import { useConfirm } from '../../lib/confirm.js';
import {
  deleteNote,
  linkNoteTask,
  noteErrorMessage,
  noteExportPath,
  noteFilePath,
  noteQuery,
  notesKeys,
  patchNote,
  searchLocalTasks,
  searchNoteOptions,
  toNoteDraft,
  unlinkNoteTask,
  uploadNoteFile,
  type NoteDraft,
} from '../../lib/notes.js';
import { NoteAutosave, type SaveStatus } from '../../lib/notes-autosave.js';
import {
  CensorFlow,
  lockCensors,
  onCensorLock,
  type CensorPrompts,
} from '../../lib/notes-censor.js';
import type { RevealAnchor } from '../../components/notes/callbacks.js';
import type { RevealState } from '../../components/notes/RevealOverlay.js';
import { RevealController } from '../../components/notes/reveal-controller.js';
import { useSyncState } from '../../lib/sync.js';
import { useToast } from '../../lib/toasts.js';
import { liveTasks } from '../../lib/views.js';
import { usePasswordPrompt } from './PasswordDialog.js';
import { ResourcePicker, type PickerItem } from './ResourcePicker.js';
import { TagEditor } from './TagEditor.js';

// TipTap, ProseMirror and markdown-it must never be in the entry chunk: the editor is loaded only
// when a note is actually opened.
const NoteEditor = lazy(() => import('../../components/notes/NoteEditor.js'));

const FORMATS: ('md' | 'docx' | 'pdf')[] = ['md', 'docx', 'pdf'];

/** Route component: load one note, then render the editor keyed by its id. */
export function NoteDetail({ noteId }: { noteId: string }) {
  const { t } = useTranslation();
  const query = useQuery(noteQuery(noteId));
  const navigate = useNavigate();

  if (query.isPending) return <Spinner />;
  if (query.isError) {
    return (
      <Page>
        <Alert>
          {noteErrorMessage(query.error)}{' '}
          <Button variant="secondary" onClick={() => void query.refetch()}>
            {t('common.retry', { defaultValue: 'Try again' })}
          </Button>
        </Alert>
        <Button variant="ghost" className="mt-4" onClick={() => void navigate({ to: '/notes' })}>
          {t('notes.back', { defaultValue: 'Back to notes' })}
        </Button>
      </Page>
    );
  }
  if (!query.data) return null;
  // Keyed by id so switching notes remounts with a fresh draft, while a background refetch of the
  // same note only refreshes read-only data (backlinks, files, linked tasks) without clobbering it.
  return <NoteDetailInner key={query.data.id} note={query.data} />;
}

function NoteDetailInner({ note }: { note: Note }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const confirm = useConfirm();
  const state = useSyncState();
  const { askPassword, dialog: passwordDialog } = usePasswordPrompt();

  const [draft, setDraft] = useState<NoteDraft>(() => toNoteDraft(note));
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [gone, setGone] = useState(false);
  const [lockKey, setLockKey] = useState(0);
  const [linkTaskOpen, setLinkTaskOpen] = useState(false);

  // --- censor flow: prompts are stable callbacks, held once for the life of the note -------------
  const confirmRemove = useCallback(
    () =>
      confirm({
        title: t('notes.censor.removeTitle', { defaultValue: 'Remove censor?' }),
        message: t('notes.censor.removeMessage', {
          defaultValue:
            'This puts the text back in plain sight in the note, where anyone reading it can copy it. Continue?',
        }),
        confirmLabel: t('notes.censor.remove', { defaultValue: 'Remove censor' }),
        danger: true,
      }),
    [confirm, t],
  );
  const [flow] = useState(
    () => new CensorFlow({ askPassword, confirmRemove } satisfies CensorPrompts),
  );

  // --- reveal overlay lifecycle (page-owned, CONTRACT CHANGE) ----------------------------------
  // The editor never receives reveal plaintext. The controller unlocks via the CensorFlow and
  // publishes the plaintext to a portal overlay; a request id discards late results after close /
  // lock / pagehide / note change. Escape, blur (in the overlay) and a 60 s timer close it.
  const [reveal] = useState(() => new RevealController((token) => flow.onReveal(token)));
  const [revealState, setRevealState] = useState<RevealState | null>(null);
  useEffect(() => reveal.subscribe(setRevealState), [reveal]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') reveal.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reveal]);
  useEffect(() => {
    if (!revealState) return;
    const timer = window.setTimeout(() => reveal.close(), 60_000);
    return () => window.clearTimeout(timer);
  }, [revealState, reveal]);

  // --- debounced, diff-only autosave ------------------------------------------------------------
  const [autosave] = useState(
    () =>
      new NoteAutosave(
        {
          delayMs: 800,
          save: async (patch) => {
            await patchNote(note.id, patch);
            void client.invalidateQueries({ queryKey: notesKeys.lists() });
            void client.invalidateQueries({ queryKey: notesKeys.tags() });
          },
          onStatus: setStatus,
          onError: (err) => {
            if (err instanceof ApiError && err.status === 404) {
              setGone(true);
            } else if (err instanceof ApiError && err.status === 409) {
              void client.invalidateQueries({ queryKey: notesKeys.detail(note.id) });
              toast({
                message: t('notes.conflict', {
                  defaultValue: 'This note changed elsewhere. Reloading.',
                }),
              });
            } else {
              toast({ tone: 'error', message: noteErrorMessage(err) });
            }
          },
        },
        toNoteDraft(note),
      ),
  );

  useEffect(() => {
    if (gone) return;
    autosave.update(draft);
  }, [draft, autosave, gone]);
  useEffect(() => () => void autosave.flush(), [autosave]);

  // A lock clears the key cache, closes any reveal overlay, discards pending unlocks (editor
  // remount) and password inputs. pagehide -> lockCensors() reaches this listener too.
  useEffect(
    () =>
      onCensorLock(() => {
        setLockKey((k) => k + 1);
        reveal.close();
      }),
    [reveal],
  );

  // --- structural mutations (state / trash / delete / links) -----------------------------------
  const refresh = useCallback(
    () => client.invalidateQueries({ queryKey: notesKeys.all }),
    [client],
  );
  const structural = useMutation({
    mutationFn: (patch: NotePatch) => patchNote(note.id, patch),
    onSuccess: refresh,
    onError: (err) => toast({ tone: 'error', message: noteErrorMessage(err) }),
  });
  const remove = useMutation({
    mutationFn: () => deleteNote(note.id),
    onSuccess: () => {
      void refresh();
      void navigate({ to: '/notes' });
    },
    onError: (err) => toast({ tone: 'error', message: noteErrorMessage(err) }),
  });
  const linkTask = useMutation({
    mutationFn: (taskId: string) => linkNoteTask(note.id, taskId),
    onSuccess: refresh,
    onError: (err) => toast({ tone: 'error', message: noteErrorMessage(err) }),
  });
  const unlinkTask = useMutation({
    mutationFn: (taskId: string) => unlinkNoteTask(note.id, taskId),
    onSuccess: refresh,
    onError: (err) => toast({ tone: 'error', message: noteErrorMessage(err) }),
  });

  const toList = () => void navigate({ to: '/notes' });
  const onDeleteForever = async () => {
    if (
      await confirm({
        title: t('notes.deleteTitle', { defaultValue: 'Delete forever?' }),
        message: t('notes.deleteMessage', {
          defaultValue: 'This permanently deletes the note and its files. It cannot be undone.',
        }),
        confirmLabel: t('notes.delete', { defaultValue: 'Delete forever' }),
        danger: true,
      })
    )
      remove.mutate();
  };

  // --- editor callbacks -----------------------------------------------------------------------
  const searchTasks = useCallback(
    (q: string) => Promise.resolve(searchLocalTasks(liveTasks(state), q)),
    [state],
  );
  const taskPickerSearch = useCallback(
    (q: string): Promise<PickerItem[]> =>
      Promise.resolve(
        searchLocalTasks(liveTasks(state), q).map((r) => ({ id: r.id, label: r.content })),
      ),
    [state],
  );
  const onUploadFile = useCallback(
    async (file: File) => {
      try {
        const res = await uploadNoteFile(note.id, file);
        return { id: res.id, filename: res.filename, contentType: res.contentType };
      } catch (err) {
        toast({ tone: 'error', message: noteErrorMessage(err) });
        throw err;
      }
    },
    [note.id, toast],
  );
  const onOpenInternal = useCallback(
    (kind: 'note' | 'task', id: string) => {
      if (kind === 'note') void navigate({ to: '/notes/$noteId', params: { noteId: id } });
      else void navigate({ to: '/task/$taskId', params: { taskId: id } });
    },
    [navigate],
  );
  const onCensor = useCallback((plaintext: string) => flow.onCensor(plaintext), [flow]);
  // Fire-and-forget reveal: the page unlocks and shows the overlay; nothing is returned to the editor.
  const onReveal = useCallback(
    (token: string, anchor: RevealAnchor) => {
      void reveal.request(token, anchor);
    },
    [reveal],
  );
  const onUncensor = useCallback((token: string) => flow.onUncensor(token), [flow]);
  const onProtectedCut = useCallback(
    () =>
      toast({
        message: t('notes.censor.cutBlocked', {
          defaultValue: "Censored text can't be cut; delete it or remove the censor first.",
        }),
      }),
    [toast, t],
  );

  const trashed = note.state === 'trashed';
  const saveLabel = gone
    ? t('notes.gone', { defaultValue: 'This note no longer exists.' })
    : status === 'saving'
      ? t('notes.saving', { defaultValue: 'Saving…' })
      : status === 'error'
        ? t('notes.saveError', { defaultValue: 'Save failed — retrying on next edit' })
        : t('notes.saved', { defaultValue: 'Saved' });

  return (
    <Page wide>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link to="/notes" className="text-sm text-muted hover:text-accent">
          ← {t('notes.back', { defaultValue: 'Back to notes' })}
        </Link>
        <span className="ml-auto text-xs text-muted" aria-live="polite" role="status">
          {saveLabel}
        </span>
      </div>

      {gone && (
        <Alert>
          {t('notes.gone', { defaultValue: 'This note no longer exists.' })}{' '}
          <Button variant="secondary" onClick={toList}>
            {t('notes.back', { defaultValue: 'Back to notes' })}
          </Button>
        </Alert>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <IconButton
          label={
            draft.pinned
              ? t('notes.unpin', { defaultValue: 'Unpin' })
              : t('notes.pin', { defaultValue: 'Pin' })
          }
          aria-pressed={draft.pinned}
          onClick={() => setDraft((d) => ({ ...d, pinned: !d.pinned }))}
          className={draft.pinned ? 'text-accent' : ''}
        >
          <StarIcon filled={draft.pinned} />
        </IconButton>
        {!trashed && (
          <Button
            variant="ghost"
            onClick={() =>
              structural.mutate({ state: note.state === 'archived' ? 'active' : 'archived' })
            }
          >
            <ArchiveIcon />{' '}
            {note.state === 'archived'
              ? t('notes.unarchive', { defaultValue: 'Unarchive' })
              : t('notes.archive', { defaultValue: 'Archive' })}
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={() => {
            structural.mutate({ trashed: !trashed });
            toList();
          }}
        >
          <TrashIcon />{' '}
          {trashed
            ? t('notes.restore', { defaultValue: 'Restore' })
            : t('notes.trash', { defaultValue: 'Move to trash' })}
        </Button>
        <Button variant="ghost" className="text-danger" onClick={() => void onDeleteForever()}>
          {t('notes.delete', { defaultValue: 'Delete forever' })}
        </Button>
        <Button variant="secondary" onClick={lockCensors} className="ml-1">
          {t('notes.lock', { defaultValue: 'Lock censored text' })}
        </Button>
        <Popover
          align="right"
          trigger={(p) => (
            <button
              type="button"
              {...p}
              className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-alt"
            >
              <DownloadIcon /> {t('notes.export.label', { defaultValue: 'Export' })}
            </button>
          )}
        >
          {(close) => (
            <div className="flex flex-col">
              {FORMATS.map((format) => {
                const label =
                  format === 'md'
                    ? t('notes.export.markdown', { defaultValue: 'Markdown' })
                    : format === 'docx'
                      ? t('notes.export.word', { defaultValue: 'Word' })
                      : t('notes.export.pdf', { defaultValue: 'PDF' });
                return (
                  <a
                    key={format}
                    href={noteExportPath(note.id, format)}
                    download
                    onClick={close}
                    className="rounded-md px-3 py-1.5 text-left hover:bg-surface-alt"
                  >
                    {label}
                  </a>
                );
              })}
            </div>
          )}
        </Popover>
      </div>

      <div className="space-y-4">
        <input
          type="text"
          className={`${inputClass} text-lg font-semibold`}
          aria-label={t('notes.titleLabel', { defaultValue: 'Note title' })}
          placeholder={t('notes.titlePlaceholder', { defaultValue: 'Title' })}
          maxLength={200}
          disabled={gone}
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
        />
        <TagEditor
          tags={draft.tags}
          disabled={gone}
          onChange={(tags) => setDraft((d) => ({ ...d, tags }))}
        />

        <Suspense
          fallback={
            <p className="text-sm text-muted" role="status">
              {t('common.loading', { defaultValue: 'Loading…' })}
            </p>
          }
        >
          <NoteEditor
            key={lockKey}
            markdown={draft.body}
            editable={!gone}
            onChange={(markdown) => setDraft((d) => ({ ...d, body: markdown }))}
            onUploadFile={onUploadFile}
            onOpenInternal={onOpenInternal}
            searchNotes={searchNoteOptions}
            searchTasks={searchTasks}
            onCensor={onCensor}
            onReveal={onReveal}
            onUncensor={onUncensor}
            onProtectedCut={onProtectedCut}
            revealState={revealState}
            onCloseReveal={() => reveal.close()}
          />
        </Suspense>
      </div>

      <LinkedFrom note={note} />
      <LinkedTasks
        note={note}
        onLink={() => setLinkTaskOpen(true)}
        onUnlink={(id) => unlinkTask.mutate(id)}
      />
      <NoteFiles note={note} />

      <ResourcePicker
        open={linkTaskOpen}
        title={t('notes.linkTask', { defaultValue: 'Link a task' })}
        placeholder={t('notes.linkTaskSearch', { defaultValue: 'Search tasks' })}
        search={taskPickerSearch}
        onPick={(id) => linkTask.mutate(id)}
        onClose={() => setLinkTaskOpen(false)}
      />
      {passwordDialog}
    </Page>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-xs font-semibold text-muted">{children}</h2>;
}

function LinkedFrom({ note }: { note: Note }) {
  const { t } = useTranslation();
  if (note.backlinks.length === 0) return null;
  return (
    <section className="mt-6" aria-label={t('notes.linkedFrom', { defaultValue: 'Linked from' })}>
      <SectionTitle>{t('notes.linkedFrom', { defaultValue: 'Linked from' })}</SectionTitle>
      <ul className="flex flex-wrap gap-2 text-sm">
        {note.backlinks.map((back) => (
          <li key={back.id}>
            <Link
              to="/notes/$noteId"
              params={{ noteId: back.id }}
              className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 hover:bg-surface-alt"
            >
              <LinkIcon /> {back.title || t('notes.untitled', { defaultValue: 'Untitled' })}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LinkedTasks({
  note,
  onLink,
  onUnlink,
}: {
  note: Note;
  onLink: () => void;
  onUnlink: (id: string) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <section className="mt-6" aria-label={t('notes.linkedTasks', { defaultValue: 'Linked tasks' })}>
      <div className="mb-2 flex items-center justify-between">
        <SectionTitle>{t('notes.linkedTasks', { defaultValue: 'Linked tasks' })}</SectionTitle>
        <Button variant="ghost" onClick={onLink}>
          + {t('notes.linkTask', { defaultValue: 'Link a task' })}
        </Button>
      </div>
      {note.linkedTasks.length === 0 ? (
        <p className="text-sm text-muted">
          {t('notes.noLinkedTasks', { defaultValue: 'No tasks linked yet.' })}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2 text-sm">
          {note.linkedTasks.map((task) => (
            <li
              key={task.id}
              className="inline-flex items-center gap-2 rounded-md border border-line px-2 py-1"
            >
              <button
                type="button"
                className={`text-left hover:text-accent ${task.completed ? 'text-muted line-through' : ''}`}
                onClick={() => void navigate({ to: '/task/$taskId', params: { taskId: task.id } })}
              >
                <LinkIcon /> {task.content}
              </button>
              <button
                type="button"
                aria-label={t('notes.unlinkTask', { defaultValue: 'Unlink task' })}
                className="text-muted hover:text-danger"
                onClick={() => onUnlink(task.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function NoteFiles({ note }: { note: Note }) {
  const { t } = useTranslation();
  if (note.files.length === 0) return null;
  return (
    <section className="mt-6" aria-label={t('notes.files', { defaultValue: 'Files' })}>
      <SectionTitle>{t('notes.files', { defaultValue: 'Files' })}</SectionTitle>
      <ul className="flex flex-wrap gap-2 text-sm">
        {note.files.map((file) => (
          <li key={file.id}>
            <a
              href={noteFilePath(file.id)}
              download={file.filename}
              className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 hover:bg-surface-alt"
            >
              <DownloadIcon /> {file.filename}
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
