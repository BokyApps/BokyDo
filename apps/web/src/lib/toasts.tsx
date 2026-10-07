import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';

export interface Toast {
  id: number;
  message: string;
  tone?: 'info' | 'error';
  action?: { label: string; onClick: () => void };
}

type Show = (t: Omit<Toast, 'id'>) => void;
const ToastContext = createContext<Show>(() => undefined);
let next = 1;

/** Bottom-left toasts; actions (e.g. Undo) stay available for 6 seconds. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback<Show>((t) => {
    const id = next++;
    setToasts((list) => [...list.slice(-2), { ...t, id }]);
  }, []);
  const dismiss = useCallback(
    (id: number) => setToasts((list) => list.filter((x) => x.id !== id)),
    [],
  );
  // Ctrl/Cmd+Z runs the newest toast's action (Undo), as in Todoist.
  const latest = [...toasts].reverse().find((t) => t.action);
  useEffect(() => {
    if (!latest?.action) return;
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing) {
        e.preventDefault();
        latest.action?.onClick();
        setToasts((list) => list.filter((x) => x.id !== latest.id));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [latest]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div
        className="pointer-events-none fixed bottom-4 left-4 z-50 flex flex-col gap-2"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <ToastView key={t.id} toast={t} dismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

/**
 * One toast. It stays while the pointer is over it or focus is inside it, and an actionable one
 * (Undo) lasts longer, so nobody is rushed (WCAG 2.2.1). The dismiss button closes it at once.
 */
function ToastView({ toast, dismiss }: { toast: Toast; dismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  useEffect(() => {
    if (paused) return;
    const timer = setTimeout(() => dismiss(toast.id), toast.action ? 10_000 : 6_000);
    return () => clearTimeout(timer);
  }, [paused, toast.id, toast.action, dismiss]);
  const error = toast.tone === 'error';
  return (
    <div
      role={error ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className={`pointer-events-auto flex items-center gap-4 rounded-lg px-4 py-3 text-sm shadow-lg ${error ? 'bg-danger text-on-accent' : 'bg-fg text-bg'}`}
    >
      <span>{toast.message}</span>
      {toast.action && (
        <button
          type="button"
          className="font-semibold underline underline-offset-2"
          onClick={() => {
            toast.action?.onClick();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        aria-label="Dismiss notification"
        className="-mr-2 rounded px-2 text-lg leading-none opacity-80 hover:opacity-100"
        onClick={() => dismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}
