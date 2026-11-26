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
  CollapseIcon,
  DownloadIcon,
  ExpandIcon,
  LinkIcon,
  StarIcon,
  TrashIcon,
} from '../../components/icons.js';
import { useConfirm } from '../../lib/confirm.js';
import { localeTag } from '../../lib/locale.js';
import { DraftLeaveGuard, installDraftGuards } from '../../lib/note-draft-guards.js';
import { readNoteFullScreen, saveNoteFullScreen } from '../../lib/note-layout.js';
import {
  censorConflictWarning,
  deleteNote,
  fetchNote,
  isNoteGoneError,
  CENSORING_ENABLED,
  keepMineAllowed,
  linkNoteTask,
  newestNote,
  noteErrorMessage,
  noteExportAvailability,
  noteFilePath,
  noteFocusSurface,
  noteLoadPhase,
  noteQuery,
  notesKeys,
  patchNote,
  prepareNoteSavePatch,
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
  checkPendingCensor,
  lockCensored,
  markPendingCensor,
  onCensorLock,
  type CensorPrompts,
} from '../../lib/notes-censor.js';
import type { RevealAnchor, SerializedNoteBody } from '../../components/notes/callbacks.js';
import type { CensorOutcome } from '../../components/notes/censor-command.js';
import type { RevealState } from '../../components/notes/RevealOverlay.js';
import {
  RevealController,
  installRevealDismissal,
} from '../../components/notes/reveal-controller.js';
import { useSyncState } from '../../lib/sync.js';
import { useToast } from '../../lib/toasts.js';
import { liveTasks } from '../../lib/views.js';
import { usePasswordPrompt } from './PasswordDialog.js';
import { NoteCardTitlebar } from './NoteCardTitlebar.js';
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

/**
 * A note edited in place on its card. It is the same editing session as the full page (autosave,
 * conflicts, live updates, the leave guard), laid out for a small resizable card. Until the full
 * note has loaded the card shows `fallback` (the list's formatted preview).
 */
export function NoteCardEditor({
  noteId,
  fallback,
  autoFocus = false,
}: {
  noteId: string;
  fallback: ReactNode;
  autoFocus?: boolean;
}) {
  const query = useQuery(noteQuery(noteId));
  const phase = noteLoadPhase(query);
  if (phase === 'ready' && query.data) {
    return (
      <NoteDetailInner key={query.data.id} note={query.data} variant="card" autoFocus={autoFocus} />
    );
  }
  return <>{fallback}</>;
}

