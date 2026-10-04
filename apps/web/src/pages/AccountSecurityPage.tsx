import type { AccountSecurity, SessionListItem, TotpSetup } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState, type ReactNode } from 'react';
import { Alert, Button, Card, Dialog, SecretList, TextField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { browserSupportsPasskeys, registerPasskey } from '../lib/passkeys.js';
import { sessionQuery } from '../lib/queries.js';
import { useSensitive } from '../lib/reauth.js';

const securityQuery = {
  queryKey: ['account', 'security'],
  queryFn: () => api<AccountSecurity>('GET', '/api/v1/account/security'),
};

export function AccountSecurityPage() {
  const { data: security } = useQuery(securityQuery);
  const { data: session } = useQuery(sessionQuery);
  const [codes, setCodes] = useState<string[] | null>(null);
  if (!security || !session) return null;
  const enrolling = session.user.mustEnrollMfa;

  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">Account security</h1>
      {enrolling && (
        <Alert tone="warning">
          Your administrator requires two-factor authentication. Set up an authenticator app or a
          passkey below to continue using BokyDo.
        </Alert>
      )}
      <Section title="Two-factor authentication">
        <div className="space-y-6">
          <TotpSection security={security} onCodes={setCodes} />
          <PasskeySection security={security} onCodes={setCodes} />
          <RecoverySection security={security} onCodes={setCodes} />
        </div>
      </Section>
      {!enrolling && (
        <>
          <Section title="Email">
            <EmailSection security={security} />
          </Section>
          <Section title="Password">
            <Link to="/account/password" className="text-sm text-accent hover:underline">
              Change password
            </Link>
          </Section>
          <Section title="Where you're signed in">
            <SessionsSection />
          </Section>
        </>
      )}
      <Dialog open={codes !== null} onClose={() => setCodes(null)} title="Save your recovery codes">
        <div className="space-y-4">
          <p className="text-sm text-muted">
            If you lose your phone or passkeys, each of these codes signs you in once. Store them
            somewhere safe. They won't be shown again.
          </p>
          {codes && <SecretList items={codes} filename="bokydo-recovery-codes.txt" />}
          <div className="flex justify-end">
            <Button onClick={() => setCodes(null)}>I've saved them</Button>
          </div>
        </div>
      </Dialog>
    </main>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <h2 className="mb-4 text-base font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

function useAccountMutation<T, V = void>(
  fn: (vars: V) => Promise<T>,
  onSuccess?: (data: T) => void,
) {
  const queryClient = useQueryClient();
  const sensitive = useSensitive();
  return useMutation({
    mutationFn: (vars: V) => sensitive(() => fn(vars)),
    onSuccess: async (data) => {
      onSuccess?.(data);
      await queryClient.invalidateQueries({ queryKey: ['account'] });
      await queryClient.invalidateQueries({ queryKey: ['session'] });
    },
  });
}

function TotpSection({
  security,
  onCodes,
}: {
  security: AccountSecurity;
  onCodes: (c: string[]) => void;
}) {
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const start = useAccountMutation(
    () => api<TotpSetup>('POST', '/api/v1/account/totp/setup'),
    setSetup,
  );
  const confirm = useAccountMutation(
    () => api<{ recoveryCodes: string[] | null }>('POST', '/api/v1/account/totp/confirm', { code }),
    (res) => {
      setSetup(null);
      setCode('');
      if (res.recoveryCodes) onCodes(res.recoveryCodes);
    },
  );
  const disable = useAccountMutation(() => api('POST', '/api/v1/account/totp/disable'));

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium">Authenticator app</h3>
          <p className="text-xs text-muted">
            6-digit codes from an app like Aegis, 2FAS or 1Password.
          </p>
        </div>
        {security.totpEnabled ? (
          <Button variant="secondary" busy={disable.isPending} onClick={() => disable.mutate()}>
            Turn off
          </Button>
        ) : (
          !setup && (
            <Button variant="secondary" busy={start.isPending} onClick={() => start.mutate()}>
              Set up
            </Button>
          )
        )}
      </div>
      {setup && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            confirm.mutate();
          }}
          className="space-y-3 rounded-lg border border-line p-4"
        >
          <p className="text-sm">
            Scan this with your authenticator app, then enter the code it shows.
          </p>
          <img
            src={setup.qrCode}
            alt="QR code for your authenticator app"
            className="mx-auto size-48 rounded bg-surface p-2"
          />
          <details className="text-xs text-muted">
            <summary className="cursor-pointer">Can't scan? Enter this key instead</summary>
            <code className="mt-1 block break-all font-mono text-sm">
              {setup.secret.replace(/(.{4})/g, '$1 ').trim()}
            </code>
          </details>
          <TextField
            label="Code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            required
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
          />
          <div className="flex gap-2">
            <Button type="submit" busy={confirm.isPending}>
              Turn on
            </Button>
            <Button type="button" variant="ghost" onClick={() => setSetup(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      {[start, confirm, disable].map(
        (m, i) => m.isError && <Alert key={i}>{errorMessage(m.error)}</Alert>,
      )}
    </div>
  );
}

function PasskeySection({
  security,
  onCodes,
}: {
  security: AccountSecurity;
  onCodes: (c: string[]) => void;
}) {
  const [name, setName] = useState('');
  const add = useAccountMutation(
    () => registerPasskey(name || 'Passkey'),
    (res) => {
      setName('');
      if (res.recoveryCodes) onCodes(res.recoveryCodes);
    },
  );
  const remove = useAccountMutation((id: string) =>
    api('DELETE', `/api/v1/account/passkeys/${encodeURIComponent(id)}`),
  );
  const available = security.passkeysAvailable && browserSupportsPasskeys();

  return (
    <div className="space-y-3">
      <div>
        <h3 className="text-sm font-medium">Passkeys and security keys</h3>
        <p className="text-xs text-muted">
          Sign in with your fingerprint, face, device PIN or a hardware key. Phishing-proof.
        </p>
      </div>
      {security.passkeys.length > 0 && (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {security.passkeys.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <div>
                <div className="font-medium">
                  {p.name}{' '}
                  {p.backedUp && (
                    <span className="ml-1 rounded bg-surface-alt px-1.5 text-xs text-muted">
                      synced
                    </span>
                  )}
                </div>
                <div className="text-xs text-muted">
                  Added {new Date(p.createdAt).toLocaleDateString()}
                  {p.lastUsedAt && ` · last used ${new Date(p.lastUsedAt).toLocaleDateString()}`}
                </div>
              </div>
              <Button
                variant="ghost"
                busy={remove.isPending && remove.variables === p.id}
                onClick={() => remove.mutate(p.id)}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}
      {available ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            add.mutate();
          }}
          className="flex flex-wrap items-end gap-2"
        >
          <div className="min-w-48 flex-1">
            <TextField
              label="Name"
              placeholder="e.g. Laptop, YubiKey"
              maxLength={64}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <Button type="submit" variant="secondary" busy={add.isPending}>
            Add a passkey
          </Button>
        </form>
      ) : (
        <p className="text-xs text-muted">
          Passkeys need BokyDo to be served over HTTPS at its public URL.
        </p>
      )}
      {[add, remove].map((m, i) => m.isError && <Alert key={i}>{errorMessage(m.error)}</Alert>)}
    </div>
  );
}

function RecoverySection({
  security,
  onCodes,
}: {
  security: AccountSecurity;
  onCodes: (c: string[]) => void;
}) {
  const regenerate = useAccountMutation(
    () => api<{ recoveryCodes: string[] }>('POST', '/api/v1/account/recovery-codes'),
    (res) => onCodes(res.recoveryCodes),
  );
  if (!security.totpEnabled && security.passkeys.length === 0) return null;
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <h3 className="text-sm font-medium">Recovery codes</h3>
        <p className="text-xs text-muted">
          {security.recoveryCodesRemaining} of 10 left.{' '}
          {security.recoveryCodesRemaining <= 3 && 'Generate new ones soon.'}
        </p>
        {regenerate.isError && <Alert>{errorMessage(regenerate.error)}</Alert>}
      </div>
      <Button variant="secondary" busy={regenerate.isPending} onClick={() => regenerate.mutate()}>
        New codes
      </Button>
    </div>
  );
}

