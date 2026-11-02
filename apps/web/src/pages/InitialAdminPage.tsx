import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AuthLayout, Button, TextField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { instanceQuery } from '../lib/queries.js';

export function InitialAdminPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: instance } = useQuery(instanceQuery);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [passwordMismatch, setPasswordMismatch] = useState(false);

  const createAdmin = useMutation({
    mutationFn: () => api('POST', '/api/v1/setup/admin', { username, password }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await navigate({ to: '/' });
    },
    onError: async () => {
      // Another browser may have claimed the first-admin slot between page load and submit.
      await queryClient.invalidateQueries({ queryKey: ['instance'] });
      const fresh = await queryClient.fetchQuery({ ...instanceQuery, staleTime: 0 });
      if (!fresh.initialAdminRequired) await navigate({ to: '/login' });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (password !== confirm) {
      setPasswordMismatch(true);
      return;
    }
    setPasswordMismatch(false);
    createAdmin.mutate();
  };

  const lostRace = createAdmin.isError && !instance?.initialAdminRequired;
  return (
    <AuthLayout>
      <h1 className="mb-2 text-lg font-semibold">{t('initialAdmin.title')}</h1>
      <p className="mb-4 text-sm text-muted">{t('initialAdmin.intro')}</p>
      {lostRace ? (
        <div className="space-y-4">
          <Alert>{t('initialAdmin.claimed')}</Alert>
          <Link to="/login" className="text-sm text-accent hover:underline">
            {t('initialAdmin.signIn')}
          </Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <TextField
            label={t('initialAdmin.username')}
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={username}
            onChange={(event) => setUsername(event.target.value)}
          />
          <TextField
            label={t('initialAdmin.password')}
            type="password"
            autoComplete="new-password"
            required
            minLength={instance?.passwordMinLength ?? 12}
            hint={t('initialAdmin.passwordHint', { count: instance?.passwordMinLength ?? 12 })}
            value={password}
            onChange={(event) => {
              setPassword(event.target.value);
              setPasswordMismatch(false);
            }}
          />
          <TextField
            label={t('initialAdmin.confirmPassword')}
            type="password"
            autoComplete="new-password"
            required
            value={confirm}
            onChange={(event) => {
              setConfirm(event.target.value);
              setPasswordMismatch(false);
            }}
          />
          {passwordMismatch && <Alert>{t('initialAdmin.passwordMismatch')}</Alert>}
          {createAdmin.isError && !lostRace && <Alert>{errorMessage(createAdmin.error)}</Alert>}
          <Button type="submit" className="w-full" busy={createAdmin.isPending}>
            {t('initialAdmin.create')}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
