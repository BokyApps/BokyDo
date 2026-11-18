import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui.js';

/**
 * The stale-revision banner (ADR 0025): the open note was saved elsewhere, so autosaving is
 * paused and the draft stays visible until the user picks a version.
 *
 * The censor-safety rule is part of the contract: "Keep mine" may only go ahead after an extra
 * confirmation when the saved version contains censored text the draft does not, because keeping
 * the draft would bring that plaintext back. The confirmation focuses "Load their version", the
 * safe choice, by default.
 */

export interface NoteConflictBannerProps {
  /** The remote body has a censor token this draft lacks (keeping mine restores plaintext). */
  censorWarning: boolean;
  busy?: boolean;
  onLoadTheirs: () => void;
  onKeepMine: () => void;
  onCopyMine: () => void;
}

export function NoteConflictBanner({
  censorWarning,
  busy = false,
  onLoadTheirs,
  onKeepMine,
  onCopyMine,
}: NoteConflictBannerProps) {
  const { t } = useTranslation();
  const [confirmingCensor, setConfirmingCensor] = useState(false);
  const confirmation = useRef<HTMLDivElement>(null);

  // Focus the safe choice ("Load their version") when the confirmation opens: the action that
  // does not undo a censor elsewhere must be what Enter presses.
  useEffect(() => {
    if (!confirmingCensor) return;
    confirmation.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [confirmingCensor]);

  if (confirmingCensor) {
    return (
      <div
        ref={confirmation}
        role="alert"
        aria-live="assertive"
        className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-fg"
      >
        <p className="font-semibold">
          {t('notes.conflict.censoredTitle', {
            defaultValue: 'This would bring back censored text',
          })}
        </p>
        <p className="mt-1">
          {t('notes.conflict.censoredMessage', {
            defaultValue:
              'The saved version has censored text that your draft does not. Keeping yours would bring back text that was censored elsewhere.',
          })}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="secondary" disabled={busy} onClick={onLoadTheirs}>
            {t('notes.conflict.loadTheirs', { defaultValue: 'Load their version' })}
          </Button>
          <Button variant="danger" disabled={busy} onClick={onKeepMine}>
            {t('notes.conflict.keepAnyway', { defaultValue: 'Keep mine anyway' })}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmingCensor(false)}>
            {t('notes.conflict.cancel', { defaultValue: 'Back' })}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="rounded-lg border border-warning/50 bg-warning/10 px-3 py-2 text-sm text-fg"
    >
      <p className="font-semibold">
        {t('notes.conflict.title', { defaultValue: 'This note changed elsewhere' })}
      </p>
      <p className="mt-1">
        {t('notes.conflict.message', {
          defaultValue:
            'Saving is paused until you choose. Your edits stay here. Keeping yours replaces the version saved elsewhere.',
        })}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" disabled={busy} onClick={onLoadTheirs}>
          {t('notes.conflict.loadTheirs', { defaultValue: 'Load their version' })}
        </Button>
        <Button
          variant="secondary"
          disabled={busy}
          onClick={() => {
            if (censorWarning) setConfirmingCensor(true);
            else onKeepMine();
          }}
        >
          {t('notes.conflict.keepMine', { defaultValue: 'Keep mine' })}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCopyMine}>
          {t('notes.conflict.copyMine', { defaultValue: 'Copy mine' })}
        </Button>
      </div>
    </div>
  );
}
