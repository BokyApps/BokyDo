import { useId, useMemo } from 'react';
import { useConfirm } from '../lib/confirm.js';
import {
  appendSpoken,
  draftProblem,
  rambleStatus,
  taskCountText,
  writableProjects,
} from '../lib/ramble.js';
import { useRambleSession } from '../lib/ramble-session.js';
import { canRecordAudio, speechRecognitionCtor, useVoiceCapture } from '../lib/ramble-voice.js';
import { useSyncState } from '../lib/sync.js';
import { DictateControl, VoiceControls } from './RambleVoice.js';
import { RambleReview } from './RambleReview.js';
import { Alert, Button, Dialog, TextArea } from './ui.js';

/**
 * Ramble: a typed or spoken brain-dump becomes a draft of tasks. Nothing is created until the
 * user presses Create. The session lives above the dialog, so the draft survives closing it.
 * Mounted only when the server offers ramble.extract.
 */
export function RambleDialog({
  open,
  onClose,
  voice,
}: {
  open: boolean;
  onClose: () => void;
  /** The server can transcribe audio (ramble.transcribe). Otherwise dictation may still work. */
  voice: boolean;
}) {
  const session = useRambleSession();
  return (
    <Dialog open={open} onClose={onClose} title="Ramble" wide>
      <RambleBody session={session} voice={voice} onClose={onClose} />
    </Dialog>
  );
}

type Session = ReturnType<typeof useRambleSession>;

function RambleBody({
  session,
  voice,
  onClose,
}: {
  session: Session;
  voice: boolean;
  onClose: () => void;
}) {
  const state = useSyncState();
  const confirm = useConfirm();
  const projects = useMemo(() => writableProjects(state.projects.values()), [state.projects]);
  const inboxId = state.user?.inboxProjectId ?? null;
  // The microphone lives with the dialog: closing it stops the recording (see useVoiceCapture).
  const mic = useVoiceCapture(session.heard, session.setError);
  // Voice needs the server's transcription and a browser that can record. Otherwise the
  // browser's own dictation (if it has one) fills the text box.
  const recording = voice && canRecordAudio();
  const dictation = !recording && speechRecognitionCtor() !== null;
  const createHintId = useId();
  const draftHeading = useId();
  // A removed row (or a discarded draft) takes its focus with it: move it to the Draft heading.
  // A timeout, so it lands after any confirm dialog has handed focus back.
  const focusDraft = () =>
    window.setTimeout(() => document.getElementById(draftHeading)?.focus(), 0);

  const count = session.draft.length;
  const problem = draftProblem(session.draft);
  const waiting = session.extracting || session.transcribing;
  const canCreate =
    count > 0 && problem === null && !mic.listening && !waiting && !session.committing;
  const hint = mic.listening
    ? 'Stop recording to create these tasks.'
    : waiting
      ? 'Wait for the draft to finish updating.'
      : (problem ?? (count === 0 ? 'Add something to the draft first.' : null));
  const status = rambleStatus({
    listening: mic.listening,
    transcribing: session.transcribing,
    extracting: session.extracting,
    count,
    lastChange: session.lastChange,
  });

  const failedTask = session.failure
    ? session.draft.find((t) => t.ref === session.failure?.ref)
    : undefined;
  const failedPosition = failedTask ? session.draft.indexOf(failedTask) + 1 : 0;

  const discard = async () => {
    if (count > 0) {
      const ok = await confirm({
        title: 'Discard this draft?',
        message: `The ${taskCountText(count)} in it will be lost. Nothing has been created yet.`,
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!ok) return;
    }
    mic.stop();
    session.discard();
    focusDraft();
  };

  const create = async () => {
    if (await session.create()) onClose();
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Say or type what is on your mind. Each piece you add updates the draft below. Nothing is
        created until you press Create.
      </p>

      <TextArea
        label="What's on your mind?"
        hint="Press Ctrl+Enter (or Cmd+Enter) to add this text to the draft."
        rows={4}
        placeholder="For example: call the dentist before Friday, buy milk, and ask Ana about the budget"
        value={session.text}
        onChange={(e) => session.setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            session.submitText();
          }
        }}
      />

      <div className="flex flex-wrap items-start gap-3">
        <Button onClick={session.submitText} disabled={session.text.trim() === ''}>
          Extract
        </Button>
        {dictation && (
          <DictateControl onText={(piece) => session.setText((t) => appendSpoken(t, piece))} />
        )}
      </div>

      {recording && (
        <VoiceControls
          listening={mic.listening}
          analyser={mic.analyser}
          start={mic.start}
          stop={mic.stop}
        />
      )}

      <p aria-live="polite" className="text-sm text-muted">
        {status}
      </p>
      {session.error && <Alert>{session.error}</Alert>}
      {session.failure && failedTask && (
        <Alert>
          Task {failedPosition}, “{failedTask.content}”, could not be created.{' '}
          {session.failure.message} Nothing was created. Fix that task and try again.
        </Alert>
      )}

      {session.transcript.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-medium">Heard</h3>
          <p className="max-h-24 overflow-y-auto text-sm text-muted">
            {session.transcript.join(' ')}
          </p>
        </div>
      )}

      <section className="space-y-3">
        <h3 id={draftHeading} tabIndex={-1} className="text-sm font-semibold focus:outline-none">
          Draft
        </h3>
        {count === 0 ? (
          <p className="text-sm text-muted">
            No tasks yet. Tasks you say or type appear here for review.
          </p>
        ) : (
          <RambleReview
            draft={session.draft}
            overrides={session.overrides}
            changes={session.changes}
            projects={projects}
            inboxId={inboxId}
            failedRef={session.failure?.ref ?? null}
            onContent={session.setContent}
            onProject={session.setProject}
            onRemove={(ref) => {
              session.remove(ref);
              focusDraft();
            }}
          />
        )}
      </section>

      <div className="space-y-3 border-t border-line pt-4">
        {hint && (
          <p id={createHintId} className="text-xs text-muted">
            {hint}
          </p>
        )}
        <div className="flex flex-wrap items-center justify-end gap-2">
          {(count > 0 || session.text.trim() !== '') && (
            <Button variant="ghost" className="mr-auto text-danger" onClick={() => void discard()}>
              Discard draft
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            onClick={() => void create()}
            disabled={!canCreate}
            busy={session.committing}
            aria-describedby={hint ? createHintId : undefined}
          >
            {count > 0 ? `Create ${taskCountText(count)}` : 'Create'}
          </Button>
        </div>
      </div>
    </div>
  );
}
