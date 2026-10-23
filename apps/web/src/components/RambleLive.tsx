import { RAMBLE_LIVE, type RambleOpSummary, type RambleResolvedTask } from '@bokydo/shared';
import { useEffect, useState } from 'react';
import { liveCloseText, useLiveRamble } from '../lib/ramble-live.js';
import { Alert, Button } from './ui.js';

/**
 * Live Ramble: the model listens and edits the draft while the user talks. The audio goes to the
 * server, which holds the provider key; the browser only sees the transcript and the draft.
 *
 * Shown only when the server has a live model routed (ramble.live) and the browser can record.
 */
export function RambleLive({
  available,
  canRecord,
  onDraft,
  onError,
  onRunningChange,
}: {
  /** The server offers a live model for this user. */
  available: boolean;
  /** The browser can record audio. */
  canRecord: boolean;
  onDraft: (draft: RambleResolvedTask[], ops: RambleOpSummary[]) => void;
  onError: (message: string) => void;
  /** Told when a live session starts or ends, so the other controls can step aside. */
  onRunningChange: (running: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const live = useLiveRamble({
    onDraft,
    onError,
    onEnd: (reason) => {
      const text = liveCloseText(reason);
      if (text) onError(text);
    },
  });
  const running = live.phase !== 'idle';

  useEffect(() => {
    onRunningChange(running);
  }, [running, onRunningChange]);

  if (!available) return null;

  const minutes = Math.round(RAMBLE_LIVE.maxSeconds / 60);
  const status =
    live.phase === 'connecting'
      ? 'Opening the live session…'
      : live.phase === 'live'
        ? 'Listening. The draft updates as you talk.'
        : live.phase === 'stopping'
          ? 'Wrapping up…'
          : 'Not running.';

  return (
    <section className="space-y-3 rounded-xl border border-line bg-surface-alt/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Live Ramble</h3>
        {running ? (
          <Button variant="secondary" onClick={live.stop} busy={live.phase === 'stopping'}>
            Stop live
          </Button>
        ) : (
          <Button
            onClick={() => {
              setOpen(true);
              live.start();
            }}
            disabled={!canRecord}
          >
            Start live
          </Button>
        )}
      </div>
      <p className="text-xs text-muted">
        {status} A live session lasts up to {minutes} minutes. The audio goes to this server, which
        holds the model key; the browser never sees it.
      </p>
      {!canRecord && (
        <Alert tone="warning">
          This browser cannot record audio, so live Ramble is not available.
        </Alert>
      )}
      {open && (live.transcript || live.interim) && (
        <div className="space-y-1">
          <h4 className="text-xs font-medium text-muted">Heard</h4>
          <p className="max-h-24 overflow-y-auto text-sm">
            {live.transcript}
            {live.interim && <span className="text-muted"> {live.interim}</span>}
          </p>
        </div>
      )}
      {live.error && <Alert>{live.error}</Alert>}
    </section>
  );
}