function EmailSection({ security }: { security: AccountSecurity }) {
  const [email, setEmail] = useState('');
  const change = useAccountMutation(
    () => api<{ verificationSent: boolean }>('PUT', '/api/v1/account/email', { email }),
    () => setEmail(''),
  );
  return (
    <div className="space-y-3">
      <p className="text-sm">
        {security.email ? (
          <>
            {security.email}{' '}
            <span className={security.emailVerified ? 'text-success' : 'text-warning'}>
              ({security.emailVerified ? 'confirmed' : 'not confirmed'})
            </span>
          </>
        ) : (
          'No email address. Add one so you can reset your password.'
        )}
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          change.mutate();
        }}
        className="flex flex-wrap items-end gap-2"
      >
        <div className="min-w-48 flex-1">
          <TextField
            label={security.email ? 'New email address' : 'Email address'}
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <Button type="submit" variant="secondary" busy={change.isPending}>
          Save
        </Button>
      </form>
      {change.isSuccess && (
        <Alert tone="success">
          {change.data.verificationSent
            ? 'Check your inbox for a confirmation link.'
            : 'Saved. Email isn’t set up on this server, so it stays unconfirmed.'}
        </Alert>
      )}
      {change.isError && <Alert>{errorMessage(change.error)}</Alert>}
    </div>
  );
}

