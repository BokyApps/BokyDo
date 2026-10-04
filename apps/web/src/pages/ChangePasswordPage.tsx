import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Alert, AuthLayout, Button, TextField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { instanceQuery, sessionQuery } from '../lib/queries.js';

export function ChangePasswordPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: instance } = useQuery(instanceQuery);
  const { data: session } = useQuery(sessionQuery);
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNew] = useState('');
  const [confirm, setConfirm] = useState('');
  const minLength = instance?.passwordMinLength ?? 12;
  const forced = session?.user.mustChangePassword ?? false;
  const mismatch = confirm.length > 0 && confirm !== newPassword;

  const change = useMutation({
    mutationFn: () => api('POST', '/api/v1/auth/password', { currentPassword, newPassword }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await navigate({ to: '/' });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!mismatch) change.mutate();
  };

  return (
    <AuthLayout>
      <h1 className="text-lg font-semibold">
        {forced ? 'Choose your password' : 'Change password'}
      </h1>
      {forced && (
        <p className="mt-1 text-sm text-muted">
          The one-time passphrase has done its job. Pick a password only you know.
        </p>
      )}
      <form onSubmit={submit} className="mt-4 space-y-4">
        {/* Helps password managers attach the new password to the right account. */}
        <input
          type="text"
          name="username"
          autoComplete="username"
          value={session?.user.username ?? ''}
          readOnly
          hidden
        />
        <TextField
          label={forced ? 'One-time passphrase' : 'Current password'}
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <TextField
          label="New password"
          type="password"
          autoComplete="new-password"
          required
          minLength={minLength}
          hint={`At least ${minLength} characters. A few random words make a strong, memorable password.`}
          value={newPassword}
          onChange={(e) => setNew(e.target.value)}
        />
        <TextField
          label="Confirm new password"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
        {mismatch && <Alert>The passwords don't match.</Alert>}
        {change.isError && <Alert>{errorMessage(change.error)}</Alert>}
        <Button type="submit" className="w-full" busy={change.isPending} disabled={mismatch}>
          Save password
        </Button>
      </form>
    </AuthLayout>
  );
}
