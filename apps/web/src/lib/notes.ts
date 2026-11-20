import type {
  Note,
  NoteCreateRequest,
  NoteListResponse,
  NotePatch,
  NoteState,
  NoteTagsResponse,
  NoteTaskSummary,
  Task,
} from '@bokydo/shared';
import { queryOptions } from '@tanstack/react-query';
import { api, ApiError, uploadFile } from './api.js';
import { errorMessage } from './messages.js';

/**
 * Notes (ADR 0025) wire helpers and pure logic for the web app. No React and no TipTap here, so
 * this module stays in the entry bundle and can be imported by the page, the task panel and the
 * live-sync watcher without pulling the editor into it.
 */

// ---------------------------------------------------------------------------------------------
// Query keys and paths
// ---------------------------------------------------------------------------------------------

export const notesKeys = {
  all: ['notes'] as const,
  lists: () => ['notes', 'list'] as const,
  list: (params: NoteListParams) => ['notes', 'list', params] as const,
  detail: (id: string) => ['notes', 'detail', id] as const,
  tags: () => ['notes', 'tags'] as const,
  taskNotes: (taskId: string) => ['notes', 'task', taskId] as const,
};

export interface NoteListParams {
  q: string;
  tag: string | null;
  state: NoteState;
}

const enc = encodeURIComponent;
export const pathFor = (id: string) => `/api/v1/notes/${enc(id)}`;

export function noteListPath(params: NoteListParams, cursor?: string | null): string {
  const query = new URLSearchParams();
  query.set('state', params.state);
  query.set('limit', '100');
  if (params.q) query.set('q', params.q);
  if (params.tag) query.set('tag', params.tag);
  if (cursor) query.set('cursor', cursor);
  return `/api/v1/notes?${query.toString()}`;
}

export const noteTagsPath = '/api/v1/notes/tags';
export const taskNotesPath = (taskId: string) => `/api/v1/tasks/${enc(taskId)}/notes`;
export const noteFilePath = (id: string) => `/api/v1/note-files/${enc(id)}`;
export const noteExportPath = (id: string, format: 'md' | 'docx' | 'pdf') =>
  `${pathFor(id)}/export?format=${format}`;
export const noteTaskPath = (noteId: string, taskId: string) =>
  `${pathFor(noteId)}/tasks/${enc(taskId)}`;

// ---------------------------------------------------------------------------------------------
// Queries and mutations (all JSON except the raw file upload)
// ---------------------------------------------------------------------------------------------

export function fetchNotePage(
  params: NoteListParams,
  cursor: string | null,
): Promise<NoteListResponse> {
  return api<NoteListResponse>('GET', noteListPath(params, cursor));
}

export const noteQuery = (id: string) =>
  queryOptions({
    queryKey: notesKeys.detail(id),
    queryFn: async (): Promise<Note> => (await api<{ note: Note }>('GET', pathFor(id))).note,
  });

/**
 * A GET that bypasses every cache. The censor marker must be checked against the server's actual
 * body: a cached copy may predate the censor save (or a save elsewhere) and would be the wrong
 * answer exactly when it matters.
 */
export async function fetchNote(id: string): Promise<Note> {
  return (await api<{ note: Note }>('GET', pathFor(id))).note;
}

export const noteTagsQuery = queryOptions({
  queryKey: notesKeys.tags(),
  queryFn: () => api<NoteTagsResponse>('GET', noteTagsPath),
});

export const taskNotesQuery = (taskId: string) =>
  queryOptions({
    queryKey: notesKeys.taskNotes(taskId),
    queryFn: () => api<{ notes: NoteTaskSummary[] }>('GET', taskNotesPath(taskId)),
  });

export function createNote(body: NoteCreateRequest): Promise<{ note: Note }> {
  return api<{ note: Note }>('POST', '/api/v1/notes', body);
}

