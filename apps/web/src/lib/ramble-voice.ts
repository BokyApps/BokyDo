import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { audioUploadType } from './ramble.js';

/*
 * Browser audio for Ramble: the microphone, one standalone recording per chunk, the input level,
 * and Web Speech as the fallback when the server can't transcribe. Nothing here keeps audio:
 * a chunk goes to the caller once, and the caller uploads it and drops it.
 */

/** Length of one recording. Each one is a whole file, so the server can read it on its own. */
export const CHUNK_MS = 4000;

export interface Microphone {
  stream: MediaStream;
  /** Null when the browser has no Web Audio: recording still works, without a meter. */
  analyser: AnalyserNode | null;
  close: () => void;
}

/** Can this browser record chunks at all? If not, voice is offered as dictation instead. */
export function canRecordAudio(): boolean {
  return typeof MediaRecorder !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia);
}

export async function openMicrophone(): Promise<Microphone> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const Context =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  let context: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  try {
    if (Context) {
      context = new Context();
      analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(stream).connect(analyser);
    }
  } catch {
    void context?.close();
    context = null;
    analyser = null;
  }
  return {
    stream,
    analyser,
    close: () => {
      stream.getTracks().forEach((track) => track.stop());
      void context?.close();
    },
  };
}

export function micErrorMessage(err: unknown): string {
  const name = err instanceof DOMException ? err.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Microphone access was blocked. Allow it in your browser settings to use voice.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'No microphone was found.';
  return "The microphone couldn't be started.";
}

export interface Recording {
  /** Resolves when the recording ends (on its own or after `stop`). */
  done: Promise<{ blob: Blob; elapsedMs: number }>;
  stop: () => void;
}

/** One standalone recording of up to `maxMs`. A fresh recorder each time, so the file has headers. */
export function recordChunk(stream: MediaStream, maxMs: number): Recording {
  const recorder = new MediaRecorder(stream);
  const parts: Blob[] = [];
  const startedAt = performance.now();
  const stop = () => {
    window.clearTimeout(timer);
    if (recorder.state !== 'inactive') recorder.stop();
  };
  const done = new Promise<{ blob: Blob; elapsedMs: number }>((resolve, reject) => {
    recorder.addEventListener('dataavailable', (e) => {
      if (e.data.size > 0) parts.push(e.data);
    });
    recorder.addEventListener('stop', () =>
      resolve({
        blob: new Blob(parts, { type: audioUploadType(recorder.mimeType) }),
        elapsedMs: performance.now() - startedAt,
      }),
    );
    recorder.addEventListener('error', () => reject(new Error('recording failed')));
  });
  const timer = window.setTimeout(stop, maxMs);
  recorder.start();
  return { done, stop };
}

/** The input level, 0 to 1, from one frame of the analyser. */
export function inputLevel(analyser: AnalyserNode, buffer: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buffer);
  let sum = 0;
  for (const v of buffer) {
    const x = (v - 128) / 128;
    sum += x * x;
  }
  return Math.min(1, Math.sqrt(sum / buffer.length) * 2);
}

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/** Follows the OS setting, so a live waveform can be swapped for a static meter. */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (notify) => {
      const query = window.matchMedia(REDUCED_MOTION);
      query.addEventListener('change', notify);
      return () => query.removeEventListener('change', notify);
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
  );
}

/** One listening session: the mic, and the recording in progress (if any). */
interface Run {
  wanted: boolean;
  /** Set on unmount: the last chunk is dropped rather than sent after the dialog has closed. */
  discard: boolean;
  recording: Recording | null;
}

export interface VoiceCapture {
  listening: boolean;
  analyser: AnalyserNode | null;
  start: () => void;
  stop: () => void;
}

/**
 * Records in chunks of CHUNK_MS and hands each finished one to `onChunk`, in order. Stopping
 * sends the part being recorded, then releases the microphone.
 */
