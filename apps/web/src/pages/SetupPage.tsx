import { normalizePublicUrl } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useState, type FormEvent, type ReactNode } from 'react';
import { EmailSettingsForm } from '../components/EmailSettingsForm.js';
import { Alert, AuthLayout, Button, TextField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { adminSettingsQuery, setupQuery } from '../lib/queries.js';

type Step = 'url' | 'email' | 'finish';

export function SetupPage() {
  const { data: status } = useQuery(setupQuery);
  const [step, setStep] = useState<Step>('url');
  if (!status) return null;

  return (
    <AuthLayout wide>
      <h1 className="text-lg font-semibold">Set up BokyDo</h1>
      <ol className="mt-4 mb-6 space-y-1 text-sm">
        <StepLabel done>Secure the admin account</StepLabel>
        <StepLabel active={step === 'url'} done={step !== 'url'}>
          Public address
        </StepLabel>
        <StepLabel active={step === 'email'} done={step === 'finish'}>
          Email (optional)
        </StepLabel>
        <StepLabel active={step === 'finish'}>Finish</StepLabel>
      </ol>
      {step === 'url' && (
        <PublicUrlStep current={status.publicUrl} onDone={() => setStep('email')} />
      )}
      {step === 'email' && <EmailStep onDone={() => setStep('finish')} />}
      {step === 'finish' && <FinishStep onBack={() => setStep('email')} />}
    </AuthLayout>
  );
}

function StepLabel({
  children,
  active = false,
  done = false,
}: {
  children: ReactNode;
  active?: boolean;
  done?: boolean;
}) {
  return (
    <li
      className={`flex items-center gap-2 ${active ? 'font-medium' : 'text-neutral-500 dark:text-neutral-400'}`}
      aria-current={active ? 'step' : undefined}
    >
      <span
        className={`flex size-5 items-center justify-center rounded-full text-xs ${done ? 'bg-green-600 text-white' : active ? 'bg-brand text-white' : 'border border-neutral-300 dark:border-neutral-700'}`}
      >
        {done ? '✓' : ''}
      </span>
      {children}
    </li>
  );
}

function PublicUrlStep({ current, onDone }: { current: string | null; onDone: () => void }) {
  const queryClient = useQueryClient();
  const here = window.location.origin;
  const [value, setValue] = useState(current ?? here);
  const [confirmMove, setConfirmMove] = useState(false);
  const normalized = normalizePublicUrl(value);
  const movesAway = normalized !== null && normalized !== here;
  const insecure =
    normalized?.startsWith('http:') && !/^http:\/\/(localhost|127\.|\[::1\])/.test(normalized);

  const save = useMutation({
    mutationFn: () => api('PUT', '/api/v1/setup/public-url', { publicUrl: value }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['setup'] });
      if (movesAway) window.location.assign(`${normalized}/setup`);
      else onDone();
    },
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <TextField
        label="Public URL"
        type="url"
        required
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          setConfirmMove(false);
        }}
        hint="The address people use to reach BokyDo, e.g. https://tasks.example.com. Email links, passkeys and app sign-in are tied to it."
      />
      {value && !normalized && (
        <Alert>Use just the scheme and host, like https://tasks.example.com (no path).</Alert>
      )}
      {insecure && (
        <Alert tone="warning">
          Plain HTTP outside localhost sends passwords unencrypted, and passkeys and push
          notifications won't work. Put BokyDo behind an HTTPS reverse proxy if it's reachable from
          other machines.
        </Alert>
      )}
      {movesAway && (
        <label className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            className="mt-1"
            checked={confirmMove}
            onChange={(e) => setConfirmMove(e.target.checked)}
          />
          <span>
            You're currently on <strong>{here}</strong>. After saving, BokyDo only accepts changes
            made from <strong>{normalized}</strong>, so make sure that address works. (If it
            doesn't, run <code className="font-mono">bokydo admin clear-public-url</code>.)
          </span>
        </label>
      )}
      {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
      <Button
        type="submit"
        busy={save.isPending}
        disabled={!normalized || (movesAway && !confirmMove)}
      >
        {movesAway ? `Save and continue at ${normalized}` : 'Continue'}
      </Button>
    </form>
  );
}

function EmailStep({ onDone }: { onDone: () => void }) {
  const { data: settings } = useQuery(adminSettingsQuery);
  if (!settings) return null;
  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        BokyDo uses email for invitations, password resets, reminders and security alerts. You can
        skip this and set it up later in Admin → Settings.
      </p>
      <EmailSettingsForm settings={settings} />
      <div className="flex justify-end border-t border-neutral-200 pt-4 dark:border-neutral-800">
        <Button variant="secondary" onClick={onDone}>
          Continue
        </Button>
      </div>
    </div>
  );
}

function FinishStep({ onBack }: { onBack: () => void }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const finish = useMutation({
    mutationFn: () => api('POST', '/api/v1/setup/complete'),
    onSuccess: async () => {
      await queryClient.invalidateQueries();
      await navigate({ to: '/' });
    },
  });
  return (
    <div className="space-y-4">
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        That's everything needed to start. Registration is invite-only by default; you can change
        that and more in Admin → Settings.
      </p>
      {finish.isError && <Alert>{errorMessage(finish.error)}</Alert>}
      <div className="flex justify-between">
        <Button variant="ghost" onClick={onBack}>
          Back
        </Button>
        <Button onClick={() => finish.mutate()} busy={finish.isPending}>
          Finish setup
        </Button>
      </div>
    </div>
  );
}
