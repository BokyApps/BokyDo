import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { sessionQuery } from '../lib/queries.js';
import { useSensitive } from '../lib/reauth.js';
import { Alert, Button, Card, Dialog, TextField } from './ui.js';

interface Blockers {
  projects: { id: string; name: string }[];
  workspaces: { id: string; name: string }[];
  lastAdmin: boolean;
}

/** Settings → Your data: export everything, delete the account. */
export function AccountDataSettings() {
  return (
    <div className="space-y-6">
      <ExportCard />
      <DeleteCard />
    </div>
  );
}

function ExportCard() {
  const sensitive = useSensitive();
  const download = useMutation({
    mutationFn: () =>
      sensitive(async () => {
        const res = await fetch('/api/v1/account/export', { credentials: 'same-origin' });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new ApiError(res.status, body?.error ?? 'error', null);
        }
        const blob = await res.blob();
        const name =
          /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ??
          'bokydo-export.zip';
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      }),
  });
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Export everything</h2>
      <p className="mb-4 text-sm text-muted">
        A ZIP with all your projects, tasks (completed ones too), comments, labels, filters,
        settings and attached files, as JSON plus a spreadsheet-friendly CSV. Passwords and keys are
        never included.
      </p>
      {download.isError && <Alert tone="error">{errorMessage(download.error)}</Alert>}
      <Button busy={download.isPending} onClick={() => download.mutate()}>
        Download my data
      </Button>
    </Card>
  );
}

function DeleteCard() {
  const sensitive = useSensitive();
  const { data: session } = useQuery(sessionQuery);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const blockers = useQuery({
    queryKey: ['account-deletion'],
    queryFn: () => api<Blockers>('GET', '/api/v1/account/deletion'),
  });
  const remove = useMutation({
    mutationFn: () => sensitive(() => api('POST', '/api/v1/account/delete', { confirm })),
    onSuccess: () => {
      location.assign('/login');
    },
  });
  const b = blockers.data;
  const blocked = !!b && (b.projects.length > 0 || b.workspaces.length > 0 || b.lastAdmin);
  const username = session?.user.username ?? '';
  return (
    <Card>
      <h2 className="mb-1 font-semibold">Delete account</h2>
      <p className="mb-4 text-sm text-muted">
        Permanently deletes your account, your projects and tasks, and your settings. Tasks and
        comments you added to other people's projects stay there without your name. This can't be
        undone: download your data first if you want a copy.
      </p>
      {blocked && b && (
        <Alert tone="warning">
          <p className="mb-1">Before you can delete your account:</p>
          <ul className="list-disc pl-5">
            {b.projects.map((p) => (
              <li key={p.id}>transfer or delete the shared project “{p.name}”</li>
            ))}
            {b.workspaces.map((w) => (
              <li key={w.id}>transfer the team “{w.name}” to someone else</li>
            ))}
            {b.lastAdmin && <li>make someone else an administrator of this server</li>}
          </ul>
        </Alert>
      )}
      <Button variant="danger" disabled={!b || blocked} onClick={() => setOpen(true)}>
        Delete my account…
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Delete your account?">
        <div className="space-y-3">
          <p className="text-sm">
            Type your username, <strong>{username}</strong>, to confirm. Everything only you could
            see is deleted for good.
          </p>
          <TextField
            label="Username"
            value={confirm}
            autoComplete="off"
            onChange={(e) => setConfirm(e.target.value)}
          />
          {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              busy={remove.isPending}
              disabled={confirm !== username}
              onClick={() => remove.mutate()}
            >
              Delete account
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
