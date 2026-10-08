import {
  RAMBLE_LIMITS,
  type Project,
  type RambleCommitRequest,
  type RambleCommitResponse,
  type RambleDraftTask,
  type RambleExtractResponse,
  type RambleIssue,
  type RambleOpSummary,
  type RambleResolvedTask,
} from '@bokydo/shared';
import { api, postRaw } from './api.js';

/*
 * Ramble on the client: the draft is kept here, and every piece of text is sent with it. The
 * helpers below are pure so the rules (what is sent, how concurrent edits merge, what the user
 * reads) can be tested without a browser or a server.
 */

/** The draft as the extract endpoint takes it: everything except the server's `resolved`. */
export function stripResolved(task: RambleResolvedTask): RambleDraftTask {
  const { resolved, ...draft } = task;
  return draft;
}

export const draftForExtract = (draft: RambleResolvedTask[]): RambleDraftTask[] =>
  draft.map(stripResolved);

/** The user's project picks in review, by draft ref. An absent ref keeps the named project. */
export type ProjectOverrides = Readonly<Record<string, string | undefined>>;

/** The commit body: the reviewed tasks, each with the project the user picked (if any). */
export function buildCommitBody(
  draft: RambleResolvedTask[],
  overrides: ProjectOverrides,
): RambleCommitRequest {
  return {
    tasks: draft.map((task) => {
      const projectId = overrides[task.ref];
      return projectId === undefined ? stripResolved(task) : { ...stripResolved(task), projectId };
    }),
  };
}

/**
 * Fold an extraction's answer into the draft as it is now. Work done while the call was in
 * flight wins over the answer: a task the user removed stays removed, and a name they typed is
 * kept. Everything else is the server's answer, including tasks the model added.
 */
export function mergeExtraction({
  sent,
  received,
  current,
}: {
  sent: RambleDraftTask[];
  received: RambleResolvedTask[];
  current: RambleResolvedTask[];
}): RambleResolvedTask[] {
  const sentContent = new Map(sent.map((t) => [t.ref, t.content]));
  const now = new Map(current.map((t) => [t.ref, t]));
  return received.flatMap((task) => {
    const wasSent = sentContent.has(task.ref);
    const local = now.get(task.ref);
    if (wasSent && !local) return [];
    if (wasSent && local && local.content !== sentContent.get(task.ref))
      return [{ ...task, content: local.content }];
    return [task];
  });
}

/**
 * Keep a project pick only while the model leaves that task's project name alone. If the model
 * moved the task to another project, its choice is the new one, so the pick is dropped.
 */
export function reconcileOverrides(
  overrides: ProjectOverrides,
  sent: RambleDraftTask[],
  next: RambleResolvedTask[],
): Record<string, string> {
  const sentProject = new Map(sent.map((t) => [t.ref, t.project ?? null]));
  const kept: Record<string, string> = {};
  for (const task of next) {
    const projectId = overrides[task.ref];
    if (projectId === undefined) continue;
    const before = sentProject.get(task.ref);
    if (before !== undefined && before !== (task.project ?? null)) continue;
    kept[task.ref] = projectId;
  }
  return kept;
}

/** Which tasks the last extraction added or changed, for highlighting. Removed ones are gone. */
export function changeKinds(ops: RambleOpSummary[]): Map<string, 'added' | 'changed'> {
  const kinds = new Map<string, 'added' | 'changed'>();
  for (const { op, ref } of ops) {
    if (op === 'remove') kinds.delete(ref);
    else if (op === 'add') kinds.set(ref, 'added');
    else if (!kinds.has(ref)) kinds.set(ref, 'changed');
  }
  return kinds;
}

