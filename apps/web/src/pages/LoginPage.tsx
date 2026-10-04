import type { LoginResponse, MfaMethod } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent } from 'react';
import { Alert, AuthLayout, Button, TextField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { browserSupportsPasskeys, passkeyAssertion } from '../lib/passkeys.js';
import { instanceQuery } from '../lib/queries.js';

export function LoginPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: instance } = useQuery(instanceQuery);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [methods, setMethods] = useState<MfaMethod[] | null>(null);

  const signedIn = async () => {
    setPassword('');
    await queryClient.invalidateQueries();
    await navigate({ to: '/' });
  };

  const login = useMutation({
    mutationFn: () => api<LoginResponse>('POST', '/api/v1/auth/login', { username, password }),
    onSuccess: async (res) => {
      if ('mfaRequired' in res) {
        setPassword('');
        setMethods(res.methods);
      } else await signedIn();
    },
  });
  const passkey = useMutation({
    mutationFn: () => passkeyAssertion('/api/v1/auth/passkey/options', '/api/v1/auth/passkey'),
    onSuccess: signedIn,
  });

  if (methods)
    return <SecondFactor methods={methods} onDone={signedIn} onRestart={() => setMethods(null)} />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    login.mutate();
  };

  return (
    <AuthLayout>
      <h1 className="mb-4 text-lg font-semibold">Sign in</h1>
      <form onSubmit={submit} className="space-y-4">
        <TextField
          label="Username or email"
          autoComplete="username webauthn"
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
        {(login.isError || passkey.isError) && (
          <Alert>{errorMessage(login.error ?? passkey.error)}</Alert>
        )}
        <Button type="submit" className="w-full" busy={login.isPending}>
          Sign in
        </Button>
      </form>
      {instance?.passkeysAvailable && browserSupportsPasskeys() && (
        <Button
          variant="secondary"
          className="mt-3 w-full"
          busy={passkey.isPending}
          onClick={() => passkey.mutate()}
        >
          Sign in with a passkey
        </Button>
      )}
      <div className="mt-4 flex justify-between text-sm">
        {instance?.emailEnabled ? (
          <Link to="/forgot-password" className="text-accent hover:underline">
            Forgot password?
          </Link>
        ) : (
          <span />
        )}
        {instance?.registrationOpen && (
          <Link to="/register" className="text-accent hover:underline">
            Create account
          </Link>
        )}
      </div>
      {!instance?.setupComplete && (
        <p className="mt-6 text-xs text-muted">
          First time here? Sign in as <code className="font-mono">admin</code> with the one-time
          passphrase from <code className="font-mono">docker compose logs app</code>.
        </p>
      )}
    </AuthLayout>
  );
}

function SecondFactor({
  methods,
  onDone,
  onRestart,
}: {
  methods: MfaMethod[];
  onDone: () => Promise<void>;
  onRestart: () => void;
}) {
  const [mode, setMode] = useState<'totp' | 'recovery'>(
    methods.includes('totp') ? 'totp' : 'recovery',
  );
  const [code, setCode] = useState('');
  const verify = useMutation({
    mutationFn: () =>
      api('POST', mode === 'totp' ? '/api/v1/auth/mfa/totp' : '/api/v1/auth/mfa/recovery', {
        code,
      }),
    onSuccess: onDone,
    onError: () => setCode(''),
  });
  const passkey = useMutation({
    mutationFn: () =>
      passkeyAssertion('/api/v1/auth/mfa/passkey/options', '/api/v1/auth/mfa/passkey'),
    onSuccess: onDone,
  });
  const error = verify.error ?? passkey.error;

  return (
    <AuthLayout>
      <h1 className="text-lg font-semibold">Two-step verification</h1>
      {methods.includes('passkey') && browserSupportsPasskeys() && (
        <Button className="mt-4 w-full" busy={passkey.isPending} onClick={() => passkey.mutate()}>
          Use your passkey or security key
        </Button>
      )}
      {(methods.includes('totp') || methods.includes('recovery')) && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            verify.mutate();
          }}
          className="mt-4 space-y-4"
        >
          {mode === 'totp' ? (
            <TextField
              label="Code from your authenticator app"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="\d{6}"
              maxLength={6}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            />
          ) : (
            <TextField
              label="Recovery code"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              required
              autoFocus
              value={code}
              onChange={(e) => setCode(e.target.value)}
              hint="Each recovery code works once."
            />
          )}
          <Button
            type="submit"
            variant={methods.includes('passkey') ? 'secondary' : 'primary'}
            className="w-full"
            busy={verify.isPending}
          >
            Verify
          </Button>
        </form>
      )}
      {error && (
        <div className="mt-4">
          <Alert>{errorMessage(error)}</Alert>
        </div>
      )}
      <div className="mt-4 flex justify-between text-sm">
        {methods.includes('totp') && methods.includes('recovery') ? (
          <button
            type="button"
            className="text-accent hover:underline"
            onClick={() => {
              setMode(mode === 'totp' ? 'recovery' : 'totp');
              setCode('');
            }}
          >
            {mode === 'totp' ? 'Use a recovery code' : 'Use your authenticator app'}
          </button>
        ) : (
          <span />
        )}
        <button type="button" className="text-muted hover:underline" onClick={onRestart}>
          Start over
        </button>
      </div>
    </AuthLayout>
  );
}