/** A PATCH answers the stored note, including the new revision every save must move forward. */
export function patchNote(id: string, patch: NotePatch): Promise<{ note: Note }> {
  return api<{ note: Note }>('PATCH', pathFor(id), patch);
}

export function deleteNote(id: string): Promise<null> {
  return api<null>('DELETE', pathFor(id));
}

export function linkNoteTask(noteId: string, taskId: string): Promise<null> {
  return api<null>('PUT', noteTaskPath(noteId, taskId));
}

export function unlinkNoteTask(noteId: string, taskId: string): Promise<null> {
  return api<null>('DELETE', noteTaskPath(noteId, taskId));
}

export interface UploadedNoteFile {
  id: string;
  filename: string;
  contentType: string;
  size: number;
}

export function uploadNoteFile(noteId: string, file: File): Promise<UploadedNoteFile> {
  return uploadFile<UploadedNoteFile>(`${pathFor(noteId)}/files`, file);
}

/** Notes for the editor's link picker and the task panel's "Link note" picker. */
export function searchNoteOptions(q: string): Promise<{ id: string; title: string }[]> {
  const query = new URLSearchParams({ state: 'active', limit: '20' });
  if (q.trim()) query.set('q', q.trim());
  return api<NoteListResponse>('GET', `/api/v1/notes?${query.toString()}`).then((r) =>
    r.notes.map((n) => ({ id: n.id, title: n.title || 'Untitled' })),
  );
}

/**
 * Client-side task search for the editor picker and "Link task", matching the app's instant
 * search (Ctrl/Cmd+K): open tasks whose content or description contains the query, newest first.
 */
export function searchLocalTasks(
  tasks: readonly Task[],
  q: string,
): { id: string; content: string }[] {
  const needle = q.trim().toLowerCase();
  return tasks
    .filter(
      (task) =>
        !task.isCompleted &&
        (!needle ||
          task.content.toLowerCase().includes(needle) ||
          task.description.toLowerCase().includes(needle)),
    )
    .slice(0, 20)
    .map((task) => ({ id: task.id, content: task.content }));
}

// ---------------------------------------------------------------------------------------------
// Tags: normalise exactly like the server (packages/shared/src/notes.ts), so the draft never
// drifts into an endless re-save after the server lower-cases a tag.
// ---------------------------------------------------------------------------------------------

export const NOTE_TAG_MAX_LENGTH = 50;
export const NOTE_TAGS_MAX = 20;

export function normalizeTags(input: readonly string[]): string[] | null {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    const trimmed = raw.trim();
    // eslint-disable-next-line no-control-regex -- control characters make a tag invalid
    if (/[\s#,\u0000-\u001f\u007f]/.test(trimmed)) return null;
    const tag = trimmed.toLowerCase();
    if (tag === '') continue;
    if (tag.length > NOTE_TAG_MAX_LENGTH) return null;
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out.length > NOTE_TAGS_MAX ? null : out;
}

/** Add one raw tag to a normalised list; null means the input was invalid or the cap was hit. */
export function addTag(existing: readonly string[], input: string): string[] | null {
  return normalizeTags([...existing, input]);
}

// ---------------------------------------------------------------------------------------------
// Autosave: a draft diffed against the last saved snapshot. PATCH sends only changed fields.
// ---------------------------------------------------------------------------------------------

export interface NoteDraft {
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
}

export function toNoteDraft(note: Pick<Note, 'title' | 'body' | 'tags' | 'pinned'>): NoteDraft {
  return { title: note.title, body: note.body, tags: [...note.tags], pinned: note.pinned };
}

/**
 * The newest of two server snapshots. Every write advances `updated_at` by at least 1 ms, and
 * `updatedAt` is a canonical ISO-8601 instant, so a string comparison is the revision order. A
 * PATCH answer that resolves after a live refetch must not put the older note back in the cache.
 */
export function newestNote(current: Note | undefined, next: Note): Note {
  return current && current.updatedAt > next.updatedAt ? current : next;
}

function tagsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

/** The smallest PATCH that brings `baseline` to `current`, or null when nothing changed. */
export function diffNotePatch(baseline: NoteDraft, current: NoteDraft): NotePatch | null {
  const patch: NotePatch = {};
  if (current.title !== baseline.title) patch.title = current.title;
  if (current.body !== baseline.body) patch.body = current.body;
  if (current.pinned !== baseline.pinned) patch.pinned = current.pinned;
  if (!tagsEqual(current.tags, baseline.tags)) patch.tags = [...current.tags];
  return Object.keys(patch).length > 0 ? patch : null;
}

// ---------------------------------------------------------------------------------------------
// API error messages (upload limits, missing notes, conflicts). Falls back to the generic map.
// ---------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------
// Page-level decisions kept pure so they can be unit-tested without React
// ---------------------------------------------------------------------------------------------

/** A 404 from a note PATCH: the note is gone, so the queue stops and the draft stays visible. */
export function isNoteGoneError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404;
}

/** A 409 `stale_revision` from a note PATCH: another tab saved first, so this draft's premise no
 * longer holds. The autosave stops and the page fetches the latest note before deciding. */
export function isStaleRevisionError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 409 && err.code === 'stale_revision';
}

