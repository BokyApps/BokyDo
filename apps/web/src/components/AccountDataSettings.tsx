import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { sessionQuery } from '../lib/queries.js';
import { useSensitive } from '../lib/reauth.js';
import { TodoistImport } from './TodoistImport.js';
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
      <TodoistImport />
      <DeleteCard />
    </div>
  );
}

function ExportCard() {
  const { t } = useTranslation();
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
      <h2 className="mb-1 font-semibold">{t('settings.data.exportTitle')}</h2>
      <p className="mb-4 text-sm text-muted">{t('settings.data.exportDescription')}</p>
      {download.isError && <Alert tone="error">{errorMessage(download.error)}</Alert>}
      <Button busy={download.isPending} onClick={() => download.mutate()}>
        {t('settings.data.downloadButton')}
      </Button>
    </Card>
  );
}

function DeleteCard() {
  const { t } = useTranslation();
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
      <h2 className="mb-1 font-semibold">{t('settings.data.deleteTitle')}</h2>
      <p className="mb-4 text-sm text-muted">{t('settings.data.deleteDescription')}</p>
      {blocked && b && (
        <Alert tone="warning">
          <p className="mb-1">{t('settings.data.blockersTitle')}</p>
          <ul className="list-disc pl-5">
            {b.projects.map((p) => (
              <li key={p.id}>{t('settings.data.blockerProject', { name: p.name })}</li>
            ))}
            {b.workspaces.map((w) => (
              <li key={w.id}>{t('settings.data.blockerTeam', { name: w.name })}</li>
            ))}
            {b.lastAdmin && <li>{t('settings.data.blockerLastAdmin')}</li>}
          </ul>
        </Alert>
      )}
      <Button variant="danger" disabled={!b || blocked} onClick={() => setOpen(true)}>
        {t('settings.data.deleteButton')}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={t('settings.data.deleteConfirmTitle')}
      >
        <div className="space-y-3">
          <p className="text-sm">{t('settings.data.confirmPrompt', { username })} </p>
          <TextField
            label={t('settings.data.username')}
            value={confirm}
            autoComplete="off"
            onChange={(e) => setConfirm(e.target.value)}
          />
          {remove.isError && <Alert tone="error">{errorMessage(remove.error)}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              busy={remove.isPending}
              disabled={confirm !== username}
              onClick={() => remove.mutate()}
            >
              {t('settings.data.deleteAccountButton')}
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