/** "2 added, 1 changed, 1 removed", or '' when nothing changed. */
export function summarizeOps(ops: RambleOpSummary[]): string {
  const count = (kind: RambleOpSummary['op']) => ops.filter((o) => o.op === kind).length;
  const parts: [number, string][] = [
    [count('add'), 'added'],
    [count('update'), 'changed'],
    [count('remove'), 'removed'],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(', ');
}

const ISSUE_TEXT: Record<RambleIssue, string> = {
  unknown_project: 'Project not found, will go to Inbox',
  unknown_section: 'Section not found, will be left out',
  unknown_assignee: 'Not a member of this project, will be unassigned',
  unparsed_due: "Couldn't read the date",
  new_label: 'New label',
};

export const issueText = (issue: RambleIssue): string => ISSUE_TEXT[issue];

/** Issues to show. A project picked in review replaces the named project, so that issue is moot. */
export function visibleIssues(issues: RambleIssue[], hasProjectPick: boolean): RambleIssue[] {
  return hasProjectPick ? issues.filter((i) => i !== 'unknown_project') : issues;
}

/** The project a task will go to: the user's pick, else the resolved project (null: Inbox). */
export function projectFor(task: RambleResolvedTask, overrides: ProjectOverrides): string | null {
  return overrides[task.ref] ?? task.resolved.projectId;
}

const WRITABLE: ReadonlySet<Project['role']> = new Set(['owner', 'admin', 'editor']);

export interface ProjectChoice {
  id: string;
  label: string;
}

/** Projects the user can add tasks to (not archived), Inbox first, then by name. */
export function writableProjects(projects: Iterable<Project>): ProjectChoice[] {
  return [...projects]
    .filter((p) => !p.isArchived && WRITABLE.has(p.role))
    .sort((a, b) => Number(b.isInbox) - Number(a.isInbox) || a.name.localeCompare(b.name))
    .map((p) => ({ id: p.id, label: p.isInbox ? 'Inbox' : p.name }));
}

export const taskCountText = (n: number): string => `${n} ${n === 1 ? 'task' : 'tasks'}`;

/** Why the draft can't be created yet, or null when it can. */
export function draftProblem(draft: RambleResolvedTask[]): string | null {
  return draft.some((t) => t.content.trim() === '') ? 'Every task needs a name.' : null;
}

/** Too much text for one extraction. The server takes at most RAMBLE_LIMITS.maxTextChars. */
export function textProblem(text: string): string | null {
  return text.trim().length > RAMBLE_LIMITS.maxTextChars
    ? `That text is longer than ${RAMBLE_LIMITS.maxTextChars.toLocaleString()} characters. Split it into two parts.`
    : null;
}

/** Add dictated words after what is typed, with a space between them. */
export function appendSpoken(text: string, piece: string): string {
  const said = piece.trim();
  if (!said) return text;
  return text.trim() ? `${text.trimEnd()} ${said}` : said;
}

/**
 * The status line, read as a live region. Work in progress comes first; the count and the last
 * change follow.
 */
export function rambleStatus({
  listening,
  transcribing,
  extracting,
  count,
  lastChange,
}: {
  listening: boolean;
  transcribing: boolean;
  extracting: boolean;
  count: number;
  lastChange: string;
}): string {
  const parts: string[] = [];
  if (listening) parts.push('Listening.');
  if (transcribing) parts.push('Transcribing…');
  if (extracting) parts.push('Extracting…');
  parts.push(`${count} ${count === 1 ? 'task' : 'tasks'} in draft.`);
  if (lastChange && !extracting) parts.push(`Last change: ${lastChange}.`);
  return parts.join(' ');
}

/** Runs jobs one at a time, in the order they were added. A failed job doesn't stop the rest. */
export function createSerialQueue() {
  let tail: Promise<void> = Promise.resolve();
  return {
    run<T>(job: () => Promise<T>): Promise<T> {
      const result = tail.then(job);
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

/**
 * Seconds for the transcribe query: the chunk's length to the nearest second, within the server's
 * limits. Rounding up would bill a 4 s chunk as 5 s, every time.
 */
export function chunkSeconds(elapsedMs: number): number {
  return Math.min(RAMBLE_LIMITS.maxAudioSeconds, Math.max(1, Math.round(elapsedMs / 1000)));
}

/** The base content type to upload: `audio/webm;codecs=opus` is sent as `audio/webm`. */
export function audioUploadType(mimeType: string): string {
  const base = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return base.startsWith('audio/') ? base : 'audio/webm';
}

const COMMIT_REASONS: Partial<Record<string, string>> = {
  forbidden: "You can't add tasks to that project.",
  not_found: 'That project or person no longer exists.',
  conflict: 'That conflicts with a change made elsewhere.',
  limit_exceeded: "You've hit a limit for this.",
  invalid: "That task isn't valid.",
};

export const commitReasonText = (reason: string | null): string =>
  (reason === null ? undefined : COMMIT_REASONS[reason]) ?? "That task couldn't be saved.";

/** The failing task from a 400 `not_created` answer, or null when the answer has no ref. */
export function commitFailure(body: unknown): { ref: string; reason: string | null } | null {
  if (typeof body !== 'object' || body === null) return null;
  const { ref, reason } = body as { ref?: unknown; reason?: unknown };
  if (typeof ref !== 'string') return null;
  return { ref, reason: typeof reason === 'string' ? reason : null };
}

export interface TranscribeAnswer {
  text: string;
}

/** Upload one audio chunk for transcription. The bytes are not kept after the call. */
export function transcribeChunk(audio: Blob, elapsedMs: number): Promise<TranscribeAnswer> {
  return postRaw<TranscribeAnswer>(
    `/api/v1/ramble/transcribe?seconds=${chunkSeconds(elapsedMs)}`,
    audio,
    audioUploadType(audio.type),
  );
}

/** Send new text and the current draft; the answer is the draft with the model's edits applied. */
export function extractDraft(
  text: string,
  draft: RambleDraftTask[],
): Promise<RambleExtractResponse> {
  return api<RambleExtractResponse>('POST', '/api/v1/ramble/extract', { text, draft });
}

export function commitDraft(body: RambleCommitRequest): Promise<RambleCommitResponse> {
  return api<RambleCommitResponse>('POST', '/api/v1/ramble/commit', body);
}
