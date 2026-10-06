import type {
  Folder,
  GrantableWorkspaceRole,
  ProjectInvite,
  Workspace,
  WorkspaceRole,
} from '@bokydo/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../lib/api.js';
import { useConfirm } from '../lib/confirm.js';
import { newId, useSend, useSyncState } from '../lib/sync.js';
import { Avatar, ROLE_LABEL } from './Sharing.js';
import { Alert, Button, Dialog, inputClass, Popover, TextField } from './ui.js';

const ROLE_HINT: Record<GrantableWorkspaceRole, string> = {
  admin: 'Manage the team, its folders and every team project',
  member: 'See and edit every project open to the team',
  guest: 'Only the projects they are shared into',
};
const RANK: Record<WorkspaceRole, number> = { guest: 0, member: 1, admin: 2, owner: 3 };

/** At least `min` in this workspace (the server decides; this only hides what would fail). */
export const atLeast = (w: Pick<Workspace, 'role'> | undefined, min: WorkspaceRole) =>
  Boolean(w) && RANK[(w as Workspace).role] >= RANK[min];

/** Members of a workspace, with usernames. */
export function useWorkspaceMembers(workspaceId: string) {
  const state = useSyncState();
  return state.workspaceMembers
    .filter((m) => m.workspaceId === workspaceId)
    .map((m) => ({ ...m, username: state.collaborators.get(m.userId)?.username ?? '…' }))
    .sort((a, b) => RANK[b.role] - RANK[a.role] || a.username.localeCompare(b.username));
}

/** Ask for a name: new workspace, new folder, or renaming either. */
export function NameDialog({
  open,
  title,
  label,
  initial = '',
  submitLabel,
  onClose,
  onSubmit,
}: {
  open: boolean;
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      {open && (
        <NameForm
          label={label}
          initial={initial}
          submitLabel={submitLabel}
          onClose={onClose}
          onSubmit={onSubmit}
        />
      )}
    </Dialog>
  );
}

