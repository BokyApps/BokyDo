import type { Note, NotePatch } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Page } from '../../components/ViewHeader.js';
import {
  Alert,
  Button,
  Dialog,
  IconButton,
  Popover,
  Spinner,
  inputClass,
} from '../../components/ui.js';
import {
  ArchiveIcon,
  DownloadIcon,
  LinkIcon,
  StarIcon,
  TrashIcon,
} from '../../components/icons.js';
import { ApiError } from '../../lib/api.js';
import { useConfirm } from '../../lib/confirm.js';
import { DraftLeaveGuard, installDraftGuards } from '../../lib/note-draft-guards.js';
import {
  bodyLinksTask,
  deleteNote,
  isNoteGoneError,
  linkNoteTask,
  noteErrorMessage,
  noteExportAvailability,
  noteFilePath,
  noteLoadPhase,
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
  censorWithBodyPause,
  lockCensored,
  onCensorLock,
  type CensorPrompts,
} from '../../lib/notes-censor.js';
import type { RevealAnchor } from '../../components/notes/callbacks.js';
import type { RevealState } from '../../components/notes/RevealOverlay.js';
import {
  RevealController,
  installRevealDismissal,
} from '../../components/notes/reveal-controller.js';
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

  // A background refetch error must not unmount the editor and lose the draft: only a first load
  // without data shows the error page (review: "a background refetch error must not unmount").
  const phase = noteLoadPhase(query);
  if (phase === 'ready' && query.data) {
    // Keyed by id so switching notes remounts with a fresh draft, while a background refetch of the
    // same note only refreshes read-only data (backlinks, files, linked tasks) without clobbering it.
    return <NoteDetailInner key={query.data.id} note={query.data} />;
  }
  if (phase === 'loading') return <Spinner />;
  if (phase === 'error') {
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
  return null;
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
  // Review fix: a pending or visible reveal is cancelled when the window loses focus or the page
  // is hidden, so plaintext cannot survive in a background tab.
  useEffect(() => installRevealDismissal(reveal), [reveal]);
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
            if (isNoteGoneError(err)) {
              // The effect on `gone` stops the queue; the draft stays visible for copying.
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
  // A 404 stops the queue for good; the draft (and the editor) stay on screen.
  useEffect(() => {
    if (gone) autosave.stop();
  }, [gone, autosave]);
  // Dirty is tracked as state so the Export menu (and the router blocker) re-render when the
  // controller's view of the draft changes; reading the controller during render alone would be
  // one render behind.
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (gone) return;
    autosave.update(draft);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors the controller's state
    setDirty(autosave.isDirty());
  }, [draft, autosave, gone]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mirrors the controller's state
    setDirty(autosave.isDirty());
  }, [status, autosave]);
  useEffect(() => () => void autosave.flush(), [autosave]);

  // Navigation: flush first, block only when saving failed (Retry / explicit discard below).
  const [guard] = useState(() => new DraftLeaveGuard(autosave));
  const blocker = useBlocker({
    shouldBlockFn: () => guard.shouldBlock(),
    withResolver: true,
    // The tab-close prompt is owned by installDraftGuards; one prompt is enough.
    enableBeforeUnload: false,
  });
  const [retrying, setRetrying] = useState(false);
  useEffect(() => installDraftGuards(autosave, note.id), [autosave, note.id]);

  // A lock clears the key cache, closes any reveal overlay, discards pending unlocks and
  // password inputs. Lock/sign-out/pagehide/hidden all reach this listener; only the explicit
  // Lock and pagehide remount the editor (a tab switch must not lose the cursor).
  useEffect(
    () =>
      onCensorLock((reason) => {
        reveal.close();
        if (reason === 'manual' || reason === 'pagehide' || reason === 'signout') {
          setLockKey((k) => k + 1);
        }
      }),
    [reveal],
  );

  // Note change: this instance is keyed by note id, so unmounting means "another note (or none)".
  useEffect(() => () => lockCensored('note-change'), []);

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
      // Deleted on purpose: stop the queue so the navigation is not blocked by a 404 save.
      guard.discard();
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
  // Review fix (P1): PAUSE the body autosave synchronously, before the password prompt opens and
  // before any await, so the plaintext draft cannot be PATCHed behind the dialog. The token
  // revision that follows a successful censor is saved immediately (no debounce window).
  const onCensor = useCallback(
    (plaintext: string) => censorWithBodyPause(autosave, flow, plaintext),
    [autosave, flow],
  );
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
    ? t('notes.gone', { defaultValue: 'This note was deleted — copy your text' })
    : status === 'saving'
      ? t('notes.saving', { defaultValue: 'Saving…' })
      : status === 'error'
        ? t('notes.saveError', { defaultValue: 'Save failed — retrying on next edit' })
        : t('notes.saved', { defaultValue: 'Saved' });
  const retrySave = async () => {
    setRetrying(true);
    try {
      const saved = await autosave.flush();
      // A flush is silent (no status callback), so mirror the result for the Export menu here.
      setDirty(autosave.isDirty());
      if (saved && blocker.status === 'blocked') blocker.proceed();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Page wide>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link to="/notes" className="text-sm text-muted hover:text-accent">
          ← {t('notes.back', { defaultValue: 'Back to notes' })}
        </Link>
        <span className="ml-auto text-xs text-muted" aria-live="polite" role="status">
          {saveLabel}
        </span>
        {status === 'error' && !gone && (
          <Button variant="secondary" onClick={() => void retrySave()} busy={retrying}>
            {t('notes.retrySave', { defaultValue: 'Retry save' })}
          </Button>
        )}
      </div>

      {gone && (
        <Alert>
          {t('notes.gone', { defaultValue: 'This note was deleted — copy your text' })}{' '}
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
        <Button variant="secondary" onClick={() => lockCensored('manual')} className="ml-1">
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
                // Review fix (P1): never export stale Markdown. While the controller is dirty or
                // saving there is no href at all and the item is marked unavailable; a completed
                // save re-renders this menu with the working links.
                const availability = noteExportAvailability(note.id, format, {
                  dirty,
                  saving: status === 'saving',
                });
                return availability.href ? (
                  <a
                    key={format}
                    href={availability.href}
                    download
                    onClick={close}
                    className="rounded-md px-3 py-1.5 text-left hover:bg-surface-alt"
                  >
                    {label}
                  </a>
                ) : (
                  <span
                    key={format}
                    aria-disabled="true"
                    className="cursor-not-allowed rounded-md px-3 py-1.5 text-left text-muted"
                  >
                    {label}
                  </span>
                );
              })}
              {dirty || status === 'saving' ? (
                <p className="px-3 pt-1 text-xs text-muted" role="status">
                  {t('notes.export.waitForSave', {
                    defaultValue: 'Waiting for the note to finish saving…',
                  })}
                </p>
              ) : null}
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
        body={draft.body}
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

      {blocker.status === 'blocked' && (
        <Dialog
          open
          onClose={() => blocker.reset()}
          title={t('notes.leaveTitle', { defaultValue: 'Your latest changes are not saved' })}
        >
          <p className="text-sm text-muted">
            {t('notes.leaveMessage', {
              defaultValue:
                "The note couldn't be saved. Retry, or discard your changes and leave this note.",
            })}
          </p>
          <div className="mt-4 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => blocker.reset()}>
              {t('notes.leaveStay', { defaultValue: 'Stay on this note' })}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                guard.discard();
                blocker.proceed();
              }}
            >
              {t('notes.leaveDiscard', { defaultValue: 'Discard changes and leave' })}
            </Button>
            <Button onClick={() => void retrySave()} busy={retrying}>
              {t('common.retry', { defaultValue: 'Try again' })}
            </Button>
          </div>
        </Dialog>
      )}
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
  body,
  onLink,
  onUnlink,
}: {
  note: Note;
  /** The live draft body: provenance is derived from the text, not from a stale snapshot. */
  body: string;
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
          {note.linkedTasks.map((task) => {
            // P5: Unlink only removes a MANUAL link; a body link would be re-derived on the next
            // save, so the no-op is replaced by telling the reader where the link lives.
            const inBody = bodyLinksTask(body, task.id);
            return (
              <li
                key={task.id}
                className="inline-flex items-center gap-2 rounded-md border border-line px-2 py-1"
              >
                <button
                  type="button"
                  className={`text-left hover:text-accent ${task.completed ? 'text-muted line-through' : ''}`}
                  onClick={() =>
                    void navigate({ to: '/task/$taskId', params: { taskId: task.id } })
                  }
                >
                  <LinkIcon /> {task.content}
                </button>
                {inBody ? (
                  <span className="text-xs text-muted">
                    {t('notes.linkedInBody', { defaultValue: 'Linked in the note text' })} —{' '}
                    {t('notes.unlinkBodyHint', {
                      defaultValue: 'remove the link from the note text to unlink.',
                    })}
                  </span>
                ) : (
                  <>
                    <span className="text-xs text-muted">
                      {t('notes.linkedManual', { defaultValue: 'Linked manually' })}
                    </span>
                    <button
                      type="button"
                      aria-label={t('notes.unlinkTask', { defaultValue: 'Unlink task' })}
                      className="text-muted hover:text-danger"
                      onClick={() => onUnlink(task.id)}
                    >
                      ×
                    </button>
                  </>
                )}
              </li>
            );
          })}
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
