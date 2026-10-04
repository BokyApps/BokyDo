import type { PublicSettings, SettingsPatch } from '@bokydo/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
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
            label="SMTP server"
            placeholder="smtp.example.com"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
          <TextField
            label="Port"
            type="number"
            min={1}
            max={65535}
            value={port}
            onChange={(e) => setPort(e.target.value)}
          />
        </div>
        <SelectField
          label="Encryption"
          value={security}
          onChange={(e) => setSecurity(e.target.value)}
          options={[
            { value: 'starttls', label: 'STARTTLS (usually port 587)' },
            { value: 'tls', label: 'TLS (usually port 465)' },
            { value: 'none', label: 'None (not recommended)' },
          ]}
        />
        {security === 'none' && (
          <Alert tone="warning">
            Without encryption, your SMTP password and emails cross the network in plain text.
          </Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Username"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          <TextField
            label="Password"
            type="password"
            autoComplete="new-password"
            placeholder={passwordIsSet ? '•••••••• (unchanged)' : ''}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="From address"
            type="email"
            placeholder="tasks@example.com"
            value={fromAddress}
            onChange={(e) => setFromAddress(e.target.value)}
          />
          <TextField
            label="From name"
            value={fromName}
            onChange={(e) => setFromName(e.target.value)}
          />
        </div>
        {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
        {save.isSuccess && <Alert tone="success">Email settings saved.</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={save.isPending}>
            Save email settings
          </Button>
          {passwordIsSet && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => save.mutate({ 'email.smtpPassword': null })}
            >
              Remove stored password
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
          label="Send a test email to"
          type="email"
          required
          value={testTo}
          onChange={(e) => setTestTo(e.target.value)}
        />
        {test.isError && <Alert>{errorMessage(test.error)}</Alert>}
        {test.isSuccess && <Alert tone="success">Sent. Check the inbox (and spam folder).</Alert>}
        <Button type="submit" variant="secondary" busy={test.isPending}>
          Send test email
        </Button>
      </form>
    </div>
  );
}