/** The outcome of the one direct PATCH that follows a successful censor. */
export type CensorSaveResult = 'saved' | 'conflict' | 'gone' | 'error';

const CENSOR_SPAN_PATTERN = /\{\{censored:[^{}]*\}\}/gi;

/** Every censor token in a Markdown body (`{{censored:…}}`, prefix case-insensitive). */
export function censorTokensIn(body: string): string[] {
  return Array.from(body.matchAll(CENSOR_SPAN_PATTERN), (match) => match[0]);
}

/**
 * A lenient detector for "the saved version looks like it holds censored text". A planted note can
 * contain malformed or hand-written tokens that the strict parser refuses to treat as atoms, and
 * a warning is cheap while bringing back plaintext is not.
 */
const CENSOR_LIKE_PATTERN = /\{\{\s*censored/i;

/**
 * Whether "Keep mine" needs the censor confirmation: the saved body differs from the draft and
 * carries anything censor-like (`{{censored`, any case, optional whitespace). This is deliberately
 * more cautious than comparing real tokens: a version written by another tab may censor text in a
 * form this tab does not model yet, and keeping the older draft would put that plaintext back.
 */
export function censorConflictWarning(remoteBody: string, draftBody: string): boolean {
  return remoteBody !== draftBody && CENSOR_LIKE_PATTERN.test(remoteBody);
}

/** Loading/error/ready for the note view: a background refetch error must not unmount the draft. */
export type NoteLoadPhase = 'loading' | 'error' | 'ready';

export function noteLoadPhase(query: {
  isPending: boolean;
  isError: boolean;
  data: Note | undefined;
}): NoteLoadPhase {
  if (query.data) return 'ready';
  if (query.isError) return 'error';
  return 'loading';
}

/**
 * Export links are only offered once every change is acknowledged: a dirty, saving or censor-frozen
 * note means the server's Markdown is older than what is on screen (or a censor save is about to
 * replace it). No href while unavailable, so the browser cannot start a download for stale content.
 */
export function noteExportAvailability(
  noteId: string,
  format: 'md' | 'docx' | 'pdf',
  state: { dirty: boolean; saving: boolean; frozen?: boolean },
): { href: string | null; disabled: boolean } {
  const ready = !state.dirty && !state.saving && !state.frozen;
  return { href: ready ? noteExportPath(noteId, format) : null, disabled: !ready };
}

/**
 * The surface a user should keep typing in after a conflict. The Markdown source view (and safe
 * mode) renders a textarea; otherwise the WYSIWYG surface is the editable region.
 */
export function noteFocusSurface(root: ParentNode): HTMLElement | null {
  return (
    root.querySelector<HTMLElement>('textarea.bk-note-textarea') ??
    root.querySelector<HTMLElement>('.bk-note-prosemirror')
  );
}

/**
 * Whether "Keep mine" may run. It needs a successfully fetched remote revision, and when that
 * remote body differs and looks censored, a confirmation bound to that exact revision. The page
 * calls this from the action handler itself, not only from the banner's rendering.
 */
export function keepMineAllowed(
  remote: Note | null,
  draftBody: string,
  confirmedRevision: string | null,
): boolean {
  if (!remote) return false;
  if (!censorConflictWarning(remote.body, draftBody)) return true;
  return confirmedRevision === remote.updatedAt;
}

/** What a serialised editor body says about the Markdown that is about to be saved. */
export interface VerifiedNoteBody {
  markdown: string;
  verified(): { markdown: string; mismatch: boolean };
}

/**
 * The last pass over a body patch before it is sent. Normally the verified Markdown replaces the
 * body. If the verifier reports a mismatch, the body is dropped (never guessed at), the other
 * fields keep their patch, and `bodyUnsafe` tells the page to show the explicit save error. A
 * source-view edit has no matching editor snapshot and is saved exactly as typed.
 */
export function prepareNoteSavePatch(
  patch: NotePatch,
  snapshot: VerifiedNoteBody | null,
): { patch: NotePatch | null; bodyUnsafe: boolean } {
  if (patch.body === undefined || snapshot === null || snapshot.markdown !== patch.body) {
    return { patch, bodyUnsafe: false };
  }
  const verified = snapshot.verified();
  if (verified.mismatch) {
    const { body: _body, ...rest } = patch;
    void _body;
    return { patch: Object.keys(rest).length ? rest : null, bodyUnsafe: true };
  }
  return { patch: { ...patch, body: verified.markdown }, bodyUnsafe: false };
}

/**
 * Whether the note BODY links to this task (`[label](bokydo:task/<id>)`), i.e. whether the task
 * link is derived from the text rather than made manually. Fenced code blocks and inline code
 * spans are skipped so a code sample cannot pretend to be a link. One forward pass, no regex
 * backtracking over the body.
 */
export function bodyLinksTask(body: string, taskId: string): boolean {
  const needle = `bokydo:task/${taskId.toLowerCase()}`;
  const lower = body.toLowerCase();
  if (!lower.includes(needle)) return false;
  // Blank out fenced blocks and inline code spans without changing the string's length.
  const lines = lower.split('\n');
  let fence: string | null = null;
  const stripped = lines.map((line) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker.startsWith(fence)) fence = null;
      return '';
    }
    if (marker) {
      fence = marker;
      return '';
    }
    return line.replace(/`[^`\n]*`/g, (span) => ' '.repeat(span.length));
  });
  const text = stripped.join('\n');
  // `](` starts the destination; the id must end at a `)`, a space (a link title) or the end.
  let from = 0;
  for (;;) {
    const at = text.indexOf(`](${needle}`, from);
    if (at === -1) return false;
    const end = text.charAt(at + 2 + needle.length);
    if (end === '' || end === ')' || /\s/.test(end)) return true;
    from = at + 1;
  }
}

export function noteErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const maxMb = (err.body as { maxMb?: number } | null)?.maxMb;
    switch (err.code) {
      case 'too_large':
        return maxMb
          ? `That file is larger than the ${maxMb} MB upload limit.`
          : 'That file is too large to upload.';
      case 'uploads_disabled':
        return 'File uploads are turned off on this instance.';
      case 'rate_limited':
        return 'Too many uploads. Wait a moment and try again.';
      case 'limit_exceeded':
        return "You've reached your note file storage limit.";
      case 'empty_file':
        return 'That file is empty.';
      case 'not_found':
        return 'This note no longer exists.';
      case 'id_conflict':
        return 'A note with that id already exists.';
      case 'project_limited_token':
        return 'Notes are personal and cannot be used with a project-limited token.';
      default:
        return errorMessage(err);
    }
  }
  return errorMessage(err);
}
