import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Alert, Button, Dialog, TextField } from '../components/ui.js';
import { api, ApiError } from './api.js';
import { errorMessage } from './messages.js';
import { browserSupportsPasskeys, passkeyAssertion } from './passkeys.js';

type Prompt = () => Promise<void>;
const ReauthContext = createContext<Prompt | null>(null);

/**
 * Sensitive account actions answer `reauth_required` when the last password/passkey check is
 * older than a few minutes. This provider shows a confirm-it's-you dialog and resolves once done.
 */
export function ReauthProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const prompt = useCallback<Prompt>(
    () =>
      new Promise<void>((resolve, reject) => {
        pending.current = { resolve, reject };
        setPassword('');
        setError(null);
        setOpen(true);
      }),
    [],
  );

  const finish = (ok: boolean, err?: unknown) => {
    setOpen(false);
    if (ok) pending.current?.resolve();
    else pending.current?.reject(err ?? new Error('cancelled'));
    pending.current = null;
  };

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      finish(true);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => api('POST', '/api/v1/auth/reauth', { password }));
  };

  return (
    <ReauthContext.Provider value={prompt}>
      {children}
      <Dialog open={open} onClose={() => finish(false)} title="Confirm it's you">
        <form onSubmit={submit} className="space-y-4">
          <p className="text-sm text-muted">This change needs your password again.</p>
          <TextField
            label="Password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error && <Alert>{error}</Alert>}
          <div className="flex flex-wrap justify-between gap-2">
            {browserSupportsPasskeys() && (
              <Button
                type="button"
                variant="ghost"
                onClick={() =>
                  void run(() =>
                    passkeyAssertion(
                      '/api/v1/auth/reauth/passkey/options',
                      '/api/v1/auth/reauth/passkey',
                    ),
                  )
                }
              >
                Use a passkey
              </Button>
            )}
            <div className="ml-auto flex gap-2">
              <Button type="button" variant="secondary" onClick={() => finish(false)}>
                Cancel
              </Button>
              <Button type="submit" busy={busy}>
                Confirm
              </Button>
            </div>
          </div>
        </form>
      </Dialog>
    </ReauthContext.Provider>
  );
}

/** Wrap an action so a `reauth_required` answer prompts once and retries. */
export function useSensitive() {
  const prompt = useContext(ReauthContext);
  if (!prompt) throw new Error('useSensitive needs <ReauthProvider>');
  return useCallback(
    async <T,>(action: () => Promise<T>): Promise<T> => {
      try {
        return await action();
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'reauth_required')) throw err;
        await prompt();
        return action();
      }
    },
    [prompt],
  );
}
