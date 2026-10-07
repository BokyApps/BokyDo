import type { AdminInvite, AdminUser } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Checkbox, Dialog, SecretList, TextField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { sessionQuery } from '../lib/queries.js';
import { useSensitive } from '../lib/reauth.js';

const usersQuery = {
  queryKey: ['admin', 'users'],
  queryFn: () => api<AdminUser[]>('GET', '/api/v1/admin/users'),
};
const invitesQuery = {
  queryKey: ['admin', 'invites'],
  queryFn: () => api<AdminInvite[]>('GET', '/api/v1/admin/invites'),
};

type Shown = { title: string; intro: string; items: string[]; filename: string };

function useAdminAction<V>(fn: (v: V) => Promise<unknown>, onSuccess?: (data: unknown) => void) {
  const queryClient = useQueryClient();
  const sensitive = useSensitive();
  return useMutation({
    mutationFn: (v: V) => sensitive(() => fn(v)),
    onSuccess: async (data) => {
      onSuccess?.(data);
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
}

export function AdminUsersPage() {
  const { data: users } = useQuery(usersQuery);
  const { data: session } = useQuery(sessionQuery);
  const [shown, setShown] = useState<Shown | null>(null);
  const [deleting, setDeleting] = useState<AdminUser | null>(null);
  const update = useAdminAction(
    ({ id, ...patch }: { id: string; isAdmin?: boolean; disabled?: boolean }) =>
      api('PATCH', `/api/v1/admin/users/${id}`, patch),
  );
  const resetMfa = useAdminAction((id: string) =>
    api('POST', `/api/v1/admin/users/${id}/reset-mfa`),
  );
  const resetLink = useAdminAction(
    (u: AdminUser) =>
      api<{ url: string }>('POST', `/api/v1/admin/users/${u.id}/password-reset-link`),
    (data) =>
      setShown({
        title: 'Password reset link',
        intro: 'Send this link to the user over a channel you trust. It works once, for 24 hours.',
        items: [(data as { url: string }).url],
        filename: 'reset-link.txt',
      }),
  );
  const errors = [update, resetMfa, resetLink].filter((m) => m.isError);

  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">Users</h1>
      <Card>
        <CreateUser onCreated={setShown} />
      </Card>
      {errors.map((m, i) => (
        <Alert key={i}>{errorMessage(m.error)}</Alert>
      ))}
      <Card className="overflow-x-auto p-0">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-line text-xs text-muted">
            <tr>
              <th className="px-4 py-2 font-medium">User</th>
              <th className="px-4 py-2 font-medium">Security</th>
              <th className="px-4 py-2 font-medium sr-only">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {users?.map((u) => (
              <tr key={u.id} className={u.disabled ? 'opacity-60' : ''}>
                <td className="px-4 py-3">
                  <div className="font-medium">
                    {u.username}
                    {u.isAdmin && <Badge>admin</Badge>}
                    {u.disabled && <Badge>disabled</Badge>}
                  </div>
                  <div className="text-xs text-muted">
                    {u.email ? `${u.email}${u.emailVerified ? '' : ' (unconfirmed)'}` : 'no email'}
                  </div>
                </td>
                <td className="px-4 py-3 text-xs text-muted">
                  {u.totpEnabled || u.passkeys
                    ? [
                        u.totpEnabled && 'authenticator app',
                        u.passkeys && `${u.passkeys} passkey${u.passkeys > 1 ? 's' : ''}`,
                      ]
                        .filter(Boolean)
                        .join(', ')
                    : 'password only'}
                </td>
                <td className="px-4 py-3">
                  {u.id !== session?.user.id && (
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        variant="ghost"
                        onClick={() => update.mutate({ id: u.id, isAdmin: !u.isAdmin })}
                      >
                        {u.isAdmin ? 'Remove admin' : 'Make admin'}
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => update.mutate({ id: u.id, disabled: !u.disabled })}
                      >
                        {u.disabled ? 'Enable' : 'Disable'}
                      </Button>
                      <Button variant="ghost" onClick={() => resetLink.mutate(u)}>
                        Reset link
                      </Button>
                      {(u.totpEnabled || u.passkeys > 0) && (
                        <Button variant="ghost" onClick={() => resetMfa.mutate(u.id)}>
                          Reset 2FA
                        </Button>
                      )}
                      <Button variant="ghost" onClick={() => setDeleting(u)}>
                        Delete…
                      </Button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {deleting && <DeleteUserDialog user={deleting} onClose={() => setDeleting(null)} />}
      <Card>
        <Invites onCreated={setShown} />
      </Card>
      <Dialog open={shown !== null} onClose={() => setShown(null)} title={shown?.title ?? ''}>
        {shown && (
          <div className="space-y-4">
            <p className="text-sm text-muted">{shown.intro}</p>
            <SecretList items={shown.items} filename={shown.filename} />
            <div className="flex justify-end">
              <Button onClick={() => setShown(null)}>Done</Button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}

/** Delete another user's account: shows what stops it, and needs their username typed. */
function DeleteUserDialog({ user, onClose }: { user: AdminUser; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [confirm, setConfirm] = useState('');
  const blockers = useQuery({
    queryKey: ['admin-user-deletion', user.id],
    queryFn: () =>
      api<{
        projects: { id: string; name: string }[];
        workspaces: { id: string; name: string }[];
        lastAdmin: boolean;
      }>('GET', `/api/v1/admin/users/${user.id}/deletion`),
  });
  const remove = useAdminAction(
    () => api('POST', `/api/v1/admin/users/${user.id}/delete`, { confirm }),
    () => {
      void queryClient.invalidateQueries({ queryKey: usersQuery.queryKey });
      onClose();
    },
  );
  const b = blockers.data;
  const blocked = !!b && (b.projects.length > 0 || b.workspaces.length > 0 || b.lastAdmin);
  return (
    <Dialog open onClose={onClose} title={`Delete ${user.username}?`}>
      <div className="space-y-3">
        <p className="text-sm">
          Deletes the account and everything only they could see. Their tasks and comments in shared
          projects stay without their name. They get an email if they have a verified address.
        </p>
        {blocked && b && (
          <Alert tone="warning">
            First, they (or the project owners) must transfer or delete:{' '}
            {[
              ...b.projects.map((p) => `project “${p.name}”`),
              ...b.workspaces.map((w) => `team “${w.name}”`),
            ].join(', ')}
            {b.lastAdmin ? ' (they are the last administrator)' : ''}.
          </Alert>
        )}
        <TextField
          label={`Type ${user.username} to confirm`}
          value={confirm}
          autoComplete="off"
          onChange={(e) => setConfirm(e.target.value)}
        />
        {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            busy={remove.isPending}
            disabled={!b || blocked || confirm !== user.username}
            onClick={() => remove.mutate(undefined)}
          >
            Delete account
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function Badge({ children }: { children: string }) {
  return (
    <span className="ml-2 rounded bg-surface-alt px-1.5 py-0.5 text-xs font-normal text-muted">
      {children}
    </span>
  );
}

function CreateUser({ onCreated }: { onCreated: (s: Shown) => void }) {
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const create = useAdminAction(
    () =>
      api<{ passphrase: string }>('POST', '/api/v1/admin/users', {
        username,
        ...(email ? { email } : {}),
        isAdmin,
      }),
    (data) => {
      onCreated({
        title: `Account created for ${username}`,
        intro:
          'Give them this one-time passphrase. They must choose their own password when they first sign in. It won’t be shown again.',
        items: [(data as { passphrase: string }).passphrase],
        filename: `${username}-passphrase.txt`,
      });
      setUsername('');
      setEmail('');
      setIsAdmin(false);
    },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    create.mutate(undefined);
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      <h2 className="text-base font-semibold">Add a user</h2>
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Username"
          required
          autoCapitalize="none"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <TextField
          label="Email (optional)"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <Checkbox
        label="Administrator"
        checked={isAdmin}
        onChange={(e) => setIsAdmin(e.target.checked)}
      />
      {create.isError && <Alert>{errorMessage(create.error)}</Alert>}
      <Button type="submit" busy={create.isPending}>
        Create user
      </Button>
    </form>
  );
}

function Invites({ onCreated }: { onCreated: (s: Shown) => void }) {
  const { data: invites } = useQuery(invitesQuery);
  const [email, setEmail] = useState('');
  const [isAdmin, setIsAdmin] = useState(false);
  const create = useAdminAction(
    () =>
      api<{ url: string; emailed: boolean }>('POST', '/api/v1/admin/invites', {
        ...(email ? { email } : {}),
        isAdmin,
      }),
    (data) => {
      const res = data as { url: string; emailed: boolean };
      onCreated({
        title: 'Invitation created',
        intro: res.emailed
          ? `Sent to ${email}. You can also share this link; it works once, for 7 days.`
          : 'Share this link; it works once, for 7 days.',
        items: [res.url],
        filename: 'invite-link.txt',
      });
      setEmail('');
      setIsAdmin(false);
    },
  );
  const revoke = useAdminAction((id: string) => api('DELETE', `/api/v1/admin/invites/${id}`));
  return (
    <div className="space-y-4">
      <h2 className="text-base font-semibold">Invitations</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate(undefined);
        }}
        className="space-y-3"
      >
        <TextField
          label="Email (optional)"
          type="email"
          hint="With email set up, the invitation is sent for you."
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <Checkbox
          label="Invite as administrator"
          checked={isAdmin}
          onChange={(e) => setIsAdmin(e.target.checked)}
        />
        {create.isError && <Alert>{errorMessage(create.error)}</Alert>}
        <Button type="submit" variant="secondary" busy={create.isPending}>
          Create invitation
        </Button>
      </form>
      {invites && invites.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line text-sm">
          {invites.map((i) => (
            <li key={i.id} className="flex items-center justify-between px-3 py-2">
              <div>
                {i.email ?? 'Link invitation'}
                {i.isAdmin && <Badge>admin</Badge>}
                <div className="text-xs text-muted">
                  expires {new Date(i.expiresAt).toLocaleDateString()}
                </div>
              </div>
              <Button variant="ghost" onClick={() => revoke.mutate(i.id)}>
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