export function useVoiceCapture(
  onChunk: (audio: Blob, elapsedMs: number) => void,
  onError: (message: string) => void,
): VoiceCapture {
  const [listening, setListening] = useState(false);
  const [analyser, setAnalyser] = useState<AnalyserNode | null>(null);
  const run = useRef<Run | null>(null);
  const handlers = useRef({ onChunk, onError });
  useEffect(() => {
    handlers.current = { onChunk, onError };
  });

  const loop = async (session: Run, mic: Microphone) => {
    setAnalyser(mic.analyser);
    setListening(true);
    try {
      while (session.wanted) {
        const recording = recordChunk(mic.stream, CHUNK_MS);
        session.recording = recording;
        const { blob, elapsedMs } = await recording.done;
        session.recording = null;
        if (!session.discard && blob.size > 0) handlers.current.onChunk(blob, elapsedMs);
      }
    } catch {
      handlers.current.onError(
        'The recording stopped unexpectedly. Check the microphone and try again.',
      );
    } finally {
      mic.close();
      session.recording = null;
      if (run.current === session) {
        run.current = null;
        setAnalyser(null);
        setListening(false);
      }
    }
  };

  const start = () => {
    if (run.current) return;
    const session: Run = { wanted: true, discard: false, recording: null };
    run.current = session;
    openMicrophone().then(
      (mic) => {
        // Released while the browser was asking for the microphone: don't record at all.
        if (!session.wanted) {
          mic.close();
          if (run.current === session) run.current = null;
          return;
        }
        void loop(session, mic);
      },
      (err: unknown) => {
        if (run.current === session) run.current = null;
        handlers.current.onError(micErrorMessage(err));
      },
    );
  };

  const stop = () => {
    const session = run.current;
    if (!session) return;
    session.wanted = false;
    setListening(false);
    session.recording?.stop();
  };

  // Leaving the dialog: stop, and drop what is being recorded. The microphone is released by
  // the loop's own cleanup once the recorder has ended.
  useEffect(() => {
    const current = run;
    return () => {
      const session = current.current;
      if (!session) return;
      session.wanted = false;
      session.discard = true;
      session.recording?.stop();
    };
  }, []);

  return { listening, analyser, start, stop };
}

/** The Web Speech API, as far as Ramble uses it (the browser's own types aren't in the DOM lib). */
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly 0: { readonly transcript: string };
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: ArrayLike<RecognitionResult>;
}
interface RecognitionErrorEvent {
  readonly error: string;
}
export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

/** The browser's recogniser, when it has one. */
export function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/**
 * Dictation into the text box. Final phrases go to `onText`; the words still being heard are
 * shown as `interim`. The caller must have shown the vendor notice before calling `start`.
 */
export function useDictation(onText: (text: string) => void) {
  const [active, setActive] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const recogniser = useRef<SpeechRecognitionLike | null>(null);
  const handler = useRef(onText);
  useEffect(() => {
    handler.current = onText;
  });

  const start = () => {
    const Ctor = speechRecognitionCtor();
    if (!Ctor || recogniser.current) return;
    const r = new Ctor();
    r.lang = navigator.language;
    r.continuous = true;
    r.interimResults = true;
    r.onresult = (e) => {
      let final = '';
      let pending = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        const said = result?.[0]?.transcript ?? '';
        if (result?.isFinal) final += said;
        else pending += said;
      }
      if (final.trim()) handler.current(final.trim());
      setInterim(pending.trim());
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      setError(
        e.error === 'not-allowed' || e.error === 'service-not-allowed'
          ? 'Speech recognition was blocked. Allow the microphone for this site to dictate.'
          : 'Dictation stopped. Try again, or type instead.',
      );
    };
    r.onend = () => {
      if (recogniser.current !== r) return;
      recogniser.current = null;
      setActive(false);
      setInterim('');
    };
    recogniser.current = r;
    setError(null);
    try {
      r.start();
      setActive(true);
    } catch {
      recogniser.current = null;
      setError("Dictation couldn't start. Try again, or type instead.");
    }
  };

  const stop = () => {
    const r = recogniser.current;
    recogniser.current = null;
    r?.stop();
    setActive(false);
    setInterim('');
  };

  useEffect(() => {
    const current = recogniser;
    return () => {
      current.current?.abort();
      current.current = null;
    };
  }, []);

  return { active, interim, error, start, stop };
}
