import { instanceStatusSchema, type InstanceStatus } from '@bokydo/shared';
import { useEffect, useState } from 'react';

type State = { kind: 'loading' } | { kind: 'error' } | { kind: 'ready'; status: InstanceStatus };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/v1/instance', { signal: controller.signal })
      .then((res) => res.json())
      .then((json: unknown) =>
        setState({ kind: 'ready', status: instanceStatusSchema.parse(json) }),
      )
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: 'error' });
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-md rounded-2xl border border-neutral-200 p-8 shadow-sm dark:border-neutral-800">
        <h1 className="text-2xl font-semibold">
          <span className="text-brand">Boky</span>Do
        </h1>
        {state.kind === 'loading' && <p className="mt-4 text-neutral-500">Connecting…</p>}
        {state.kind === 'error' && (
          <p className="mt-4 text-red-600">Can't reach the BokyDo server.</p>
        )}
        {state.kind === 'ready' && !state.status.setupComplete && (
          <div className="mt-4 space-y-3 text-sm text-neutral-600 dark:text-neutral-400">
            <p>This instance hasn't been set up yet.</p>
            <p>
              Sign in as <code className="font-mono">admin</code> with the one-time passphrase
              printed in the server log:
            </p>
            <pre className="overflow-x-auto rounded-lg bg-neutral-100 p-3 font-mono text-xs dark:bg-neutral-900">
              docker compose logs app
            </pre>
          </div>
        )}
        {state.kind === 'ready' && state.status.setupComplete && (
          <p className="mt-4 text-neutral-600 dark:text-neutral-400">Ready.</p>
        )}
        {state.kind === 'ready' && (
          <p className="mt-6 text-xs text-neutral-400">v{state.status.version}</p>
        )}
      </div>
    </main>
  );
}