function describeDevice(ua: string | null): string {
  if (!ua) return 'Unknown device';
  const browser = /Firefox\//.test(ua)
    ? 'Firefox'
    : /Edg\//.test(ua)
      ? 'Edge'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : /Safari\//.test(ua)
          ? 'Safari'
          : 'App';
  const os = /Android/.test(ua)
    ? 'Android'
    : /iPhone|iPad/.test(ua)
      ? 'iOS'
      : /Mac OS/.test(ua)
        ? 'macOS'
        : /Windows/.test(ua)
          ? 'Windows'
          : /Linux/.test(ua)
            ? 'Linux'
            : '';
  return [browser, os].filter(Boolean).join(' on ');
}

function SessionsSection() {
  const queryClient = useQueryClient();
  const { data: list } = useQuery({
    queryKey: ['account', 'sessions'],
    queryFn: () => api<SessionListItem[]>('GET', '/api/v1/account/sessions'),
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/v1/account/sessions/${id}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['account', 'sessions'] }),
  });
  const revokeOthers = useMutation({
    mutationFn: () => api('POST', '/api/v1/account/sessions/revoke-others'),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['account', 'sessions'] }),
  });
  if (!list) return null;
  return (
    <div className="space-y-3">
      <ul className="divide-y divide-line rounded-lg border border-line">
        {list.map((s) => (
          <li key={s.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
            <div>
              <div className="font-medium">
                {describeDevice(s.userAgent)}{' '}
                {s.current && (
                  <span className="ml-1 rounded bg-success/15 px-1.5 text-xs text-success">
                    this device
                  </span>
                )}
              </div>
              <div className="text-xs text-muted">
                {s.ip ?? 'unknown IP'} · active {new Date(s.lastSeenAt).toLocaleString()} ·{' '}
                {s.authMethod.replace('+', ' + ')}
              </div>
            </div>
            {!s.current && (
              <Button
                variant="ghost"
                busy={revoke.isPending && revoke.variables === s.id}
                onClick={() => revoke.mutate(s.id)}
              >
                Sign out
              </Button>
            )}
          </li>
        ))}
      </ul>
      {list.length > 1 && (
        <Button
          variant="secondary"
          busy={revokeOthers.isPending}
          onClick={() => revokeOthers.mutate()}
        >
          Sign out everywhere else
        </Button>
      )}
    </div>
  );
}
