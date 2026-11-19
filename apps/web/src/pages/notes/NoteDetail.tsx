import type { Note, NotePatch } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useBlocker, useNavigate } from '@tanstack/react-router';
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
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
import { useConfirm } from '../../lib/confirm.js';
import { DraftLeaveGuard, installDraftGuards } from '../../lib/note-draft-guards.js';
import {
  censorConflictWarning,
  deleteNote,
  isNoteGoneError,
  linkNoteTask,
  newestNote,
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
  acknowledgePendingCensor,
  censorWithBodyPause,
  checkPendingCensor,
  lockCensored,
  markPendingCensor,
  onCensorLock,
  type CensorPrompts,
} from '../../lib/notes-censor.js';
import type { RevealAnchor, SerializedNoteBody } from '../../components/notes/callbacks.js';
import type { RevealState } from '../../components/notes/RevealOverlay.js';
import {
  RevealController,
  installRevealDismissal,
} from '../../components/notes/reveal-controller.js';
import { useSyncState } from '../../lib/sync.js';
import { useToast } from '../../lib/toasts.js';
import { liveTasks } from '../../lib/views.js';
import { usePasswordPrompt } from './PasswordDialog.js';
import { NoteConflictBanner } from './NoteConflictBanner.js';
import { ResourcePicker, type PickerItem } from './ResourcePicker.js';
import { TagEditor } from './TagEditor.js';

// TipTap, ProseMirror and markdown-it must never be in the entry chunk: the editor is loaded only
// when a note is actually opened.
const NoteEditor = lazy(() => import('../../components/notes/NoteEditor.js'));

const FORMATS: ('md' | 'docx' | 'pdf')[] = ['md', 'docx', 'pdf'];