function NoteDetailInner({
  note,
  variant = 'page',
  autoFocus = false,
}: {
  note: Note;
  variant?: 'page' | 'card';
  autoFocus?: boolean;
}) {
  const { t } = useTranslation();
  const card = variant === 'card';
  const [fullScreen, setFullScreen] = useState(readNoteFullScreen);
  /**
   * Full screen is entered from a card or from the page, and minimising always returns to the
   * board, where the note is back on its card (leaving it on the normal page looked like nothing
   * happened).
   */
  const toggleFullScreen = () => {
    if (fullScreen) {
      saveNoteFullScreen(false);
      void navigate({ to: '/notes' });
      return;
    }
    saveNoteFullScreen(true);
    setFullScreen(true);
  };
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
  /**
   * Censoring is its own save: this freezes every field from before the password prompt until the
   * one token PATCH resolves. A cancel unfreezes with the pre-censor draft unchanged.
   */
  const [censorFrozen, setCensorFrozen] = useState(false);
  const [censorSaveFailed, setCensorSaveFailed] = useState(false);
  const [censorRetrying, setCensorRetrying] = useState(false);
  /** The verifier refused the body: it stays in the draft, is never sent, and is shown as an error. */
  const [unsafeBody, setUnsafeBody] = useState(false);
  const [lockKey, setLockKey] = useState(0);
  const [linkTaskOpen, setLinkTaskOpen] = useState(false);
  /** The latest WYSIWYG serialisation and its verifier, used right before a save. */
  const serializedRef = useRef<SerializedNoteBody | null>(null);
  /**
   * The censor phase. Only `prompt` may be cancelled by a lock / hidden tab / pagehide; once the
   * token PATCH is pending or has failed the freeze must hold, so a tab close sends no keepalive
   * with an unacknowledged body.
   */
  const censorPhase = useRef<'idle' | 'prompt' | 'saving' | 'conflict' | 'failed'>('idle');
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
  // landed. Check a FRESH server body (never cached data) the first time this page sees the note;
  // the marker is cleared either way, so the warning is shown at most once. A failed GET leaves
  // the marker for the next open instead of guessing from a cached body.
  const censorChecked = useRef(false);
  useEffect(() => {
    if (censorChecked.current) return;
    censorChecked.current = true;
    // A card skips the extra GET while censoring is off: no marker can have been written.
    if (card && !CENSORING_ENABLED) return;
    let active = true;
    void (async () => {
      try {
        const fresh = await fetchNote(note.id);
        const outcome = await checkPendingCensor(note.id, fresh.body);
        if (active && outcome === 'missing') setCensorMaybeUnsaved(true);
      } catch {
        // The marker survives an unavailable server; compare again on the next open.
      }
    })();
    return () => {
      active = false;
    };
  }, [note.id, card]);

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

  // Verification runs on every body save — debounce, flush AND the unmount flush — never on a
  // keystroke. Only the exact Markdown the editor emitted is verified; a source-view edit has no
  // matching editor snapshot and is saved as typed. A verifier mismatch drops the body and raises
  // the explicit error instead of saving a guessed form. The hook is deliberately never
  // unregistered: React removes effect cleanups before the unmount flush runs.
  useEffect(() => {
    autosave.setPreparePatch((patch) => {
      const prepared = prepareNoteSavePatch(patch, serializedRef.current);
      if (patch.body !== undefined) setUnsafeBody(prepared.bodyUnsafe);
      return prepared;
    });
  }, [autosave]);

  /**
   * Freeze every field synchronously, before the password prompt opens. Nothing is debounced,
   * flushed or keepalive'd until the censor is cancelled (unfreeze, pre-censor draft intact) or
   * its one direct token PATCH succeeds.
   */
  const freezeForCensor = useCallback(() => {
    censorPhase.current = 'prompt';
    autosave.freeze();
    setCensorFrozen(true);
    setCensorSaveFailed(false);
    reveal.close();
  }, [autosave, reveal]);

  const cancelCensor = useCallback(() => {
    censorPhase.current = 'idle';
    autosave.unfreeze();
    setCensorFrozen(false);
    setCensorSaveFailed(false);
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
      setUnsafeBody(false);
      censorPhase.current = 'idle';
      setCensorFrozen(false);
      setCensorSaveFailed(false);
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
    if (!autosave.isDirty()) {
      setUnsafeBody(false);
    }
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

  // Note change / unmount: cancel an open censor prompt (the pre-censor draft is then normal
  // autosave material) and make the final flush while the verifier is still attached. A pending or
  // failed token save stays frozen; its draft is the token body and no keepalive may race it.
  useEffect(
    () => () => {
      if (censorPhase.current === 'prompt') {
        censorPhase.current = 'idle';
        autosave.unfreeze();
      }
      void autosave.flush();
      lockCensored('note-change');
    },
    [autosave],
  );

  // LOW: after resolving a conflict, typing continues on whichever surface is visible — the
  // Markdown source textarea when that view is open, otherwise the WYSIWYG editor.
  useEffect(() => {
    if (focusTicket === 0) return;
    noteFocusSurface(document)?.focus();
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
        // A lock while the password prompt is open cancels the censor: the note unfreezes and
        // normal autosave resumes with the pre-censor draft. Once the token PATCH is pending or
        // failed, the freeze holds (a closed tab must not send an unacknowledged censor body).
        if (censorPhase.current === 'prompt') cancelCensor();
        if (reason === 'manual' || reason === 'pagehide' || reason === 'signout') {
          setLockKey((k) => k + 1);
        }
      }),
    [cancelCensor, reveal],
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
  // Censoring is its own save. Freeze ALL fields synchronously, before the password prompt and
  // before any await, so nothing can be debounced, flushed or keepalive'd behind the dialog. The
  // editor applies the verified token document and hands it to onCensoredBody, which sends the one
  // direct PATCH and only then unfreezes (on success).
  const onCensor = useCallback(
    async (plaintext: string) => {
      if (censorPhase.current !== 'idle') return null;
      freezeForCensor();
      try {
        return await flow.onCensor(plaintext);
      } catch (err) {
        cancelCensor();
        throw err;
      }
    },
    [cancelCensor, flow, freezeForCensor],
  );
  /**
   * The one token PATCH. The sessionStorage marker (note id + token digest) is written first, so a
   * tab closed while the request is in flight has something to check on the next open. Success
   * releases the freeze; a 409 shows the conflict banner; a network error keeps the freeze and
   * offers Retry, which resends this exact body with this exact premise.
   */
  const onCensoredBody = useCallback(
    async (body: string, token: string) => {
      // A lock may have cancelled the prompt in the same turn that encryption finished. The token
      // already exists and the editor has applied it, so re-freeze and finish its save instead of
      // stranding a read-only editor with an unsaved token document.
      if (censorPhase.current === 'idle') {
        censorPhase.current = 'prompt';
        autosave.freeze();
        setCensorFrozen(true);
      }
      if (censorPhase.current !== 'prompt') return 'error' as const;
      censorPhase.current = 'saving';
      setCensorSaveFailed(false);
      setDraft((d) => (d.body === body ? d : { ...d, body }));
      await markPendingCensor(note.id, token);
      const result = await autosave.saveCensoredBody(body);
      if (result === 'saved') {
        censorPhase.current = 'idle';
        setCensorFrozen(false);
        setCensorSaveFailed(false);
        // Resume the fields that changed before the freeze (title, tags, pin) now the body is safe.
        autosave.unfreeze();
        return result;
      }
      if (result === 'conflict') {
        censorPhase.current = 'conflict';
        setCensorFrozen(true);
        setCensorSaveFailed(false);
        return result;
      }
      censorPhase.current = 'failed';
      setCensorFrozen(true);
      setCensorSaveFailed(true);
      return result;
    },
    [autosave, note.id],
  );
  const retryCensorSave = useCallback(async () => {
    if (censorPhase.current !== 'failed') return;
    setCensorRetrying(true);
    try {
      const result = await autosave.retryCensoredSave();
      if (result === 'saved') {
        censorPhase.current = 'idle';
        setCensorFrozen(false);
        setCensorSaveFailed(false);
        autosave.unfreeze();
      } else if (result === 'conflict') {
        censorPhase.current = 'conflict';
        setCensorSaveFailed(false);
      } else {
        setCensorSaveFailed(true);
      }
    } finally {
      setCensorRetrying(false);
    }
  }, [autosave]);
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
  /**
   * The editor's own verdict. Cancelled / aborted / unsafe / unsupported attempts during the
   * prompt release the freeze with the pre-censor draft. `ok` means the direct save already
   * succeeded; `conflict` and `save-failed` deliberately keep the freeze.
   */
  const onCensorSettled = useCallback(
    (outcome: CensorOutcome) => {
      if (outcome === 'ok' || outcome === 'conflict' || outcome === 'save-failed') return;
      if (censorPhase.current === 'prompt') cancelCensor();
    },
    [cancelCensor],
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
    : censorSaveFailed
      ? t('notes.censor.saveFailed', { defaultValue: 'Censor not saved — Retry' })
      : status === 'conflict'
        ? t('notes.conflict.status', {
            defaultValue: 'Not saved — this note changed elsewhere',
          })
        : status === 'unsafe' || unsafeBody
          ? t('notes.unsafeSave', {
              defaultValue:
                "This note couldn't be saved safely — please copy your text and report it",
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
   * version. It requires a successfully fetched remote revision, and the censor-safety check runs
   * HERE (not only in the banner): when the saved body looks censored, only a confirmation bound
   * to that exact revision may pass.
   */
  const keepMine = useCallback(
    async (confirmedRevision: string | null = null) => {
      if (!conflict) return;
      if (!keepMineAllowed(conflict, draft.body, confirmedRevision)) return;
      setConflictBusy(true);
      try {
        const kept = await autosave.keepMine(conflict.updatedAt);
        setDirty(autosave.isDirty());
        // A new 409 re-opens the banner through onConflict with a fresher remote note.
        if (kept) {
          setConflict(null);
          setConflictFetchFailed(false);
          censorPhase.current = 'idle';
          setCensorFrozen(false);
          setCensorSaveFailed(false);
          setFocusTicket((ticket) => ticket + 1);
        }
      } finally {
        setConflictBusy(false);
      }
    },
    [autosave, conflict, draft.body],
  );

  // Censor safety (MED): any differing saved body that looks censor-like means keeping mine could
  // bring back text censored elsewhere. The banner then requires an explicit confirmation.
  const conflictCensorWarning = conflict ? censorConflictWarning(conflict.body, draft.body) : false;

  const editor = (
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
        editable={!gone && !censorFrozen}
        onChange={(markdown) => setDraft((d) => ({ ...d, body: markdown }))}
        onUploadFile={onUploadFile}
        onOpenInternal={onOpenInternal}
        searchNotes={searchNoteOptions}
        searchTasks={searchTasks}
        // Censoring ships as its own follow-up: without these callbacks the editor offers no
        // Censor, Reveal or Remove action and existing tokens show as █████ only.
        {...(CENSORING_ENABLED ? { onCensor, onCensoredBody, onReveal, onUncensor } : {})}
        onProtectedCut={onProtectedCut}
        onCensorSettled={onCensorSettled}
        onRemoveCensorFailed={onRemoveCensorFailed}
        onSerialized={onSerialized}
        revealState={revealState}
        onCloseReveal={() => reveal.close()}
      />
    </Suspense>
  );

  const leaveDialog = blocker.status === 'blocked' && (
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
  );

  if (card) {
    const busy = gone || conflict || conflictFetchFailed || unsafeBody || status !== 'saved';
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <NoteCardTitlebar
          title={draft.title}
          startRenaming={autoFocus}
          onRename={
            gone || censorFrozen ? undefined : (title) => setDraft((d) => ({ ...d, title }))
          }
          actions={
            <>
              <IconButton
                label={
                  draft.pinned
                    ? t('notes.unpin', { defaultValue: 'Unpin' })
                    : t('notes.pin', { defaultValue: 'Pin' })
                }
                aria-pressed={draft.pinned}
                onClick={() => setDraft((d) => ({ ...d, pinned: !d.pinned }))}
                className={draft.pinned ? 'text-accent' : 'bk-note-card-hover'}
              >
                <StarIcon filled={draft.pinned} />
              </IconButton>
              <IconButton
                label={t('notes.openFullScreen', { defaultValue: 'Open full screen' })}
                className="bk-note-card-hover"
                onClick={() => {
                  saveNoteFullScreen(true);
                  void navigate({ to: '/notes/$noteId', params: { noteId: note.id } });
                }}
              >
                <ExpandIcon />
              </IconButton>
            </>
          }
        />
        {(gone || unsafeBody || conflict || conflictFetchFailed) && (
          <div className="px-3 pt-1 text-xs">
            {gone || unsafeBody ? (
              <p className="text-danger" role="alert">
                {saveLabel}
              </p>
            ) : (
              <NoteConflictBanner
                censorWarning={conflictCensorWarning}
                busy={conflictBusy}
                fetchFailed={conflictFetchFailed}
                remoteRevision={conflict?.updatedAt ?? null}
                onLoadTheirs={() => void loadTheirs()}
                onRetryFetch={() => void resolveConflict()}
                onKeepMine={(confirmedRevision) => void keepMine(confirmedRevision)}
              />
            )}
          </div>
        )}
        <div className="bk-note-card-body min-h-0 flex-1 overflow-auto px-3">{editor}</div>
        <div className="flex flex-wrap items-end justify-between gap-2 px-3 pb-2 pt-1">
          <div className="flex min-w-0 flex-wrap gap-1">
            {draft.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full bg-surface-alt px-2 py-0.5 text-xs text-muted"
              >
                #{tag}
              </span>
            ))}
          </div>
          <span className="ml-auto text-xs text-muted" aria-live="polite" role="status">
            {busy ? (
              saveLabel
            ) : (
              <time dateTime={note.updatedAt}>
                {new Date(note.updatedAt).toLocaleString(localeTag())}
              </time>
            )}
          </span>
          {status === 'error' && !gone && !conflict && !censorFrozen && (
            <Button variant="secondary" onClick={() => void retrySave()} busy={retrying}>
              {t('notes.retrySave', { defaultValue: 'Retry save' })}
            </Button>
          )}
        </div>
        {passwordDialog}
        {leaveDialog}
      </div>
    );
  }

  const page = (
    <Page wide>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Link to="/notes" className="text-sm text-muted hover:text-accent">
          ← {t('notes.back', { defaultValue: 'Back to notes' })}
        </Link>
        <span className="ml-auto text-xs text-muted" aria-live="polite" role="status">
          {saveLabel}
        </span>
        <IconButton
          label={
            fullScreen
              ? t('notes.minimise', { defaultValue: 'Minimise to card' })
              : t('notes.fullScreen', { defaultValue: 'Full screen' })
          }
          aria-pressed={fullScreen}
          onClick={toggleFullScreen}
        >
          {fullScreen ? <CollapseIcon /> : <ExpandIcon />}
        </IconButton>
        {status === 'error' && !gone && !conflict && !censorFrozen && (
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

      {unsafeBody && (
        <Alert>
          {t('notes.unsafeSave', {
            defaultValue:
              "This note couldn't be saved safely — please copy your text and report it",
          })}
        </Alert>
      )}

      {censorMaybeUnsaved && (
        <Alert tone="warning">
          {t('notes.censor.maybeUnsaved', {
            defaultValue: 'Your last censor may not have been saved — check this note',
          })}
        </Alert>
      )}

      {censorSaveFailed && (
        <Alert tone="warning">
          {t('notes.censor.saveFailed', { defaultValue: 'Censor not saved — Retry' })}{' '}
          <Button variant="secondary" onClick={() => void retryCensorSave()} busy={censorRetrying}>
            {t('notes.retrySave', { defaultValue: 'Retry save' })}
          </Button>
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
          onKeepMine={(confirmedRevision) => void keepMine(confirmedRevision)}
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
        {CENSORING_ENABLED && (
          <Button variant="secondary" onClick={() => lockCensored('manual')} className="ml-1">
            {t('notes.lock', { defaultValue: 'Lock censored text' })}
          </Button>
        )}
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
                  frozen: censorFrozen,
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
              {dirty || status === 'saving' || censorFrozen ? (
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
          disabled={gone || censorFrozen}
          value={draft.title}
          onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
        />
        <TagEditor
          tags={draft.tags}
          disabled={gone || censorFrozen}
          onChange={(tags) => setDraft((d) => ({ ...d, tags }))}
        />

        {editor}
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

      {leaveDialog}
    </Page>
  );

  if (!fullScreen) return page;
  return <div className="fixed inset-0 z-40 overflow-auto bg-bg">{page}</div>;
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
