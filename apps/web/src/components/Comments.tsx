import {
  MAX_ATTACHMENTS_PER_COMMENT,
  REACTIONS,
  type ActivityEntry,
  type AttachmentInfo,
  type Comment,
} from '@bokydo/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState, type KeyboardEvent } from 'react';
import { ApiError, api, uploadFile } from '../lib/api.js';
import { instanceQuery } from '../lib/queries.js';
import { useConfirm } from '../lib/confirm.js';
import { newId, useSend, useSyncState } from '../lib/sync.js';
import { Markdown } from './Markdown.js';
import { Avatar, useMembers } from './Sharing.js';
import { Button, inputClass, Popover } from './ui.js';

const ago = (iso: string) => {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
};

/** Comments on a task (or the project itself), with reactions and @mentions. */
export function CommentThread({
  projectId,
  taskId = null,
}: {
  projectId: string;
  taskId?: string | null;
}) {
  const state = useSyncState();
  const project = state.projects.get(projectId);
  const role = project?.role ?? 'viewer';
  const canComment = role !== 'viewer' && !project?.isArchived;
  const canModerate = role === 'owner' || role === 'admin';
  const comments = [...state.comments.values()]
    .filter((c) => c.projectId === projectId && c.taskId === taskId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return (
    <div className="space-y-3">
      {comments.length === 0 && <p className="text-sm text-muted">No comments yet.</p>}
      <ul className="space-y-3">
        {comments.map((c) => (
          <CommentItem key={c.id} comment={c} canComment={canComment} canModerate={canModerate} />
        ))}
      </ul>
      {canComment && <Composer projectId={projectId} taskId={taskId} />}
    </div>
  );
}

function CommentItem({
  comment,
  canComment,
  canModerate,
}: {
  comment: Comment;
  canComment: boolean;
  canModerate: boolean;
}) {
  const state = useSyncState();
  const send = useSend();
  const confirm = useConfirm();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.content);
  const author = comment.userId ? state.collaborators.get(comment.userId)?.username : undefined;
  const mine = comment.userId === state.user?.id;
  const reactions = Object.entries(comment.reactions) as [(typeof REACTIONS)[number], string[]][];
  const save = () => {
    if (draft.trim() && draft !== comment.content)
      send('comment_update', { id: comment.id, content: draft });
    setEditing(false);
  };
  return (
    <li className="group flex gap-2">
      <Avatar name={author ?? '?'} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2 text-xs">
          <span className="font-semibold">{author ?? 'Former member'}</span>
          <time
            className="text-muted"
            dateTime={comment.createdAt}
            title={new Date(comment.createdAt).toLocaleString()}
          >
            {ago(comment.createdAt)}
            {comment.updatedAt !== comment.createdAt && ' · edited'}
          </time>
          <span className="ml-auto flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
            {mine && canComment && (
              <button
                type="button"
                className="text-muted hover:text-fg"
                onClick={() => setEditing(true)}
              >
                Edit
              </button>
            )}
            {(mine || canModerate) && (
              <button
                type="button"
                className="text-muted hover:text-danger"
                onClick={() =>
                  void confirm({
                    title: 'Delete comment?',
                    message: 'This can’t be undone.',
                    confirmLabel: 'Delete',
                    danger: true,
                  }).then((ok) => ok && send('comment_delete', { id: comment.id }))
                }
              >
                Delete
              </button>
            )}
          </span>
        </div>
        {editing ? (
          <div className="mt-1 space-y-1">
            <textarea
              autoFocus
              aria-label="Edit comment"
              className={`${inputClass} min-h-20 text-sm`}
              value={draft}
              maxLength={15_000}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save();
                if (e.key === 'Escape') setEditing(false);
              }}
            />
            <div className="flex gap-2">
              <Button onClick={save}>Save</Button>
              <Button variant="secondary" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          comment.content.trim() && <Markdown text={comment.content} className="text-sm" />
        )}
        {comment.attachments.length > 0 && <Attachments files={comment.attachments} />}
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {reactions.map(([emoji, who]) => (
            <button
              key={emoji}
              type="button"
              disabled={!canComment}
              aria-pressed={who.includes(state.user?.id ?? '')}
              title={who.map((id) => state.collaborators.get(id)?.username ?? '?').join(', ')}
              onClick={() => send('reaction_toggle', { commentId: comment.id, emoji })}
              className={`rounded-full border px-1.5 text-xs ${who.includes(state.user?.id ?? '') ? 'border-accent bg-accent/10' : 'border-line'}`}
            >
              {emoji} {who.length}
            </button>
          ))}
          {canComment && (
            <Popover
              trigger={(p) => (
                <button
                  type="button"
                  aria-label="Add reaction"
                  className="rounded-full px-1.5 text-xs text-muted opacity-0 group-hover:opacity-100 focus:opacity-100 hover:bg-surface-alt"
                  {...p}
                >
                  ☺+
                </button>
              )}
              panelClassName="w-auto"
            >
              {(close) => (
                <div className="grid grid-cols-6 gap-1 p-1">
                  {REACTIONS.map((emoji) => (
                    <button
                      key={emoji}
                      type="button"
                      aria-label={`React with ${emoji}`}
                      className="rounded p-1 text-lg hover:bg-surface-alt"
                      onClick={() => {
                        send('reaction_toggle', { commentId: comment.id, emoji });
                        close();
                      }}
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              )}
            </Popover>
          )}
        </div>
      </div>
    </li>
  );
}

const size = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1024 ** 2
      ? `${Math.round(n / 1024)} KB`
      : `${(n / 1024 ** 2).toFixed(1)} MB`;

/** Images as thumbnails, everything else as downloads (always served as attachments). */
function Attachments({ files }: { files: AttachmentInfo[] }) {
  return (
    <ul className="mt-1 flex flex-wrap gap-2">
      {files.map((f) => (
        <li key={f.id}>
          {f.contentType.startsWith('image/') ? (
            <a
              href={`/api/v1/attachments/${f.id}?inline=1`}
              target="_blank"
              rel="noopener noreferrer"
              title={f.filename}
            >
              <img
                src={`/api/v1/attachments/${f.id}?inline=1`}
                alt={f.filename}
                loading="lazy"
                className="max-h-32 max-w-48 rounded-md border border-line object-cover"
              />
            </a>
          ) : (
            <a
              href={`/api/v1/attachments/${f.id}`}
              download={f.filename}
              className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-1 text-xs hover:bg-surface-alt"
            >
              📎 {f.filename} <span className="text-muted">{size(f.size)}</span>
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}

/** Comment box with @mention suggestions from the project's members, and file uploads. */
function Composer({ projectId, taskId }: { projectId: string; taskId: string | null }) {
  const send = useSend();
  const members = useMembers(projectId);
  const instance = useQuery(instanceQuery);
  const maxMb = instance.data?.attachmentMaxMb ?? 0;
  const [files, setFiles] = useState<AttachmentInfo[]>([]);
  const [uploading, setUploading] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [caret, setCaret] = useState(0);
  const before = text.slice(0, caret);
  const mention = /(?:^|\s)@([^\s@]{0,40})$/.exec(before);
  const suggestions = mention
    ? members
        .filter((m) => m.username.toLowerCase().startsWith((mention[1] ?? '').toLowerCase()))
        .slice(0, 6)
    : [];
  const attach = async (list: FileList | null) => {
    setUploadError(null);
    for (const file of [...(list ?? [])]) {
      if (files.length + uploading >= MAX_ATTACHMENTS_PER_COMMENT) {
        setUploadError(`At most ${MAX_ATTACHMENTS_PER_COMMENT} files per comment.`);
        break;
      }
      if (file.size > maxMb * 1024 * 1024) {
        setUploadError(`“${file.name}” is larger than ${maxMb} MB.`);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const info = await uploadFile<AttachmentInfo>(
          `/api/v1/projects/${projectId}/attachments`,
          file,
        );
        setFiles((f) => [...f, info]);
      } catch (err) {
        setUploadError(
          err instanceof ApiError && err.status === 413
            ? `“${file.name}” is too large.`
            : `“${file.name}” could not be uploaded.`,
        );
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };
  const submit = () => {
    if ((!text.trim() && files.length === 0) || uploading > 0) return;
    send('comment_add', {
      id: newId(),
      content: text,
      ...(taskId ? { taskId } : { projectId }),
      ...(files.length ? { attachmentIds: files.map((f) => f.id) } : {}),
    });
    setText('');
    setFiles([]);
  };
  const pick = (username: string) => {
    const start = caret - (mention?.[1]?.length ?? 0);
    const next = `${text.slice(0, start)}${username} ${text.slice(caret)}`;
    setText(next);
    setCaret(start + username.length + 1);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    } else if ((e.key === 'Tab' || e.key === 'Enter') && suggestions[0]) {
      e.preventDefault();
      pick(suggestions[0].username);
    }
  };
  return (
    <div className="relative space-y-1">
      <textarea
        aria-label="Write a comment"
        placeholder="Comment (Markdown, @ to mention). Ctrl+Enter to send."
        className={`${inputClass} min-h-16 text-sm`}
        value={text}
        maxLength={15_000}
        onChange={(e) => {
          setText(e.target.value);
          setCaret(e.target.selectionStart);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onKeyDown={onKeyDown}
      />
      {suggestions.length > 0 && (
        <ul
          role="listbox"
          aria-label="Mention"
          className="absolute z-10 w-56 rounded-lg border border-line bg-surface p-1 text-sm shadow-lg"
        >
          {suggestions.map((m) => (
            <li key={m.userId} role="option" aria-selected={false}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1 hover:bg-surface-alt"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pick(m.username);
                }}
              >
                <Avatar name={m.username} /> {m.username}
              </button>
            </li>
          ))}
        </ul>
      )}
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1 text-xs">
          {files.map((f) => (
            <li
              key={f.id}
              className="inline-flex items-center gap-1 rounded-md border border-line px-2 py-0.5"
            >
              📎 {f.filename}
              <button
                type="button"
                aria-label={`Remove ${f.filename}`}
                className="text-muted hover:text-fg"
                onClick={() => setFiles((all) => all.filter((x) => x.id !== f.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {uploadError && <p className="text-xs text-danger">{uploadError}</p>}
      <div className="flex items-center justify-between gap-2">
        {maxMb > 0 ? (
          <label className="cursor-pointer rounded-md px-2 py-1 text-sm text-muted hover:bg-surface-alt">
            📎 Attach{uploading > 0 ? ` (uploading ${uploading}…)` : ''}
            <input
              type="file"
              multiple
              className="sr-only"
              onChange={(e) => {
                void attach(e.target.files);
                e.target.value = '';
              }}
            />
          </label>
        ) : (
          <span />
        )}
        <Button onClick={submit} disabled={(!text.trim() && files.length === 0) || uploading > 0}>
          Comment
        </Button>
      </div>
    </div>
  );
}

const DESCRIBE: Record<
  string,
  (d: Record<string, unknown>, name: (id: unknown) => string) => string
> = {
  task_added: (d) => `added “${String(d.title)}”`,
  task_completed: (d) =>
    `completed “${String(d.title)}”${d.next ? ` (next: ${String(d.next)})` : ''}`,
  task_uncompleted: (d) => `reopened “${String(d.title)}”`,
  task_updated: (d) =>
    `changed ${(d.fields as string[] | undefined)?.join(', ') ?? 'details'} of “${String(d.title)}”`,
  task_moved: (d) => `moved “${String(d.title)}”`,
  task_deleted: (d) => `deleted “${String(d.title)}”`,
  comment_added: (d) =>
    d.title ? `commented on “${String(d.title)}”` : 'commented on the project',
  member_joined: (d, name) => `${name(d.userId)} joined as ${String(d.role)}`,
  member_left: () => 'left the project',
  member_removed: (d, name) => `removed ${name(d.userId)}`,
  member_role_changed: (d, name) => `made ${name(d.userId)} ${String(d.role)}`,
  owner_transferred: (d, name) => `made ${name(d.userId)} the owner`,
  project_archived: () => 'archived the project',
  project_unarchived: () => 'unarchived the project',
};

/** The activity log of a project, a task or a whole team. */
export function ActivityList({
  projectId,
  taskId,
  workspaceId,
}: {
  projectId?: string;
  taskId?: string;
  workspaceId?: string;
}) {
  const state = useSyncState();
  const q = workspaceId
    ? `workspaceId=${workspaceId}`
    : projectId
      ? `projectId=${projectId}`
      : `taskId=${taskId ?? ''}`;
  const pages = useInfiniteQuery({
    queryKey: ['activity', q],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) =>
      api<{ entries: ActivityEntry[]; users: Record<string, string>; nextBefore: number | null }>(
        'GET',
        `/api/v1/activity?${q}${pageParam ? `&before=${pageParam}` : ''}`,
      ),
    getNextPageParam: (last) => last.nextBefore,
  });
  const users = Object.assign({}, ...(pages.data?.pages.map((p) => p.users) ?? [])) as Record<
    string,
    string
  >;
  const name = (id: unknown) => (typeof id === 'string' ? (users[id] ?? 'someone') : 'someone');
  const entries = pages.data?.pages.flatMap((p) => p.entries) ?? [];
  return (
    <div className="space-y-2 text-sm">
      {pages.isSuccess && entries.length === 0 && <p className="text-muted">Nothing yet.</p>}
      <ul className="space-y-1.5">
        {entries.map((e) => (
          <li key={e.id} className="flex gap-2">
            <Avatar name={name(e.actorId)} />
            <span className="min-w-0 flex-1">
              <strong>{name(e.actorId)}</strong>{' '}
              {(DESCRIBE[e.type] ?? (() => e.type))(e.data, name)}
              {/* A team-wide log spans projects, so name the one each entry came from. */}
              {workspaceId && (
                <span className="text-muted">
                  {' · '}
                  {state.projects.get(e.projectId)?.name ?? 'a project'}
                </span>
              )}
            </span>
            <time className="shrink-0 text-xs text-muted" dateTime={e.at}>
              {ago(e.at)}
            </time>
          </li>
        ))}
      </ul>
      {pages.hasNextPage && (
        <Button
          variant="ghost"
          busy={pages.isFetchingNextPage}
          onClick={() => void pages.fetchNextPage()}
        >
          Show more
        </Button>
      )}
    </div>
  );
}