function NameForm({
  label,
  initial,
  submitLabel,
  onClose,
  onSubmit,
}: {
  label: string;
  initial: string;
  submitLabel: string;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const [name, setName] = useState(initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onSubmit(name.trim());
    onClose();
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <TextField
        label={label}
        required
        maxLength={120}
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}

export function NewWorkspaceDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const send = useSend();
  return (
    <NameDialog
      open={open}
      title="Add team"
      label="Team name"
      submitLabel="Add"
      onClose={onClose}
      onSubmit={(name) => send('workspace_add', { id: newId(), name })}
    />
  );
}

/** Team settings: name, members and roles, invitations, leave / transfer / delete. */
export function WorkspaceDialog({
  workspace,
  open,
  onClose,
}: {
  workspace: Workspace;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={`Team “${workspace.name}”`}>
      {open && <WorkspaceBody workspace={workspace} onClose={onClose} />}
    </Dialog>
  );
}

function WorkspaceBody({ workspace, onClose }: { workspace: Workspace; onClose: () => void }) {
  const state = useSyncState();
  const send = useSend();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const members = useWorkspaceMembers(workspace.id);
  const me = state.user?.id;
  const admin = atLeast(workspace, 'admin');
  const owner = workspace.role === 'owner';
  const grantable: GrantableWorkspaceRole[] = owner
    ? ['admin', 'member', 'guest']
    : ['member', 'guest'];
  const [name, setName] = useState(workspace.name);
  const [identifier, setIdentifier] = useState('');
  const [role, setRole] = useState<GrantableWorkspaceRole>('member');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const invitesKey = ['workspace-invites', workspace.id];
  const invites = useQuery({
    // Someone joining (from anywhere) closes their invite: refetch when membership changes.
    queryKey: [...invitesKey, members.length],
    queryFn: () =>
      api<{ invites: ProjectInvite[] }>('GET', `/api/v1/workspaces/${workspace.id}/invites`),
    enabled: admin,
  });

  const create = async (withIdentifier: boolean) => {
    setError(null);
    setNotice(null);
    try {
      const res = await api<{ token?: string }>(
        'POST',
        `/api/v1/workspaces/${workspace.id}/invites`,
        withIdentifier ? { identifier: identifier.trim(), role } : { role },
      );
      if (res.token) setLink(`${location.origin}/join#${res.token}`);
      else setNotice(`If “${identifier.trim()}” has an account here, they'll see the invitation.`);
      setIdentifier('');
      void queryClient.invalidateQueries({ queryKey: invitesKey });
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

  const rename = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim() && name.trim() !== workspace.name)
      send('workspace_update', { id: workspace.id, name: name.trim() });
  };

  const leave = () =>
    void confirm({
      title: 'Leave team?',
      message: `You'll lose access to “${workspace.name}” and its projects. Projects you own there pass to the team owner.`,
      confirmLabel: 'Leave',
      danger: true,
    }).then((ok) => {
      if (!ok || !me) return;
      send('workspace_member_remove', { workspaceId: workspace.id, userId: me });
      onClose();
      void navigate({ to: '/' });
    });

  const remove = () =>
    void confirm({
      title: 'Delete team?',
      message: `“${workspace.name}”, its folders and all of its projects and tasks will be deleted for everyone.`,
      confirmLabel: 'Delete team',
      danger: true,
    }).then((ok) => {
      if (!ok) return;
      send('workspace_delete', { id: workspace.id });
      onClose();
      void navigate({ to: '/' });
    });

  return (
    <div className="space-y-5 text-sm">
      {admin && (
        <form onSubmit={rename} className="flex items-end gap-2">
          <div className="flex-1">
            <TextField
              label="Name"
              required
              maxLength={120}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary" disabled={name.trim() === workspace.name}>
            Rename
          </Button>
        </form>
      )}

      {admin && (
        <section className="space-y-2">
          <h3 className="font-semibold">Invite</h3>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (identifier.trim()) void create(true);
            }}
            className="flex flex-wrap gap-2"
          >
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
              onChange={(e) => setRole(e.target.value as GrantableWorkspaceRole)}
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
            const editable = admin && m.role !== 'owner' && (owner || m.role !== 'admin' || self);
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
                      send('workspace_member_update', {
                        workspaceId: workspace.id,
                        userId: m.userId,
                        role: e.target.value as GrantableWorkspaceRole,
                      })
                    }
                  >
                    {[
                      ...new Set<GrantableWorkspaceRole>([
                        ...grantable,
                        m.role as GrantableWorkspaceRole,
                      ]),
                    ].map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-muted">{ROLE_LABEL[m.role]}</span>
                )}
                {!self && (owner || (editable && admin)) ? (
                  <Popover
                    align="right"
                    trigger={(p) => (
                      <button
                        type="button"
                        aria-label={`Actions for ${m.username}`}
                        className="rounded px-2 text-muted hover:bg-surface-alt"
                        {...p}
                      >
                        ⋯
                      </button>
                    )}
                  >
                    {(close) => (
                      <div className="py-1">
                        {owner && m.role !== 'guest' && (
                          <button
                            type="button"
                            className="block w-full rounded px-3 py-1.5 text-left hover:bg-surface-alt"
                            onClick={() => {
                              close();
                              void confirm({
                                title: 'Transfer ownership?',
                                message: `${m.username} will own “${workspace.name}”. You'll stay on as an admin.`,
                                confirmLabel: 'Transfer',
                              }).then(
                                (ok) =>
                                  ok &&
                                  send('workspace_transfer', {
                                    workspaceId: workspace.id,
                                    userId: m.userId,
                                  }),
                              );
                            }}
                          >
                            Make owner
                          </button>
                        )}
                        {editable && (
                          <button
                            type="button"
                            className="block w-full rounded px-3 py-1.5 text-left text-danger hover:bg-surface-alt"
                            onClick={() => {
                              close();
                              void confirm({
                                title: `Remove ${m.username}?`,
                                message: `${m.username} loses access to the team and its projects. Projects they own pass to the team owner.`,
                                confirmLabel: 'Remove',
                                danger: true,
                              }).then(
                                (ok) =>
                                  ok &&
                                  send('workspace_member_remove', {
                                    workspaceId: workspace.id,
                                    userId: m.userId,
                                  }),
                              );
                            }}
                          >
                            Remove from team
                          </button>
                        )}
                      </div>
                    )}
                  </Popover>
                ) : (
                  <span className="w-8" />
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {admin && (invites.data?.invites.length ?? 0) > 0 && (
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
                    void api('DELETE', `/api/v1/workspaces/${workspace.id}/invites/${i.id}`).then(
                      () => queryClient.invalidateQueries({ queryKey: invitesKey }),
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

      <div className="flex justify-end gap-2 border-t border-line pt-4">
        {!owner && (
          <Button variant="secondary" onClick={leave}>
            Leave team
          </Button>
        )}
        {owner && (
          <Button variant="danger" onClick={remove}>
            Delete team
          </Button>
        )}
      </div>
    </div>
  );
}

/** Folder actions in the sidebar: rename, delete (its projects stay in the team). */
export function FolderMenu({ folder }: { folder: Folder }) {
  const send = useSend();
  const confirm = useConfirm();
  const [renaming, setRenaming] = useState(false);
  return (
    <>
      <Popover
        align="right"
        trigger={(p) => (
          <button
            type="button"
            aria-label={`Actions for folder ${folder.name}`}
            className="rounded px-1 text-muted opacity-0 group-hover:opacity-100 hover:bg-surface-alt focus:opacity-100"
            {...p}
          >
            ⋯
          </button>
        )}
      >
        {(close) => (
          <div className="py-1 text-sm">
            <button
              type="button"
              className="block w-full rounded px-3 py-1.5 text-left hover:bg-surface-alt"
              onClick={() => {
                close();
                setRenaming(true);
              }}
            >
              Rename folder
            </button>
            <button
              type="button"
              className="block w-full rounded px-3 py-1.5 text-left text-danger hover:bg-surface-alt"
              onClick={() => {
                close();
                void confirm({
                  title: `Delete folder “${folder.name}”?`,
                  message: 'Its projects stay in the team, outside any folder.',
                  confirmLabel: 'Delete folder',
                  danger: true,
                }).then((ok) => ok && send('folder_delete', { id: folder.id }));
              }}
            >
              Delete folder
            </button>
          </div>
        )}
      </Popover>
      <NameDialog
        open={renaming}
        title="Rename folder"
        label="Folder name"
        initial={folder.name}
        submitLabel="Save"
        onClose={() => setRenaming(false)}
        onSubmit={(name) => send('folder_update', { id: folder.id, name })}
      />
    </>
  );
}
