import type {
  GrantableRole,
  Project,
  ProjectInvite,
  Role,
  Task,
  WorkspaceRole,
} from '@bokydo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../lib/api.js';
import { useTaskActions } from '../lib/actions.js';
import { useConfirm } from '../lib/confirm.js';
import { useSend, useSyncState } from '../lib/sync.js';
import { Alert, Button, Dialog, inputClass, Popover } from './ui.js';

export const ROLE_LABEL: Record<Role | WorkspaceRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  editor: 'Editor',
  commenter: 'Commenter',
  viewer: 'Viewer',
  member: 'Member',
  guest: 'Guest',
};
const ROLE_HINT: Record<GrantableRole, string> = {
  admin: 'Manage members and the project',
  editor: 'Add and change tasks',
  commenter: 'Comment, but not change tasks',
  viewer: 'See everything, change nothing',
};

/** Members of a project, with their usernames. */
export function useMembers(projectId: string) {
  const state = useSyncState();
  return state.members
    .filter((m) => m.projectId === projectId)
    .map((m) => ({ ...m, username: state.collaborators.get(m.userId)?.username ?? '…' }))
    .sort((a, b) => a.username.localeCompare(b.username));
}

export function Avatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span
      aria-hidden
      title={name}
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-accent/20 font-semibold text-accent uppercase ${size === 'sm' ? 'size-5 text-[0.65rem]' : 'size-7 text-xs'}`}
    >
      {name.slice(0, 1)}
    </span>
  );
}

/** Who can do what with members: mirrors the server's rules (which decide). */
function abilities(myRole: Role) {
  const manage = myRole === 'owner' || myRole === 'admin';
  const grantable: GrantableRole[] =
    myRole === 'owner'
      ? ['admin', 'editor', 'commenter', 'viewer']
      : ['editor', 'commenter', 'viewer'];
  return { manage, grantable };
}

/** Share settings: members and roles, direct invites, one-time links. */
export function ShareDialog({
  project,
  open,
  onClose,
}: {
  project: Project;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`Share “${project.name}”`}>
      {open && <ShareBody project={project} onClose={onClose} />}
    </Dialog>
  );
}

function ShareBody({ project, onClose }: { project: Project; onClose: () => void }) {
  const state = useSyncState();
  const send = useSend();
  const confirm = useConfirm();
  const queryClient = useQueryClient();
  const members = useMembers(project.id);
  const me = state.user?.id;
  const { manage, grantable } = abilities(project.role);
  const [identifier, setIdentifier] = useState('');
  const [role, setRole] = useState<GrantableRole>('editor');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const invites = useQuery({
    // Someone joining (from anywhere) closes their invite: refetch when membership changes.
    queryKey: ['invites', project.id, members.length],
    queryFn: () =>
      api<{ invites: ProjectInvite[] }>('GET', `/api/v1/projects/${project.id}/invites`),
    enabled: manage,
  });

  const create = async (withIdentifier: boolean) => {
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ token?: string; sent?: boolean }>(
        'POST',
        `/api/v1/projects/${project.id}/invites`,
        withIdentifier ? { identifier: identifier.trim(), role } : { role },
      );
      if (res.token) setLink(`${location.origin}/join#${res.token}`);
      else setNotice(`If “${identifier.trim()}” has an account here, they'll see the invitation.`);
      setIdentifier('');
      void queryClient.invalidateQueries({ queryKey: ['invites', project.id] });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 429
          ? 'Too many invitations for now. Try again later.'
          : err instanceof ApiError && err.body?.message
            ? err.body.message
            : 'The invitation could not be created.',
      );
    }
  };

  const invite = (e: FormEvent) => {
    e.preventDefault();
    if (identifier.trim()) void create(true);
  };

  return (
    <div className="space-y-5 text-sm">
      {manage && (
        <section className="space-y-2">
          <form onSubmit={invite} className="flex flex-wrap gap-2">
            <input
              className={`${inputClass} min-w-40 flex-1`}
              placeholder="Username or email"
              aria-label="Username or email to invite"
              value={identifier}
              maxLength={254}
              onChange={(e) => setIdentifier(e.target.value)}
            />
            <select
              aria-label="Role"
              className={`${inputClass} w-auto`}
              value={role}
              onChange={(e) => setRole(e.target.value as GrantableRole)}
            >
              {grantable.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
            <Button type="submit" disabled={!identifier.trim()}>
              Invite
            </Button>
          </form>
          <p className="text-xs text-muted">{ROLE_HINT[role]}</p>
          <Button variant="secondary" onClick={() => void create(false)}>
            Create a one-time invite link ({ROLE_LABEL[role].toLowerCase()})
          </Button>
          {link && (
            <div className="space-y-1 rounded-lg border border-line p-2">
              <p className="text-xs text-muted">
                Works once, for 7 days, for someone with an account here. It won't be shown again.
              </p>
              <div className="flex gap-2">
                <input
                  readOnly
                  className={`${inputClass} font-mono text-xs`}
                  value={link}
                  aria-label="Invite link"
                  onFocus={(e) => e.target.select()}
                />
                <Button
                  variant="secondary"
                  onClick={() => void navigator.clipboard?.writeText(link)}
                >
                  Copy
                </Button>
              </div>
            </div>
          )}
          {notice && <Alert tone="success">{notice}</Alert>}
          {error && <Alert tone="error">{error}</Alert>}
        </section>
      )}

      <section>
        <h3 className="mb-1 font-semibold">Members</h3>
        <ul className="divide-y divide-line">
          {members.map((m) => {
            const self = m.userId === me;
            const editable =
              manage &&
              m.role !== 'owner' &&
              (project.role === 'owner' || m.role !== 'admin' || self);
            return (
              <li key={m.userId} className="flex items-center gap-2 py-2">
                <Avatar name={m.username} size="md" />
                <span className="flex-1 truncate">
                  {m.username}
                  {self && <span className="text-muted"> (you)</span>}
                </span>
                {editable ? (
                  <select
                    aria-label={`Role for ${m.username}`}
                    className={`${inputClass} w-auto py-1`}
                    value={m.role}
                    onChange={(e) =>
                      send('project_member_update', {
                        projectId: project.id,
                        userId: m.userId,
                        role: e.target.value as GrantableRole,
                      })
                    }
                  >
                    {[...new Set<GrantableRole>([...grantable, m.role as GrantableRole])].map(
                      (r) => (
                        <option key={r} value={r}>
                          {ROLE_LABEL[r]}
                        </option>
                      ),
                    )}
                  </select>
                ) : (
                  <span className="text-muted">{ROLE_LABEL[m.role]}</span>
                )}
                <MemberMenu
                  project={project}
                  member={m}
                  self={self}
                  canRemove={editable && !self}
                  onLeft={onClose}
                  confirm={confirm}
                />
              </li>
            );
          })}
        </ul>
      </section>

      {manage && (invites.data?.invites.length ?? 0) > 0 && (
        <section>
          <h3 className="mb-1 font-semibold">Pending invitations</h3>
          <ul className="divide-y divide-line">
            {invites.data?.invites.map((i) => (
              <li key={i.id} className="flex items-center gap-2 py-2">
                <span className="flex-1 truncate">
                  {i.kind === 'link' ? 'Invite link' : i.invitee} · {ROLE_LABEL[i.role]}
                  <span className="text-xs text-muted">
                    {' '}
                    · expires {new Date(i.expiresAt).toLocaleDateString()}
                  </span>
                </span>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void api('DELETE', `/api/v1/projects/${project.id}/invites/${i.id}`).then(() =>
                      queryClient.invalidateQueries({ queryKey: ['invites', project.id] }),
                    )
                  }
                >
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function MemberMenu({
  project,
  member,
  self,
  canRemove,
  onLeft,
  confirm,
}: {
  project: Project;
  member: { userId: string; username: string; role: Role };
  self: boolean;
  canRemove: boolean;
  onLeft: () => void;
  confirm: ReturnType<typeof useConfirm>;
}) {
  const send = useSend();
  const canTransfer = project.role === 'owner' && !self;
  const canLeave = self && project.role !== 'owner';
  if (!canRemove && !canTransfer && !canLeave) return <span className="w-8" />;
  return (
    <Popover
      align="right"
      trigger={(p) => (
        <button
          type="button"
          aria-label={`Actions for ${member.username}`}
          className="rounded px-2 text-muted hover:bg-surface-alt"
          {...p}
        >
          ⋯
        </button>
      )}
    >
      {(close) => (
        <div className="py-1">
          {canTransfer && (
            <button
              type="button"
              className="block w-full rounded px-3 py-1.5 text-left hover:bg-surface-alt"
              onClick={() => {
                close();
                void confirm({
                  title: 'Transfer ownership?',
                  message: `${member.username} will own “${project.name}”. You'll stay on as an admin.`,
                  confirmLabel: 'Transfer',
                }).then(
                  (ok) =>
                    ok &&
                    send('project_transfer', { projectId: project.id, userId: member.userId }),
                );
              }}
            >
              Make owner
            </button>
          )}
          {(canRemove || canLeave) && (
            <button
              type="button"
              className="block w-full rounded px-3 py-1.5 text-left text-danger hover:bg-surface-alt"
              onClick={() => {
                close();
                void confirm({
                  title: self ? 'Leave project?' : `Remove ${member.username}?`,
                  message: self
                    ? `You'll lose access to “${project.name}” and its tasks.`
                    : `${member.username} will lose access, and tasks assigned to them here will be unassigned.`,
                  confirmLabel: self ? 'Leave' : 'Remove',
                  danger: true,
                }).then((ok) => {
                  if (!ok) return;
                  send('project_member_remove', { projectId: project.id, userId: member.userId });
                  if (self) onLeft();
                });
              }}
            >
              {self ? 'Leave project' : 'Remove from project'}
            </button>
          )}
        </div>
      )}
    </Popover>
  );
}

/** Assignee chooser for a task: members of its project. */
export function AssigneePicker({ task, readOnly }: { task: Task; readOnly: boolean }) {
  const state = useSyncState();
  const actions = useTaskActions();
  const members = useMembers(task.projectId);
  const current = task.assigneeId ? state.collaborators.get(task.assigneeId) : undefined;
  if (members.length < 2 && !task.assigneeId)
    return <span className="text-muted">Share the project to assign</span>;
  return (
    <select
      aria-label="Assignee"
      className={`${inputClass} py-1`}
      disabled={readOnly}
      value={task.assigneeId ?? ''}
      onChange={(e) => actions.update(task.id, { assigneeId: e.target.value || null })}
    >
      <option value="">Unassigned</option>
      {current && !members.some((m) => m.userId === current.id) && (
        <option value={current.id}>{current.username}</option>
      )}
      {members.map((m) => (
        <option key={m.userId} value={m.userId}>
          {m.userId === state.user?.id ? `${m.username} (me)` : m.username}
        </option>
      ))}
    </select>
  );
}
