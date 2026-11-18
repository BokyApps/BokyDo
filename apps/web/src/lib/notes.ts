import type {
  Note,
  NoteCreateRequest,
  NoteListResponse,
  NotePatch,
  NoteState,
  NoteSummary,
  NoteTagsResponse,
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

export const noteTagsQuery = queryOptions({
  queryKey: notesKeys.tags(),
  queryFn: () => api<NoteTagsResponse>('GET', noteTagsPath),
});

export const taskNotesQuery = (taskId: string) =>
  queryOptions({
    queryKey: notesKeys.taskNotes(taskId),
    queryFn: () => api<{ notes: NoteSummary[] }>('GET', taskNotesPath(taskId)),
  });

export function createNote(body: NoteCreateRequest): Promise<{ note: Note }> {
  return api<{ note: Note }>('POST', '/api/v1/notes', body);
}

export function patchNote(id: string, patch: NotePatch): Promise<unknown> {
  return api('PATCH', pathFor(id), patch);
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
