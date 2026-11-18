import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Dialog, TextField } from '../../components/ui.js';
import { onCensorLock, type PasswordPromptOptions } from '../../lib/notes-censor.js';

/**
 * Promise-based password prompt for the censor flow. The password lives only in this dialog's
 * local state (type=password, autocomplete off) and is never stored; a lock clears the input and
 * resolves the pending prompt with null so no password lingers in memory.
 */
export function usePasswordPrompt(): {
  askPassword: (opts: PasswordPromptOptions) => Promise<string | null>;
  dialog: ReactNode;
} {
  const [prompt, setPrompt] = useState<(PasswordPromptOptions & { seq: number }) | null>(null);
  const resolver = useRef<((value: string | null) => void) | null>(null);
  const seq = useRef(0);

  const askPassword = useCallback(
    (opts: PasswordPromptOptions) =>
      new Promise<string | null>((resolve) => {
        resolver.current = resolve;
        seq.current += 1;
        setPrompt({ ...opts, seq: seq.current });
      }),
    [],
  );

  const finish = useCallback((value: string | null) => {
    const resolve = resolver.current;
    resolver.current = null;
    setPrompt(null);
    resolve?.(value);
  }, []);

  useEffect(
    () =>
      onCensorLock(() => {
        // Close and wipe the password inputs; resolve so the flow never hangs.
        setPrompt(null);
        resolver.current?.(null);
        resolver.current = null;
      }),
    [],
  );

  const dialog = prompt ? (
    <PasswordDialog
      key={prompt.seq}
      opts={prompt}
      onSubmit={finish}
      onCancel={() => finish(null)}
    />
  ) : null;
  return { askPassword, dialog };
}

function PasswordDialog({
  opts,
  onSubmit,
  onCancel,
}: {
  opts: PasswordPromptOptions;
  onSubmit: (password: string) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [mismatch, setMismatch] = useState(false);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (opts.confirm && password !== confirm) {
      setMismatch(true);
      return;
    }
    onSubmit(password);
  };

  return (
    <Dialog
      open
      onClose={onCancel}
      title={
        opts.confirm
          ? t('notes.censor.setTitle', { defaultValue: 'Censor text' })
          : t('notes.censor.unlockTitle', { defaultValue: 'Unlock censored text' })
      }
    >
      <form onSubmit={submit} className="space-y-4">
        {opts.warning && (
          <Alert tone="warning">
            {t('notes.censor.warning', {
              defaultValue:
                'Censored text can only be read with this password. A forgotten password cannot be recovered, and there is no way to reset it. Keep it somewhere safe.',
            })}
          </Alert>
        )}
        {opts.error && <Alert>{opts.error}</Alert>}
        <TextField
          autoFocus
          type="password"
          autoComplete="off"
          label={t('notes.censor.password', { defaultValue: 'Password' })}
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setMismatch(false);
          }}
        />
        {opts.confirm && (
          <TextField
            type="password"
            autoComplete="off"
            label={t('notes.censor.confirmPassword', { defaultValue: 'Confirm password' })}
            value={confirm}
            onChange={(e) => {
              setConfirm(e.target.value);
              setMismatch(false);
            }}
          />
        )}
        {mismatch && (
          <Alert>{t('notes.censor.mismatch', { defaultValue: 'Passwords do not match.' })}</Alert>
        )}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onCancel}>
            {t('common.cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button type="submit">
            {opts.confirm
              ? t('notes.censor.censor', { defaultValue: 'Censor' })
              : t('notes.censor.unlock', { defaultValue: 'Unlock' })}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
