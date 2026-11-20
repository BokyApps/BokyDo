import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../../components/ui.js';

/**
 * The stale-revision banner (ADR 0025): the open note was saved elsewhere, so autosaving is
 * paused and the draft stays visible until the user picks a version.
 *
 * The censor-safety rule is part of the contract: "Keep mine" may only go ahead after an extra
 * confirmation when the saved version looks censored, because keeping the draft could bring that
 * plaintext back. The confirmation focuses "Load their version", the safe choice, by default, and
 * is dropped when a fresher saved revision replaces the one it was about.
 *
 * A failed post-409 fetch is its own state: no version can be shown or adopted, so the banner
 * offers "Retry fetch" instead of pretending a cached snapshot is the truth.
 */

export interface NoteConflictBannerProps {
  /** The saved body differs from the draft and looks censored (lenient detector). */
  censorWarning: boolean;
  busy?: boolean;
  /** The post-409 GET failed: offer Retry fetch rather than a version choice. */
  fetchFailed?: boolean;
  /** The saved revision being offered; a change invalidates an open censor confirmation. */
  remoteRevision?: string | null;
  onLoadTheirs: () => void;
  onRetryFetch: () => void;
  /** `confirmedRevision` is the revision the user accepted in the censor confirmation, or null. */
  onKeepMine: (confirmedRevision: string | null) => void;
}

export function NoteConflictBanner({
  censorWarning,
  busy = false,
  fetchFailed = false,
  remoteRevision = null,
  onLoadTheirs,
  onRetryFetch,
  onKeepMine,
}: NoteConflictBannerProps) {
  const { t } = useTranslation();
  // The revision the confirmation belongs to. Deriving "confirming" from it means a fresher
  // remote revision resets the modal question without a state update in an effect.
  const [confirmationRevision, setConfirmationRevision] = useState<string | null>(null);
  const confirmingCensor =
    confirmationRevision !== null && confirmationRevision === (remoteRevision ?? '');
  const confirmation = useRef<HTMLDivElement>(null);
  const keepMine = useRef<HTMLButtonElement>(null);
  const wasConfirming = useRef(false);

  // Focus the safe choice ("Load their version") when the confirmation opens: the action that
  // does not undo a censor elsewhere must be what Enter presses. Going back (or a fresh remote
  // revision) returns focus to "Keep mine", the action the confirmation was about.
  useEffect(() => {
    if (confirmingCensor) {
      wasConfirming.current = true;
      confirmation.current?.querySelector<HTMLButtonElement>('button')?.focus();
      return;
    }
    if (!wasConfirming.current) return;
    wasConfirming.current = false;
    keepMine.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [confirmingCensor]);

  if (fetchFailed) {
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
          {t('notes.conflict.fetchFailedMessage', {
            defaultValue:
              "Saving is paused, but the saved version couldn't be fetched. Your edits stay here.",
          })}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button disabled={busy} onClick={onRetryFetch}>
            {t('notes.conflict.retryFetch', { defaultValue: 'Retry fetch' })}
          </Button>
        </div>
      </div>
    );
  }

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
          <Button variant="danger" disabled={busy} onClick={() => onKeepMine(remoteRevision)}>
            {t('notes.conflict.keepAnyway', { defaultValue: 'Keep mine anyway' })}
          </Button>
          <Button variant="ghost" disabled={busy} onClick={() => setConfirmationRevision(null)}>
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
        <span ref={keepMine} className="contents">
          <Button
            variant="secondary"
            disabled={busy || remoteRevision === null}
            onClick={() => {
              if (censorWarning) setConfirmationRevision(remoteRevision ?? '');
              else onKeepMine(null);
            }}
          >
            {t('notes.conflict.keepMine', { defaultValue: 'Keep mine' })}
          </Button>
        </span>
      </div>
    </div>
  );
}
