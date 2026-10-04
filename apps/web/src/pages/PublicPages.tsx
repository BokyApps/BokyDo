import type { InviteInfo } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, AuthLayout, Button, TextField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { instanceQuery } from '../lib/queries.js';

/**
 * Tokens arrive in the URL fragment (never sent to the server or leaked via Referer). Read it once
 * and strip it from the address bar so it doesn't linger in history.
 */
function useFragmentToken(): string {
  const [token] = useState(() => window.location.hash.slice(1));
  useEffect(() => {
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
  }, []);
  return token;
}

const BackToSignIn = () => (
  <Link to="/login" className="text-sm text-brand hover:underline">
    Back to sign in
  </Link>
);

export function ForgotPasswordPage() {
  const [login, setLogin] = useState('');
  const request = useMutation({
    mutationFn: () => api('POST', '/api/v1/auth/password-reset', { login }),
  });
  return (
    <AuthLayout>
      <h1 className="text-lg font-semibold">Reset your password</h1>
      {request.isSuccess ? (
        <div className="mt-4 space-y-4">
          <Alert tone="success">
            If that account has a confirmed email address, a reset link is on its way. It works
            once, for 30 minutes.
          </Alert>
          <BackToSignIn />
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            request.mutate();
          }}
          className="mt-4 space-y-4"
        >
          <TextField
            label="Username or email"
            autoComplete="username"
            required
            value={login}
            onChange={(e) => setLogin(e.target.value)}
          />
          {request.isError && <Alert>{errorMessage(request.error)}</Alert>}
          <Button type="submit" className="w-full" busy={request.isPending}>
            Send reset link
          </Button>
          <BackToSignIn />
        </form>
      )}
    </AuthLayout>
  );
}

function NewPasswordFields({
  password,
  setPassword,
  confirm,
  setConfirm,
}: {
  password: string;
  setPassword: (v: string) => void;
  confirm: string;
  setConfirm: (v: string) => void;
}) {
  const { data: instance } = useQuery(instanceQuery);
  const min = instance?.passwordMinLength ?? 12;
  return (
    <>
      <TextField
        label="New password"
        type="password"
        autoComplete="new-password"
        required
        minLength={min}
        hint={`At least ${min} characters. A few random words work well.`}
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <TextField
        label="Confirm new password"
        type="password"
        autoComplete="new-password"
        required
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {confirm && confirm !== password && <Alert>The passwords don't match.</Alert>}
    </>
  );
}

export function ResetPasswordPage() {
  const token = useFragmentToken();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const reset = useMutation({
    mutationFn: () =>
      api('POST', '/api/v1/auth/password-reset/complete', { token, newPassword: password }),
  });
  return (
    <AuthLayout>
      <h1 className="text-lg font-semibold">Choose a new password</h1>
      {reset.isSuccess ? (
        <div className="mt-4 space-y-4">
          <Alert tone="success">
            Password changed. You've been signed out everywhere; sign in with the new password.
          </Alert>
          <BackToSignIn />
        </div>
      ) : (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (password === confirm) reset.mutate();
          }}
          className="mt-4 space-y-4"
        >
          {!token && <Alert>This link is incomplete. Open it from the email again.</Alert>}
          <NewPasswordFields
            password={password}
            setPassword={setPassword}
            confirm={confirm}
            setConfirm={setConfirm}
          />
          {reset.isError && <Alert>{errorMessage(reset.error)}</Alert>}
          <Button type="submit" className="w-full" busy={reset.isPending} disabled={!token}>
            Save password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function VerifyEmailPage() {
  const token = useFragmentToken();
  const verify = useMutation({
    mutationFn: () => api('POST', '/api/v1/auth/email/verify', { token }),
  });
  const { mutate } = verify;
  useEffect(() => {
    if (token) mutate();
  }, [token, mutate]);
  return (
    <AuthLayout>
      <h1 className="text-lg font-semibold">Confirm email</h1>
      <div className="mt-4 space-y-4">
        {verify.isPending && <p className="text-sm text-neutral-500">Confirming…</p>}
        {verify.isSuccess && <Alert tone="success">Your email address is confirmed.</Alert>}
        {(verify.isError || !token) && (
          <Alert>{token ? errorMessage(verify.error) : 'This link is incomplete.'}</Alert>
        )}
        <Link to="/" className="text-sm text-brand hover:underline">
          Continue to BokyDo
        </Link>
      </div>
    </AuthLayout>
  );
}

/** Sign-up, open or by invitation (`/invite#token`). */
export function RegisterPage({ invite = false }: { invite?: boolean }) {
  const token = useFragmentToken();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const inviteInfo = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api<InviteInfo>('POST', '/api/v1/auth/invite', { token }),
    enabled: invite && Boolean(token),
  });
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const register = useMutation({
    mutationFn: () =>
      api('POST', '/api/v1/auth/register', {
        username,
        password,
        ...(email && !inviteInfo.data?.email ? { email } : {}),
        ...(invite ? { inviteToken: token } : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await navigate({ to: '/' });
    },
  });
  const invalidInvite = invite && (!token || inviteInfo.data?.valid === false);

  return (
    <AuthLayout>
      <h1 className="text-lg font-semibold">Create your account</h1>
      {invalidInvite ? (
        <div className="mt-4 space-y-4">
          <Alert>This invitation is invalid, expired, or already used. Ask for a new one.</Alert>
          <BackToSignIn />
        </div>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (password === confirm) register.mutate();
          }}
          className="mt-4 space-y-4"
        >
          <TextField
            label="Username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
            pattern="[A-Za-z0-9][A-Za-z0-9._\-]{2,31}"
            hint="3–32 letters, digits, dots, dashes or underscores."
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
          {inviteInfo.data?.email ? (
            <TextField label="Email" type="email" value={inviteInfo.data.email} readOnly />
          ) : (
            <TextField
              label="Email (optional)"
              type="email"
              autoComplete="email"
              hint="Needed to reset your password by email."
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
          <NewPasswordFields
            password={password}
            setPassword={setPassword}
            confirm={confirm}
            setConfirm={setConfirm}
          />
          {register.isError && <Alert>{errorMessage(register.error)}</Alert>}
          <Button type="submit" className="w-full" busy={register.isPending}>
            Create account
          </Button>
          <BackToSignIn />
        </form>
      )}
    </AuthLayout>
  );
}
