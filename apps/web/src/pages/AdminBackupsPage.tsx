import type { PublicSettings, SettingsPatch } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, Dialog, SelectField, TextField } from '../components/ui.js';
import { api, ApiError, uploadFile } from '../lib/api.js';
import { useConfirm } from '../lib/confirm.js';
import { errorMessage } from '../lib/messages.js';
import { adminSettingsQuery } from '../lib/queries.js';
import { useSensitive } from '../lib/reauth.js';

interface BackupInfo {
  name: string;
  kind: 'backup' | 'pre-restore' | 'uploaded';
  size: number;
  createdAt: string | null;
  app: string | null;
}

const backupsQuery = {
  queryKey: ['admin', 'backups'],
  queryFn: () =>
    api<{ backups: BackupInfo[]; passphraseSet: boolean }>('GET', '/api/v1/admin/backups'),
};

const size = (n: number) =>
  n > 1 << 30
    ? `${(n / (1 << 30)).toFixed(1)} GB`
    : n > 1 << 20
      ? `${(n / (1 << 20)).toFixed(1)} MB`
      : `${Math.ceil(n / 1024)} KB`;

const RESTORE_MESSAGES: Record<string, string> = {
  backup_passphrase_or_damaged: 'The passphrase is wrong, or the file is damaged.',
  backup_incompatible:
    'This backup comes from a newer or different BokyDo; restore it on a matching version.',
  backup_invalid: "That file isn't a usable BokyDo backup.",
  backup_busy: 'A restore is already running.',
};

