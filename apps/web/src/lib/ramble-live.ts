import type {
  RambleDraftTask,
  RambleLiveCloseReason,
  RambleLiveServerMessage,
  RambleOpSummary,
  RambleResolvedTask,
} from '@bokydo/shared';
import { useCallback, useEffect, useRef, useState } from 'react';

/*
 * Live Ramble: the browser streams microphone audio to the server over a WebSocket, and the
 * server holds the provider key and talks to OpenAI Realtime / Gemini Live. The browser never
 * sees the key, and it never speaks a provider's protocol: it sends audio and control frames,
 * and the server answers with a transcript and the draft.
 *
 * The audio is raw PCM16 at the rate the provider wants (24 kHz for OpenAI, 16 kHz for Gemini),
 * base64-encoded in small frames. The capture is a plain Web Audio graph, so the client depends
 * on no one vendor.
 */

/** The relay's address on this origin. The API and the page are served by the same server. */
export function liveSocketUrl(
  location: { protocol: string; host: string } = window.location,
): string {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/api/v1/ramble/live`;
}

/** Float samples to signed 16-bit, the format the providers take. */
export function floatToPcm16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i] ?? 0));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

/**
 * Base64 of raw PCM16 bytes. The browser has no Buffer, so the bytes go through a binary string
 * in chunks (one big spread would blow the call stack).
 */
export function pcmToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x2000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x2000));
  }
  return btoa(binary);
}

/**
 * Resample to another rate, for a browser that ignored the rate we asked for. Linear is enough
 * for speech: the provider transcribes it, it does not listen to it.
 */
export function resampleLinear(input: Float32Array, from: number, to: number): Float32Array {
  if (from === to || input.length === 0 || from <= 0 || to <= 0) return input;
  const out = new Float32Array(Math.max(1, Math.round((input.length * to) / from)));
  const ratio = (input.length - 1) / Math.max(1, out.length - 1);
  for (let i = 0; i < out.length; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(input.length - 1, left + 1);
    const mix = pos - left;
    out[i] = (input[left] ?? 0) * (1 - mix) + (input[right] ?? 0) * mix;
  }
  return out;
}

/** The microphone, captured as PCM16 frames. */
export interface MicCapture {
  /** Releases the microphone and the audio graph. */
  close: () => void;
}

/** How much audio one frame holds. At 24 kHz this is about 170 ms. */
const FRAME_SAMPLES = 4096;

type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** The Web Audio context constructor, with the old Safari name. */
function audioContextCtor(): AudioContextCtor | null {
  const w = window as Window & { webkitAudioContext?: AudioContextCtor };
  return window.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Open the microphone and stream it as base64 PCM16 at `sampleRate`. The browser resamples to
 * the rate we ask for; if it won't, the frames are resampled here.
 *
 * A ScriptProcessor is used rather than an AudioWorklet: it needs no extra file, and it is
 * enough for a voice stream. An AudioWorklet is the tidier answer if the live mode grows.
 */
export async function openLiveMic(
  sampleRate: number,
  onFrame: (base64: string) => void,
): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const Ctor = audioContextCtor();
  if (!Ctor) {
    stream.getTracks().forEach((track) => track.stop());
    throw new Error('This browser cannot record live audio.');
  }
  let context: AudioContext;
  try {
    context = new Ctor({ sampleRate });
  } catch {
    context = new Ctor();
  }
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(FRAME_SAMPLES, 1, 1);
  // The graph has to reach the destination for the processor to run; a muted gain keeps the
  // microphone out of the speakers.
  const muted = context.createGain();
  muted.gain.value = 0;
  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0);
    const rate = context.sampleRate;
    const samples = rate === sampleRate ? input : resampleLinear(input, rate, sampleRate);
    onFrame(pcmToBase64(floatToPcm16(samples)));
  };
  source.connect(processor);
  processor.connect(muted);
  muted.connect(context.destination);
  void context.resume();
  return {
    close: () => {
      processor.onaudioprocess = null;
      try {
        source.disconnect();
        processor.disconnect();
        muted.disconnect();
      } catch {
        // The graph may already be torn down.
      }
      stream.getTracks().forEach((track) => track.stop());
      void context.close();
    },
  };
}

/** The bit of the browser's WebSocket the relay client needs. */
export interface LiveSocket {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

const OPEN = 1;

/** What the server says, in words the user can act on. */
const ERROR_TEXT: Record<string, string> = {
  ai_not_configured: 'No live model is set up. Choose one in Settings → AI.',
  not_configured: 'No live model is set up. Choose one in Settings → AI.',
  ai_budget_exceeded: 'The AI budget for this month is used up.',
  budget_exceeded: 'The AI budget for this month is used up.',
  invalid_message: 'The server did not understand a message.',
  unauthorized: 'Your sign-in expired, so the live session was closed.',
  provider_error: 'The live model stopped. Try again.',
  too_much_audio: 'That was too much audio for one live session.',
  session_too_long: 'The live session reached its time limit.',
  connection_failed: 'The live session could not be opened. Check your connection.',
  microphone: 'The microphone could not be started. Allow it and try again.',
};

export const liveErrorText = (code: string): string =>
  ERROR_TEXT[code] ?? 'The live session stopped unexpectedly.';

/** Why the session ended, in words. */
const CLOSE_TEXT: Record<RambleLiveCloseReason, string> = {
  done: '',
  session_too_long: 'The live session reached its time limit.',
  too_much_audio: 'That was too much audio for one live session.',
  budget_exceeded: 'The AI budget for this month is used up.',
  unauthorized: 'Your sign-in expired, so the live session was closed.',
  not_configured: 'No live model is set up. Choose one in Settings → AI.',
  provider_error: 'The live model stopped.',
  client_closed: '',
};

export const liveCloseText = (reason: RambleLiveCloseReason): string =>
  CLOSE_TEXT[reason] ?? 'The live session ended.';

export type LivePhase = 'idle' | 'connecting' | 'live' | 'stopping';

export interface LiveRambleOptions {
  /** The model edited the draft: hand it over. */
  onDraft: (draft: RambleResolvedTask[], ops: RambleOpSummary[]) => void;
  /** Something went wrong, in a sentence the user can act on. */
  onError: (message: string) => void;
  /** The session ended (whether the user stopped it or the server did). */
  onEnd: (reason: RambleLiveCloseReason) => void;
  /** The draft the user already has: sent first, so live edits it instead of starting over. */
  startDraft?: () => RambleDraftTask[];
}

export interface LiveRamble {
  phase: LivePhase;
  /** What the model heard, as far as it is confirmed. */
  transcript: string;
  /** The words being heard right now, not confirmed yet. */
  interim: string;
  error: string | null;
  start: () => void;
  stop: () => void;
}

/**
 * The live session: a WebSocket to the relay, and the microphone once the relay says which
 * sample rate to record at. Everything is torn down when the component goes away.
 */
export function useLiveRamble(options: LiveRambleOptions): LiveRamble {
  const [phase, setPhase] = useState<LivePhase>('idle');
  const [transcript, setTranscript] = useState('');
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const socket = useRef<LiveSocket | null>(null);
  const mic = useRef<MicCapture | null>(null);
  const handlers = useRef(options);
  useEffect(() => {
    handlers.current = options;
  });

  const teardown = useCallback(() => {
    mic.current?.close();
    mic.current = null;
    const open = socket.current;
    socket.current = null;
    if (open) {
      open.onmessage = null;
      open.onerror = null;
      open.onclose = null;
      if (open.readyState === OPEN) open.close(1000, 'done');
      else open.close();
    }
  }, []);

  const start = useCallback(() => {
    if (socket.current) return;
    setError(null);
    setTranscript('');
    setInterim('');
    setPhase('connecting');
    const ws = new WebSocket(liveSocketUrl()) as unknown as LiveSocket;
    socket.current = ws;
    ws.onopen = () => {
      const draft = handlers.current.startDraft?.() ?? [];
      ws.send(JSON.stringify({ type: 'start', draft }));
    };
    ws.onerror = () => {
      if (socket.current !== ws) return;
      setError(liveErrorText('connection_failed'));
      setPhase('idle');
    };
    ws.onclose = () => {
      if (socket.current !== ws) return;
      socket.current = null;
      mic.current?.close();
      mic.current = null;
      setPhase('idle');
    };
    ws.onmessage = (event) => {
      if (socket.current !== ws) return;
      const message = parseServerMessage(event.data);
      if (!message) {
        setError(liveErrorText('invalid_message'));
        return;
      }
      switch (message.type) {
        case 'ready':
          setPhase('live');
          openLiveMic(message.sampleRate, (frame) => {
            if (socket.current === ws && ws.readyState === OPEN) {
              ws.send(JSON.stringify({ type: 'audio', data: frame }));
            }
          }).then(
            (capture) => {
              // The session may have ended while the browser was asking for the microphone.
              if (socket.current !== ws) {
                capture.close();
                return;
              }
              mic.current = capture;
            },
            () => {
              if (socket.current !== ws) return;
              setError(liveErrorText('microphone'));
              setPhase('idle');
              ws.close(1000, 'no microphone');
            },
          );
          return;
        case 'transcript':
          if (message.final) {
            setTranscript((text) => (text ? `${text} ${message.text}` : message.text));
            setInterim('');
          } else {
            setInterim(message.text);
          }
          return;
        case 'draft':
          handlers.current.onDraft(message.draft, message.ops);
          return;
        case 'error':
          setError(liveErrorText(message.code));
          handlers.current.onError(liveErrorText(message.code));
          return;
        case 'closed':
          setPhase('idle');
          handlers.current.onEnd(message.reason);
          return;
      }
    };
  }, []);

  const stop = useCallback(() => {
    const ws = socket.current;
    if (!ws) return;
    setPhase('stopping');
    mic.current?.close();
    mic.current = null;
    if (ws.readyState === OPEN) ws.send(JSON.stringify({ type: 'stop' }));
    // The server closes the socket when it is done; this is only a backstop.
    window.setTimeout(() => {
      if (socket.current === ws && ws.readyState === OPEN) ws.close(1000, 'done');
    }, 5000);
  }, []);

  useEffect(() => teardown, [teardown]);

  return { phase, transcript, interim, error, start, stop };
}

/** The server's frame, or null when it is not one we understand. */
export function parseServerMessage(data: unknown): RambleLiveServerMessage | null {
  if (typeof data !== 'string') return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== 'object' || value === null) return null;
  const type = (value as { type?: unknown }).type;
  if (typeof type !== 'string') return null;
  switch (type) {
    case 'ready': {
      const sampleRate = (value as { sampleRate?: unknown }).sampleRate;
      if (typeof sampleRate !== 'number' || sampleRate <= 0) return null;
      return { type: 'ready', sampleRate };
    }
    case 'transcript': {
      const text = (value as { text?: unknown }).text;
      if (typeof text !== 'string') return null;
      const final = (value as { final?: unknown }).final;
      return { type: 'transcript', text, final: final === true };
    }
    case 'draft': {
      const draft = (value as { draft?: unknown }).draft;
      const ops = (value as { ops?: unknown }).ops;
      if (!Array.isArray(draft) || !Array.isArray(ops)) return null;
      return { type: 'draft', draft: draft as RambleResolvedTask[], ops: ops as RambleOpSummary[] };
    }
    case 'error': {
      const code = (value as { code?: unknown }).code;
      if (typeof code !== 'string') return null;
      return { type: 'error', code };
    }
    case 'closed': {
      const reason = (value as { reason?: unknown }).reason;
      if (typeof reason !== 'string') return null;
      return { type: 'closed', reason: reason as RambleLiveCloseReason };
    }
    default:
      return null;
  }
}
