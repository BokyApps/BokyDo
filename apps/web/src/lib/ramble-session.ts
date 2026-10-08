import type { RambleOpSummary, RambleResolvedTask } from '@bokydo/shared';
import { useCallback, useMemo, useRef, useState } from 'react';
import { ApiError } from './api.js';
import {
  buildCommitBody,
  changeKinds,
  commitDraft,
  commitFailure,
  commitReasonText,
  createSerialQueue,
  draftForExtract,
  extractDraft,
  mergeExtraction,
  reconcileOverrides,
  summarizeOps,
  taskCountText,
  textProblem,
  transcribeChunk,
} from './ramble.js';
import { errorMessage } from './messages.js';
import { useStore } from './sync.js';
import { useToast } from './toasts.js';

/** State that background work also reads: the ref always holds the latest value. */
function useLatest<T>(initial: T) {
  const [value, setValue] = useState(initial);
  const ref = useRef(value);
  const set = useCallback((next: T) => {
    ref.current = next;
    setValue(next);
  }, []);
  return [value, set, ref] as const;
}

export interface RambleFailure {
  ref: string;
  message: string;
}

/**
 * The Ramble draft and everything that changes it: typed text, transcribed voice, the model's
 * extractions (one at a time), the user's edits in review, and the commit. It lives above the
 * dialog, so closing the dialog by accident (Escape, a click outside) keeps the draft.
 */
export function useRambleSession() {
  const store = useStore();
  const toast = useToast();
  const [queues] = useState(() => ({
    extract: createSerialQueue(),
    transcribe: createSerialQueue(),
  }));
  const [text, setText] = useState('');
  const [draft, setDraft, draftRef] = useLatest<RambleResolvedTask[]>([]);
  const [overrides, setOverrides, overridesRef] = useLatest<Record<string, string>>({});
  const [lastOps, setLastOps] = useState<RambleOpSummary[]>([]);
  const [transcript, setTranscript] = useState<string[]>([]);
  const [extracting, setExtracting] = useState(0);
  const [transcribing, setTranscribing] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [failure, setFailure] = useState<RambleFailure | null>(null);
  const [committing, setCommitting] = useState(false);
  /** Bumped on discard and create: work queued before that is dropped, not merged into a new draft. */
  const epoch = useRef(0);

  const extract = (chunk: string): Promise<boolean> => {
    const started = epoch.current;
    setExtracting((n) => n + 1);
    return queues.extract.run(async () => {
      try {
        if (started !== epoch.current) return false;
        // Read the draft when the call starts, not when it was queued: earlier calls have landed.
        const sent = draftForExtract(draftRef.current);
        const answer = await extractDraft(chunk, sent);
        if (started !== epoch.current) return false;
        const merged = mergeExtraction({ sent, received: answer.draft, current: draftRef.current });
        setOverrides(reconcileOverrides(overridesRef.current, sent, merged));
        setDraft(merged);
        setLastOps(answer.ops);
        setError(null);
        return true;
      } catch (err) {
        if (started === epoch.current) setError(errorMessage(err));
        return false;
      } finally {
        setExtracting((n) => n - 1);
      }
    });
  };

  /** Typed text: extract it with the draft. On success the box is emptied (unless typed into since). */
  const submitText = () => {
    const chunk = text.trim();
    if (!chunk) return;
    const problem = textProblem(chunk);
    if (problem) {
      setError(problem);
      return;
    }
    void extract(chunk).then((ok) => {
      if (ok) setText((t) => (t.trim() === chunk ? '' : t));
    });
  };

  /** One recorded chunk: transcribe it, then extract what it said. Chunks keep their order. */
  const heard = (audio: Blob, elapsedMs: number) => {
    const started = epoch.current;
    setTranscribing((n) => n + 1);
    void queues.transcribe.run(async () => {
      try {
        if (started !== epoch.current) return;
        const { text: words } = await transcribeChunk(audio, elapsedMs);
        const piece = words.trim();
        if (piece && started === epoch.current) {
          setTranscript((list) => [...list, piece]);
          void extract(piece);
        }
      } catch (err) {
        if (started === epoch.current) setError(errorMessage(err));
      } finally {
        setTranscribing((n) => n - 1);
      }
    });
  };

  const setContent = (ref: string, content: string) =>
    setDraft(draftRef.current.map((t) => (t.ref === ref ? { ...t, content } : t)));

  const setProject = (ref: string, projectId: string) =>
    setOverrides({ ...overridesRef.current, [ref]: projectId });

  const remove = (ref: string) => {
    setDraft(draftRef.current.filter((t) => t.ref !== ref));
    const { [ref]: _removed, ...rest } = overridesRef.current;
    setOverrides(rest);
  };

  const clear = () => {
    epoch.current += 1;
    setDraft([]);
    setOverrides({});
    setLastOps([]);
    setTranscript([]);
    setText('');
  };

  const discard = () => {
    clear();
    setError(null);
    setFailure(null);
  };

  /** Create the reviewed tasks: all of them, or none. On success the draft is cleared. */
  const create = async (): Promise<boolean> => {
    setCommitting(true);
    setError(null);
    setFailure(null);
    try {
      const answer = await commitDraft(buildCommitBody(draftRef.current, overridesRef.current));
      toast({ message: `Created ${taskCountText(answer.created.length)}.` });
      void store.pull();
      clear();
      return true;
    } catch (err) {
      const named =
        err instanceof ApiError && err.code === 'not_created' ? commitFailure(err.body) : null;
      if (named) setFailure({ ref: named.ref, message: commitReasonText(named.reason) });
      else setError(errorMessage(err));
      return false;
    } finally {
      setCommitting(false);
    }
  };

  const changes = useMemo(() => changeKinds(lastOps), [lastOps]);

  return {
    text,
    setText,
    draft,
    overrides,
    changes,
    lastChange: summarizeOps(lastOps),
    transcript,
    extracting: extracting > 0,
    transcribing: transcribing > 0,
    error,
    setError,
    failure,
    committing,
    submitText,
    heard,
    setContent,
    setProject,
    remove,
    discard,
    create,
  };
}