/** The post-409 refresh outcome: the newest note, a deleted note, or a failed fetch. */
type RemoteRefresh = { status: 'ok'; note: Note } | { status: 'gone' } | { status: 'error' };

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
  /** The latest server version after a 409, while the user chooses which side to keep. */
  const [conflict, setConflict] = useState<Note | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  /** MED: the post-409 GET failed, so the banner offers "Retry fetch" instead of a choice. */
  const [conflictFetchFailed, setConflictFetchFailed] = useState(false);
  /** Bumped on every remote adoption; the editor wipes its undo history at the same time. */
  const [historyResetKey, setHistoryResetKey] = useState(0);
  /** MED (2c): this tab censored text that is not in the saved body. */
  const [censorMaybeUnsaved, setCensorMaybeUnsaved] = useState(false);
  /** Bumped after a user resolves a conflict, so focus moves to the editor after the commit. */
  const [focusTicket, setFocusTicket] = useState(0);
  // Dirty is tracked as state so the Export menu (and the router blocker) re-render when the
  // controller's view of the draft changes; reading the controller during render alone would be
  // one render behind.
  const [dirty, setDirty] = useState(false);
  const [lockKey, setLockKey] = useState(0);
  const [linkTaskOpen, setLinkTaskOpen] = useState(false);
  /** The latest WYSIWYG serialisation and its verifier, used right before a save. */
  const serializedRef = useRef<SerializedNoteBody | null>(null);
  /** The `updatedAt` last seen through the query, so a live refetch is adopted exactly once. */
  const seenRevision = useRef(note.updatedAt);
  /** Identifies the newest conflict refresh; a late answer for an older one is dropped. */
  const conflictRequest = useRef(0);
  /**
   * MED (live sync vs an in-flight save): the newest refetched snapshot that could not be adopted
   * at the time (dirty or saving). It is adopted once the autosave queue is idle, newest first.
   */
  const deferredRemote = useRef<Note | null>(null);

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

  // MED (2c): a marker left by this tab means a censor was produced but its save may never have
  // landed. Check the first server body this page sees; the marker is cleared either way, so the
  // warning is shown at most once.
  const censorChecked = useRef(false);
  useEffect(() => {
    if (censorChecked.current) return;
    censorChecked.current = true;
    let active = true;
    void checkPendingCensor(note.id, note.body).then((outcome) => {
      if (active && outcome === 'missing') setCensorMaybeUnsaved(true);
    });
    return () => {
      active = false;
    };
  }, [note.id, note.body]);

  // --- debounced, diff-only autosave ------------------------------------------------------------
  const [autosave] = useState(
    () =>
      new NoteAutosave(
        {
          delayMs: 800,
          save: async (patch, expectedUpdatedAt) => {
            // Every PATCH names the revision this draft is based on. A 409 stops the queue and
            // reaches the conflict listener below; a write-only token could not answer with the
            // note, but the app always holds notes:read.
            const saved = await patchNote(note.id, { ...patch, expectedUpdatedAt });
            // MED: a live refetch may already have put a newer revision in the cache while this
            // PATCH was in flight. Never replace it with the older answer.
            client.setQueryData<Note>(notesKeys.detail(note.id), (current) =>
              current ? newestNote(current, saved.note) : saved.note,
            );
            // MED (2c): the censor marker is only cleared by an acknowledgement that carries the
            // token; an older save of this tab answering first must not clear it.
            await acknowledgePendingCensor(note.id, saved.note.body);
            void client.invalidateQueries({ queryKey: notesKeys.lists() });
            void client.invalidateQueries({ queryKey: notesKeys.tags() });
            return saved.note.updatedAt;
          },
          onStatus: setStatus,
          onError: (err) => {
            if (isNoteGoneError(err)) {
              // The effect on `gone` stops the queue; the draft stays visible for copying.
              setGone(true);
            } else {
              toast({ tone: 'error', message: noteErrorMessage(err) });
            }
          },
        },
        toNoteDraft(note),
        note.updatedAt,
      ),
  );
  // A 404 stops the queue for good; the draft (and the editor) stay on screen.
  useEffect(() => {
    if (gone) autosave.stop();
  }, [gone, autosave]);

  // H4: verification runs on the autosave debounce/flush/keepalive — never on a keystroke. Only
  // the exact Markdown the editor emitted is verified; a source-view edit has no editor document
  // and is saved as typed. Registered in an effect so the hook reads the latest snapshot ref.
  useEffect(() => {
    autosave.setPreparePatch((patch) => {
      const snapshot = serializedRef.current;
      if (patch.body === undefined || !snapshot || snapshot.markdown !== patch.body) return patch;
      return { ...patch, body: snapshot.verified() };
    });
    return () => autosave.setPreparePatch(undefined);
  }, [autosave]);

  /**
   * GET the newest note, bypassing any fresh cached copy: a revision premise needs the truth. The
   * failure is reported, not swallowed: a conflict the page cannot fetch must stay actionable.
   */
  const refreshRemote = useCallback(async (): Promise<RemoteRefresh> => {
    try {
      const remote = await client.fetchQuery({ ...noteQuery(note.id), staleTime: 0 });
      return { status: 'ok', note: remote };
    } catch (err) {
      if (isNoteGoneError(err)) {
        setGone(true);
        setConflict(null);
        setConflictFetchFailed(false);
        autosave.stop();
        return { status: 'gone' };
      }
      return { status: 'error' };
    }
  }, [autosave, client, note.id]);

  /** Adopt the server note everywhere: draft, controller premise, cache and editor history. */
  const adoptRemote = useCallback(
    (remote: Note) => {
      const next = toNoteDraft(remote);
      autosave.reset(next, remote.updatedAt);
      seenRevision.current = remote.updatedAt;
      conflictRequest.current += 1;
      deferredRemote.current = null;
      // A remote body replaces the draft wholesale, so the editor's Undo history must not lead
      // back to the pre-adoption document (it can hold plaintext another tab censored).
      setHistoryResetKey((key) => key + 1);
      setDraft(next);
      setConflict(null);
      setConflictFetchFailed(false);
      setGone(false);
      setDirty(false);
      setStatus('saved');
      reveal.close();
      client.setQueryData(notesKeys.detail(note.id), remote);
    },
    [autosave, client, note.id, reveal],
  );

  /**
   * After a 409: with nothing local to lose, adopt the remote note silently; otherwise keep the
   * draft (still editable) and let the banner ask which version wins. Never resend on its own.
   * A failed GET keeps the draft and shows "Retry fetch" in the banner rather than guessing.
   */
  const resolveConflict = useCallback(async () => {
    const request = ++conflictRequest.current;
    const result = await refreshRemote();
    if (request !== conflictRequest.current) return;
    if (result.status === 'gone') return; // the deleted-note path is already shown
    if (result.status === 'error') {
      setConflictFetchFailed(true);
      return;
    }
    const remote = result.note;
    setConflictFetchFailed(false);
    client.setQueryData(notesKeys.detail(note.id), remote);
    if (autosave.isDirty()) {
      setConflict(remote);
      return;
    }
    adoptRemote(remote);
  }, [adoptRemote, autosave, client, note.id, refreshRemote]);

  useEffect(() => {
    autosave.setConflictListener(() => void resolveConflict());
    return () => autosave.setConflictListener(undefined);
  }, [autosave, resolveConflict]);
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
  // Live user events invalidate the open note. Adopt the refetched server version only when the
  // draft has nothing unsaved (the editor accepts the external Markdown); otherwise keep the
  // newest refetched snapshot until the queue is idle. A dirty draft whose save then hits 409 goes
  // through the conflict banner instead.
  useEffect(() => {
    if (note.updatedAt === seenRevision.current) return;
    seenRevision.current = note.updatedAt;
    // Never adopt a snapshot at or behind the revision the draft is already based on: the query
    // cache can still hold the pre-save note while the autosave has moved on.
    if (note.updatedAt <= autosave.baseRevision()) return;
    const deferred = deferredRemote.current;
    if (!deferred || note.updatedAt > deferred.updatedAt) deferredRemote.current = note;
    if (gone || conflict || conflictFetchFailed) return;
    if (autosave.isDirty() || autosave.isSaving()) return;
    deferredRemote.current = null;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- adopting a refetched server note
    adoptRemote(note);
  }, [note, gone, conflict, conflictFetchFailed, autosave, adoptRemote]);

  // Queue idle: reconcile with a snapshot that arrived mid-save, newest revision first. A
  // snapshot at or behind the saved premise is stale and dropped.
  useEffect(() => {
    if (status !== 'saved' || dirty || gone || conflict || conflictFetchFailed) return;
    const deferred = deferredRemote.current;
    if (!deferred) return;
    if (deferred.updatedAt <= autosave.baseRevision()) {
      deferredRemote.current = null;
      return;
    }
    if (autosave.isDirty() || autosave.isSaving()) return;
    deferredRemote.current = null;
    adoptRemote(deferred);
  }, [status, dirty, gone, conflict, conflictFetchFailed, autosave, adoptRemote]);

  useEffect(() => () => void autosave.flush(), [autosave]);

  // LOW: after resolving a conflict, typing continues in the editor rather than on the button
  // that just disappeared.
  useEffect(() => {
    if (focusTicket === 0) return;
    document.querySelector<HTMLElement>('.bk-note-prosemirror')?.focus();
  }, [focusTicket]);

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
    async (plaintext: string) => {
      const token = await censorWithBodyPause(autosave, flow, plaintext);
      // MED (2c): record the digest before the editor can hand the token document to the
      // autosave, so a tab closed between the two still leaves something to check next time.
      if (token) await markPendingCensor(note.id, token);
      return token;
    },
    [autosave, flow, note.id],
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
  // H2: the editor reports an abort after a token was produced (stale document / a save form it
  // cannot verify); the page releases the body pause itself. On success the coming token update
  // does that, so the plaintext is never saved in the gap.
  const onCensorSettled = useCallback(
    (outcome: 'ok' | 'cancelled' | 'aborted' | 'unsupported') => {
      if (outcome !== 'ok') autosave.resumeBody();
    },
    [autosave],
  );
  const onSerialized = useCallback((snapshot: SerializedNoteBody) => {
    serializedRef.current = snapshot;
  }, []);
  const onRemoveCensorFailed = useCallback(
    () =>
      toast({
        tone: 'error',
        message: t('notes.censor.removeFailed', {
          defaultValue:
            'That censored text changed while unlocking. Nothing was changed — please try again.',
        }),
      }),
    [toast, t],
  );

  const trashed = note.state === 'trashed';
  const saveLabel = gone
    ? t('notes.gone', { defaultValue: 'This note was deleted — copy your text' })
    : status === 'conflict'
      ? t('notes.conflict.status', {
          defaultValue: 'Not saved — this note changed elsewhere',
        })
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

  /**
   * "Load their version": discard the draft and adopt the newest server note. It requires a
   * successful fetch — a cached conflict snapshot may already be out of date, so there is no
   * fallback to it. A failed fetch leaves the banner in place with "Retry fetch".
   */
  const loadTheirs = useCallback(async () => {
    setConflictBusy(true);
    try {
      const result = await refreshRemote();
      if (result.status === 'gone') return; // the deleted-note path is already shown
      if (result.status === 'error') {
        setConflictFetchFailed(true);
        return;
      }
      setConflictFetchFailed(false);
      adoptRemote(result.note);
      setFocusTicket((ticket) => ticket + 1);
    } finally {
      setConflictBusy(false);
    }
  }, [adoptRemote, refreshRemote]);

  /**
   * "Keep mine": the remote revision becomes the premise, and the whole draft replaces the saved
   * version. The banner only calls this after the censor-safety confirmation when needed.
   */
  const keepMine = useCallback(async () => {
    if (!conflict) return;
    setConflictBusy(true);
    try {
      const kept = await autosave.keepMine(conflict.updatedAt);
      setDirty(autosave.isDirty());
      // A new 409 re-opens the banner through onConflict with a fresher remote note.
      if (kept) {
        setConflict(null);
        setConflictFetchFailed(false);
        setFocusTicket((ticket) => ticket + 1);
      }
    } finally {
      setConflictBusy(false);
    }
  }, [autosave, conflict]);

  /** "Copy mine": put the draft Markdown on the clipboard, then adopt their version. */
  const copyMine = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(draft.body);
    } catch {
      toast({
        tone: 'error',
        message: t('notes.conflict.copyFailed', {
          defaultValue: "Couldn't copy your draft to the clipboard.",
        }),
      });
      return;
    }
    await loadTheirs();
  }, [draft.body, loadTheirs, t, toast]);

  // Censor safety (MED): any differing saved body that looks censor-like means keeping mine could
  // bring back text censored elsewhere. The banner then requires an explicit confirmation.
  const conflictCensorWarning = conflict ? censorConflictWarning(conflict.body, draft.body) : false;

  return (
    <Page wide>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link to="/notes" className="text-sm text-muted hover:text-accent">
          ← {t('notes.back', { defaultValue: 'Back to notes' })}
        </Link>
        <span className="ml-auto text-xs text-muted" aria-live="polite" role="status">
          {saveLabel}
        </span>
        {status === 'error' && !gone && !conflict && (
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

      {censorMaybeUnsaved && (
        <Alert tone="warning">
          {t('notes.censor.maybeUnsaved', {
            defaultValue: 'Your last censor may not have been saved — check this note',
          })}
        </Alert>
      )}

      {(conflict || conflictFetchFailed) && (
        <NoteConflictBanner
          censorWarning={conflictCensorWarning}
          busy={conflictBusy}
          fetchFailed={conflictFetchFailed}
          remoteRevision={conflict?.updatedAt ?? null}
          onLoadTheirs={() => void loadTheirs()}
          onRetryFetch={() => void resolveConflict()}
          onKeepMine={() => void keepMine()}
          onCopyMine={() => void copyMine()}
        />
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
            historyResetKey={historyResetKey}
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
            onCensorSettled={onCensorSettled}
            onRemoveCensorFailed={onRemoveCensorFailed}
            onSerialized={onSerialized}
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
            {status === 'conflict' ? (
              // A navigation-triggered 409 has its own resolution path: close this dialog so the
              // banner (Load theirs / Keep mine) is what the user acts on, not a blind retry.
              <Button onClick={() => blocker.reset()}>
                {t('notes.conflict.resolve', { defaultValue: 'Resolve conflict' })}
              </Button>
            ) : (
              <Button onClick={() => void retrySave()} busy={retrying}>
                {t('common.retry', { defaultValue: 'Try again' })}
              </Button>
            )}
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
          {note.linkedTasks.map((task) => {
            // P5: the server reports where each link comes from. A body link is re-derived on
            // every save, so it cannot be unlinked here; only a manual link can.
            const inBody = task.sources.includes('body');
            const manual = task.sources.includes('manual');
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
                {inBody && (
                  <span className="text-xs text-muted">
                    {t('notes.linkedInBody', { defaultValue: 'Linked in the note text' })} —{' '}
                    {t('notes.unlinkBodyHint', {
                      defaultValue: 'remove the link from the note text to unlink.',
                    })}
                  </span>
                )}
                {manual && (
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
