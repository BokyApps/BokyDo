import { useEffect, useId, useRef, useState } from 'react';
import { inputLevel, useDictation, usePrefersReducedMotion } from '../lib/ramble-voice.js';
import { MicIcon } from './icons.js';
import { Alert, Button } from './ui.js';

/** The look of a toggle that shows whether it is on (text and border, not colour alone). */
const toggleClass = (on: boolean) =>
  `inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium text-fg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
    on ? 'border-danger/50 bg-danger/10' : 'border-line bg-surface hover:bg-surface-alt'
  }`;

interface VoiceProps {
  listening: boolean;
  analyser: AnalyserNode | null;
  start: () => void;
  stop: () => void;
}

/** Record voice. A click toggles; holding Space while the button has focus records. */
export function VoiceControls({ listening, analyser, start, stop }: VoiceProps) {
  const hint = useId();
  const holding = useRef(false);
  const release = () => {
    if (!holding.current) return;
    holding.current = false;
    stop();
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          aria-pressed={listening}
          aria-describedby={hint}
          className={toggleClass(listening)}
          onClick={() => (listening ? stop() : start())}
          onKeyDown={(e) => {
            if (e.key !== ' ') return;
            // Space is push-to-talk here, not a click: the button must not fire on release.
            e.preventDefault();
            if (!e.repeat && !listening && !holding.current) {
              holding.current = true;
              start();
            }
          }}
          onKeyUp={(e) => {
            if (e.key !== ' ') return;
            e.preventDefault();
            release();
          }}
          onBlur={release}
        >
          <MicIcon /> Record voice
        </button>
        <p id={hint} className="text-xs text-muted">
          Click, or hold Space, to talk. Speech is sent in short pieces as you go.
        </p>
      </div>
      {listening && <Meter analyser={analyser} />}
    </div>
  );
}

/** A live waveform, or a static level bar when the OS asks for reduced motion. */
function Meter({ analyser }: { analyser: AnalyserNode | null }) {
  const reduced = usePrefersReducedMotion();
  return reduced ? <LevelBar analyser={analyser} /> : <Waveform analyser={analyser} />;
}

function LevelBar({ analyser }: { analyser: AnalyserNode | null }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    if (!analyser) return;
    const buffer = new Uint8Array(analyser.fftSize);
    // A few updates a second: a level, not an animation.
    const id = window.setInterval(() => setLevel(inputLevel(analyser, buffer)), 200);
    return () => window.clearInterval(id);
  }, [analyser]);
  return (
    <div aria-hidden className="h-3 w-full max-w-xs overflow-hidden rounded-full bg-surface-alt">
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-200"
        style={{ width: `${Math.round(level * 100)}%` }}
      />
    </div>
  );
}

function Waveform({ analyser }: { analyser: AnalyserNode | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const el = canvas.current;
    const ctx = el?.getContext('2d');
    if (!analyser || !el || !ctx) return;
    const buffer = new Uint8Array(analyser.fftSize);
    let frame = 0;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(el.clientWidth * dpr);
      const height = Math.round(el.clientHeight * dpr);
      // Resizing the canvas clears it, so only do it when the size changed.
      if (el.width !== width) el.width = width;
      if (el.height !== height) el.height = height;
      analyser.getByteTimeDomainData(buffer);
      ctx.clearRect(0, 0, width, height);
      ctx.strokeStyle = getComputedStyle(el).color;
      ctx.lineWidth = 2 * dpr;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      buffer.forEach((v, i) => {
        const x = (i / (buffer.length - 1)) * width;
        const y = (v / 255) * height;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      frame = requestAnimationFrame(draw);
    };
    draw();
    return () => cancelAnimationFrame(frame);
  }, [analyser]);
  return <canvas ref={canvas} aria-hidden className="h-12 w-full max-w-md text-accent" />;
}

/** Remembered per viewer, so the notice is shown before the first dictation only. */
const NOTICE_KEY = 'bokydo.ramble.speechNotice';

function noticeSeen(): boolean {
  try {
    return window.localStorage.getItem(NOTICE_KEY) === 'seen';
  } catch {
    return false;
  }
}

function markNoticeSeen(): void {
  try {
    window.localStorage.setItem(NOTICE_KEY, 'seen');
  } catch {
    // A private window can't remember it: the notice comes back next time.
  }
}

/** Dictation with the browser's own recogniser, into the text box. Shown only without server STT. */
export function DictateControl({ onText }: { onText: (text: string) => void }) {
  const dictation = useDictation(onText);
  const [seen, setSeen] = useState(noticeSeen);
  const [asking, setAsking] = useState(false);
  const toggle = () => {
    if (dictation.active) dictation.stop();
    else if (seen) dictation.start();
    else setAsking(true);
  };
  return (
    <div className="space-y-2">
      <button
        type="button"
        aria-pressed={dictation.active}
        className={toggleClass(dictation.active)}
        onClick={toggle}
      >
        <MicIcon /> Dictate
      </button>
      {asking && (
        <div
          role="region"
          aria-label="Before you dictate"
          className="space-y-3 rounded-lg border border-line bg-surface-alt p-3 text-sm"
        >
          <p>
            Your browser's speech recognition sends audio to its vendor (Chrome sends it to Google),
            not to this server.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                markNoticeSeen();
                setSeen(true);
                setAsking(false);
                dictation.start();
              }}
            >
              Continue
            </Button>
            <Button variant="secondary" onClick={() => setAsking(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
      {dictation.active && dictation.interim && (
        <p className="text-sm text-muted">{dictation.interim}</p>
      )}
      {dictation.error && <Alert>{dictation.error}</Alert>}
    </div>
  );
}
