import { useEffect, useRef, useState } from 'react';
import { Button } from './ui.js';

/**
 * Registers the service worker and offers "A new version is ready" when one is waiting.
 * It never reloads on its own: the user decides, so a page running old code can't be swapped
 * under a queued write. On Reload the waiting worker is told to skip waiting and the page
 * reloads once the new worker takes control.
 */
export function UpdatePrompt() {
  const [registration, setRegistration] = useState<ServiceWorkerRegistration | null>(null);
  const asked = useRef(false);

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    let disposed = false;
    let reg: ServiceWorkerRegistration | null = null;
    const offer = () => {
      // No prompt on the very first install (there is no page old enough to worry about).
      if (!disposed && reg?.waiting && navigator.serviceWorker.controller) setRegistration(reg);
    };
    void navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((result) => {
        if (disposed) return;
        reg = result;
        if (reg.waiting) offer();
        reg.addEventListener('updatefound', () => {
          const installing = reg?.installing;
          installing?.addEventListener('statechange', () => {
            if (installing.state === 'installed') offer();
          });
        });
      })
      .catch(() => undefined);
    const onController = () => {
      if (asked.current) location.reload();
    };
    navigator.serviceWorker.addEventListener('controllerchange', onController);
    return () => {
      disposed = true;
      navigator.serviceWorker.removeEventListener('controllerchange', onController);
    };
  }, []);

  if (!registration) return null;
  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit max-w-[calc(100%-2rem)] items-center gap-3 rounded-lg border border-line bg-surface px-4 py-2 text-sm shadow-lg"
    >
      <span>A new version of BokyDo is ready.</span>
      <Button
        variant="secondary"
        onClick={() => {
          asked.current = true;
          registration.waiting?.postMessage({ type: 'SKIP_WAITING' });
        }}
      >
        Reload
      </Button>
    </div>
  );
}
