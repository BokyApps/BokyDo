import type { PublicSettings, SettingsPatch } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
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

const RESTORE_ERROR_CODES = [
  'backup_passphrase_or_damaged',
  'backup_incompatible',
  'backup_invalid',
  'backup_busy',
] as const;

/** Admin → Backups: schedule, passphrase, the stored backups, upload and restore. */
export function AdminBackupsPage() {
  const { t } = useTranslation();
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
      <h1 className="text-2xl font-semibold">{t('admin.backups.title')}</h1>
      <Card>
        <ScheduleForm settings={settings} />
      </Card>
      <Card>
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">{t('admin.backups.storedTitle')}</h2>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex cursor-pointer items-center rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface-alt focus-within:outline focus-within:outline-2">
              {t('admin.backups.upload')}
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
              {t('admin.backups.now')}
            </Button>
          </div>
        </div>
        <p className="mb-3 text-sm text-muted">{t('admin.backups.description')}</p>
        {errors.map((m, i) => (
          <Alert key={i}>{errorMessage(m.error)}</Alert>
        ))}
        {list.length === 0 && <p className="text-sm text-muted">{t('admin.backups.none')}</p>}
        <ul className="divide-y divide-line">
          {list.map((b) => (
            <li key={b.name} className="flex flex-wrap items-center justify-between gap-2 py-3">
              <div className="min-w-0">
                <p className="font-medium break-all">{b.name}</p>
                <p className="text-xs text-muted">
                  {t('admin.backups.meta', {
                    kind:
                      b.kind === 'pre-restore'
                        ? t('admin.backups.kindPreRestore')
                        : b.kind === 'uploaded'
                          ? t('admin.backups.kindUploaded')
                          : '',
                    created: b.createdAt
                      ? new Date(b.createdAt).toLocaleString()
                      : t('admin.backups.unreadable'),
                    size: size(b.size),
                    app: b.app ? ` · ${t('admin.backups.app', { version: b.app })}` : '',
                  })}
                </p>
              </div>
              <div className="flex flex-wrap gap-1">
                <Button variant="ghost" onClick={() => download.mutate(b.name)}>
                  {t('admin.backups.download')}
                </Button>
                <Button variant="ghost" onClick={() => setRestoring(b)}>
                  {t('admin.backups.restoreButton')}
                </Button>
                <Button
                  variant="ghost"
                  onClick={() =>
                    void confirm({
                      title: t('admin.backups.deleteTitle'),
                      message: b.name,
                      confirmLabel: t('common.delete'),
                      danger: true,
                    }).then((ok) => ok && remove.mutate(b.name))
                  }
                >
                  {t('common.delete')}
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
  const { t } = useTranslation();
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
      <h2 className="text-base font-semibold">{t('admin.backups.scheduleTitle')}</h2>
      <TextField
        label={
          hasPassphrase
            ? t('admin.backups.newPassphrase')
            : t('admin.backups.passphrase')
        }
        type="password"
        autoComplete="new-password"
        minLength={12}
        value={passphrase}
        hint={t('admin.backups.passphraseHint')}
        onChange={(e) => setPassphrase(e.target.value)}
      />
      <SelectField
        label={t('admin.backups.automatic')}
        value={schedule}
        onChange={(e) => setSchedule(e.target.value as typeof schedule)}
        options={[
          { value: 'off', label: t('settings.notifications.off') },
          { value: 'daily', label: t('admin.backups.daily') },
          { value: 'weekly', label: t('admin.backups.weekly') },
        ]}
      />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectField
          label={t('admin.backups.after')}
          value={hour}
          onChange={(e) => setHour(e.target.value)}
          options={Array.from({ length: 24 }, (_, h) => ({
            value: String(h),
            label: `${String(h).padStart(2, '0')}:00`,
          }))}
        />
        <TextField
          label={t('admin.backups.retention')}
          type="number"
          min={1}
          max={90}
          value={retention}
          onChange={(e) => setRetention(e.target.value)}
        />
      </div>
      {schedule !== 'off' && !hasPassphrase && !passphrase && (
        <Alert tone="warning">{t('admin.backups.passphraseWarning')}</Alert>
      )}
      {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">{t('admin.saved')}</Alert>}
      <Button type="submit" busy={save.isPending}>
        {t('common.save')}
      </Button>
    </form>
  );
}

function RestoreDialog({ backup, onClose }: { backup: BackupInfo; onClose: () => void }) {
  const { t } = useTranslation();
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
      ? RESTORE_ERROR_CODES.includes(restore.error.code as (typeof RESTORE_ERROR_CODES)[number])
        ? t(`admin.backups.restoreError.${restore.error.code}`)
        : errorMessage(restore.error)
      : null;
  return (
    <Dialog open onClose={onClose} title={t('admin.backups.restoreTitle')}>
      {restore.isSuccess ? (
        <Alert tone="success">{t('admin.backups.restoreSuccess')}</Alert>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            restore.mutate();
          }}
        >
          <p className="text-sm">
            {t('admin.backups.restoreDescription', {
              name: backup.name,
              created: backup.createdAt
                ? ` (${new Date(backup.createdAt).toLocaleString()})`
                : '',
            })}
          </p>
          <TextField
            label={t('admin.backups.restorePassphrase')}
            type="password"
            autoComplete="off"
            value={passphrase}
            onChange={(e) => setPassphrase(e.target.value)}
          />
          <TextField
            label={t('admin.backups.restoreConfirm')}
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          {failure && <Alert>{failure}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              type="submit"
              variant="danger"
              busy={restore.isPending}
              disabled={!passphrase || typed !== 'RESTORE'}
            >
              {t('admin.backups.restoreSubmit')}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