/** Admin → Backups: schedule, passphrase, the stored backups, upload and restore. */
export function AdminBackupsPage() {
  const { data: settings } = useQuery(adminSettingsQuery);
  const backups = useQuery(backupsQuery);
  const queryClient = useQueryClient();
  const sensitive = useSensitive();
  const confirm = useConfirm();
  const [restoring, setRestoring] = useState<BackupInfo | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['admin', 'backups'] });

  const now = useMutation({
    mutationFn: () => api('POST', '/api/v1/admin/backups'),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: (name: string) => sensitive(() => api('DELETE', `/api/v1/admin/backups/${name}`)),
    onSuccess: refresh,
  });
  const download = useMutation({
    mutationFn: (name: string) =>
      sensitive(async () => {
        const res = await fetch(`/api/v1/admin/backups/${name}`, { credentials: 'same-origin' });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new ApiError(res.status, body?.error ?? 'error', null);
        }
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
      }),
  });
  const upload = useMutation({
    mutationFn: (file: File) => sensitive(() => uploadFile('/api/v1/admin/backups/upload', file)),
    onSuccess: refresh,
  });

  if (!settings) return null;
  const list = backups.data?.backups ?? [];
  const errors = [now, remove, download, upload].filter((m) => m.isError);
  return (
    <div className="mx-auto max-w-3xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">Backups</h1>
      <Card>
        <ScheduleForm settings={settings} />
      </Card>
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">Stored backups</h2>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex cursor-pointer items-center rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface-alt focus-within:outline focus-within:outline-2">
              Upload a backup…
              <input
                type="file"
                accept=".bkdo"
                className="sr-only"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload.mutate(f);
                  e.target.value = '';
                }}
              />
            </label>
            <Button
              busy={now.isPending}
              disabled={!backups.data?.passphraseSet}
              onClick={() => now.mutate()}
            >
              Back up now
            </Button>
          </div>
        </div>
        <p className="mb-3 text-sm text-muted">
          Backups hold everything (database, attachments and this server's keys), encrypted with
          your passphrase, in the server's data folder. Download copies and keep them somewhere else
          too: a backup on the same disk doesn't survive losing that disk.
        </p>
        {errors.map((m, i) => (
          <Alert key={i}>{errorMessage(m.error)}</Alert>
        ))}
        {list.length === 0 && <p className="text-sm text-muted">No backups yet.</p>}
        <ul className="divide-y divide-line">
          {list.map((b) => (
            <li key={b.name} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div className="min-w-0">
                <p className="font-medium break-all">{b.name}</p>
                <p className="text-xs text-muted">
                  {b.kind === 'pre-restore'
                    ? 'Automatic, before a restore · '
                    : b.kind === 'uploaded'
                      ? 'Uploaded · '
                      : ''}
                  {b.createdAt ? new Date(b.createdAt).toLocaleString() : 'unreadable'} ·{' '}
                  {size(b.size)}
                  {b.app ? ` · BokyDo ${b.app}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button variant="ghost" onClick={() => download.mutate(b.name)}>
                  Download
                </Button>
                <Button variant="ghost" onClick={() => setRestoring(b)}>
                  Restore…
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void confirm({
                      title: 'Delete this backup?',
                      message: b.name,
                      confirmLabel: 'Delete',
                      danger: true,
                    }).then((ok) => ok && remove.mutate(b.name))
                  }
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
      {restoring && <RestoreDialog backup={restoring} onClose={() => setRestoring(null)} />}
    </div>
  );
}

function ScheduleForm({ settings }: { settings: PublicSettings }) {
  const queryClient = useQueryClient();
  const [schedule, setSchedule] = useState(settings['backups.schedule']);
  const [hour, setHour] = useState(String(settings['backups.hour']));
  const [retention, setRetention] = useState(String(settings['backups.retention']));
  const [passphrase, setPassphrase] = useState('');
  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => api('PATCH', '/api/v1/admin/settings', patch),
    onSuccess: async () => {
      setPassphrase('');
      await queryClient.invalidateQueries({ queryKey: ['admin'] });
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      'backups.schedule': schedule,
      'backups.hour': Number(hour),
      'backups.retention': Number(retention),
      ...(passphrase ? { 'backups.passphrase': passphrase } : {}),
    });
  };
  const hasPassphrase = settings['backups.passphrase'].isSet;
  return (
    <form onSubmit={submit} className="space-y-3">
      <h2 className="text-base font-semibold">Schedule</h2>
      <TextField
        label={
          hasPassphrase ? 'New backup passphrase (leave empty to keep it)' : 'Backup passphrase'
        }
        type="password"
        autoComplete="new-password"
        minLength={12}
        value={passphrase}
        hint="At least 12 characters. Keep it safe and away from the server: without it no backup can be restored, and changing it doesn't re-encrypt older backups."
        onChange={(e) => setPassphrase(e.target.value)}
      />
      <SelectField
        label="Automatic backups"
        value={schedule}
        onChange={(e) => setSchedule(e.target.value as typeof schedule)}
        options={[
          { value: 'off', label: 'Off' },
          { value: 'daily', label: 'Daily' },
          { value: 'weekly', label: 'Weekly' },
        ]}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label="After (server time zone)"
          value={hour}
          onChange={(e) => setHour(e.target.value)}
          options={Array.from({ length: 24 }, (_, h) => ({
            value: String(h),
            label: `${String(h).padStart(2, '0')}:00`,
          }))}
        />
        <TextField
          label="Keep this many"
          type="number"
          min={1}
          max={90}
          value={retention}
          onChange={(e) => setRetention(e.target.value)}
        />
      </div>
      {schedule !== 'off' && !hasPassphrase && !passphrase && (
        <Alert tone="warning">Set a passphrase: automatic backups don't run without one.</Alert>
      )}
      {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Saved.</Alert>}
      <Button type="submit" busy={save.isPending}>
        Save
      </Button>
    </form>
  );
}

function RestoreDialog({ backup, onClose }: { backup: BackupInfo; onClose: () => void }) {
  const sensitive = useSensitive();
  const [passphrase, setPassphrase] = useState('');
  const [typed, setTyped] = useState('');
  const restore = useMutation({
    mutationFn: () =>
      sensitive(() =>
        api('POST', `/api/v1/admin/backups/${backup.name}/restore`, {
          passphrase,
          confirm: 'RESTORE',
        }),
      ),
    onSuccess: () => {
      // The server restarts and everyone signs in again.
      setTimeout(() => location.assign('/login'), 4000);
    },
  });
  const failure =
    restore.error instanceof ApiError
      ? (RESTORE_MESSAGES[restore.error.code] ?? errorMessage(restore.error))
      : null;
  return (
    <Dialog open onClose={onClose} title="Restore this backup?">
      {restore.isSuccess ? (
        <Alert tone="success">
          Restored. The server is restarting; you'll be taken to sign in.
        </Alert>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            restore.mutate();
          }}
        >
          <p className="text-sm">
            Everything on this server is replaced by{' '}
            <strong className="break-all">{backup.name}</strong>
            {backup.createdAt ? ` (${new Date(backup.createdAt).toLocaleString()})` : ''}. Changes
            made since then are lost; a backup of the current state is made first. Everyone is
            signed out, and API tokens and connected apps have to be set up again.
          </p>
          <TextField
            label="Passphrase of this backup"
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <TextField
            label="Type RESTORE to confirm"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          {failure && <Alert>{failure}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="danger"
              busy={restore.isPending}
              disabled={!passphrase || typed !== 'RESTORE'}
            >
              Restore
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
