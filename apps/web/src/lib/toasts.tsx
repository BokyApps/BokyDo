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
    setTimeout(() => setToasts((list) => list.filter((x) => x.id !== id)), t.action ? 6000 : 4000);
  }, []);
  const dismiss = (id: number) => setToasts((list) => list.filter((x) => x.id !== id));
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
          <div
            key={t.id}
            role={t.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex items-center gap-4 rounded-lg px-4 py-3 text-sm shadow-lg ${t.tone === 'error' ? 'bg-danger text-on-accent' : 'bg-fg text-bg'}`}
          >
            <span>{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="font-semibold underline-offset-2 hover:underline"
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
