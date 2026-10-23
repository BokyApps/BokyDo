import type { PublicSettings, SettingsPatch } from '@bokydo/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { Alert, Button, SelectField, TextField } from './ui.js';

/** SMTP settings with a "send test email" action. Used in the setup wizard and Admin → Settings. */
export function EmailSettingsForm({
  settings,
  onSaved,
}: {
  settings: PublicSettings;
  onSaved?: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [host, setHost] = useState(settings['email.smtpHost'] ?? '');
  const [port, setPort] = useState(String(settings['email.smtpPort']));
  const [security, setSecurity] = useState<string>(settings['email.smtpSecurity']);
  const [username, setUsername] = useState(settings['email.smtpUsername'] ?? '');
  const [password, setPassword] = useState('');
  const [fromAddress, setFromAddress] = useState(settings['email.fromAddress'] ?? '');
  const [fromName, setFromName] = useState(settings['email.fromName']);
  const [testTo, setTestTo] = useState('');
  const passwordIsSet = settings['email.smtpPassword'].isSet;

  const save = useMutation({
    mutationFn: (patch: SettingsPatch) => api('PATCH', '/api/v1/admin/settings', patch),
    onSuccess: async () => {
      setPassword('');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] });
      onSaved?.();
    },
  });
  const test = useMutation({
    mutationFn: () => api('POST', '/api/v1/admin/email/test', { to: testTo }),
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const patch: SettingsPatch = {
      'email.smtpHost': host.trim() || null,
      'email.smtpPort': Number(port),
      'email.smtpSecurity': security as 'tls' | 'starttls' | 'none',
      'email.smtpUsername': username.trim() || null,
      'email.fromAddress': fromAddress.trim() || null,
      'email.fromName': fromName,
    };
    if (password) patch['email.smtpPassword'] = password;
    save.mutate(patch);
  };

  return (
    <div className="space-y-6">
      <form onSubmit={submit} className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-[1fr_7rem]">
          <TextField
            label={t('admin.email.smtpServer')}
            placeholder="smtp.example.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
          <TextField
            label={t('admin.email.port')}
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
        <SelectField
          label={t('admin.email.encryption')}
          value={security}
          onChange={(e) => setSecurity(e.target.value)}
          options={[
            { value: 'starttls', label: t('admin.email.starttls') },
            { value: 'tls', label: t('admin.email.tls') },
            { value: 'none', label: t('admin.email.none') },
          ]}
        />
        {security === 'none' && <Alert tone="warning">{t('admin.email.noneWarning')}</Alert>}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t('admin.email.username')}
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <TextField
            label={t('admin.email.password')}
            type="password"
            autoComplete="new-password"
            placeholder={passwordIsSet ? t('admin.email.passwordUnchanged') : ''}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label={t('admin.email.fromAddress')}
            type="email"
            placeholder="tasks@example.com"
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
          />
          <TextField
            label={t('admin.email.fromName')}
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
          />
        </div>
        {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
        {save.isSuccess && <Alert tone="success">{t('admin.email.saved')}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={save.isPending}>
            {t('admin.email.save')}
          </Button>
          {passwordIsSet && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => save.mutate({ 'email.smtpPassword': null })}
            >
              {t('admin.email.removePassword')}
            </Button>
          )}
        </div>
      </form>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          test.mutate();
        }}
        className="space-y-3 border-t border-line pt-4"
      >
        <TextField
          label={t('admin.email.testTo')}
          type="email"
          required
          value={testTo}
          onChange={(e) => setTestTo(e.target.value)}
        />
        {test.isError && <Alert>{errorMessage(test.error)}</Alert>}
        {test.isSuccess && <Alert tone="success">{t('admin.email.testSent')}</Alert>}
        <Button type="submit" variant="secondary" busy={test.isPending}>
          {t('admin.email.sendTest')}
        </Button>
      </form>
    </div>
  );
}
