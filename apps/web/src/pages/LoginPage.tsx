import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Alert, AuthLayout, Button, TextField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';

export function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const login = useMutation({
    mutationFn: () => api('POST', '/api/v1/auth/login', { username, password }),
    onSuccess: async () => {
      setPassword('');
      await queryClient.invalidateQueries();
      await navigate({ to: '/' });
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthLayout>
      <h1 className="mb-4 text-lg font-semibold">Sign in</h1>
      <form onSubmit={submit} className="space-y-4">
        <TextField
          label="Username"
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
        <TextField
          label="Password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {login.isError && <Alert>{errorMessage(login.error)}</Alert>}
        <Button type="submit" className="w-full" busy={login.isPending}>
          Sign in
        </Button>
      </form>
      <p className="mt-6 text-xs text-neutral-500 dark:text-neutral-400">
        First time here? Sign in as <code className="font-mono">admin</code> with the one-time
        passphrase from <code className="font-mono">docker compose logs app</code>.
      </p>
    </AuthLayout>
  );
}
