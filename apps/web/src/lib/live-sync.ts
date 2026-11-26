import type { QueryClient } from '@tanstack/react-query';
import { queryClient } from './queries.js';

/**
 * Notes views refresh on every live user-event / reconnect hint, just like habit views (whose
 * invalidation is passed in by the caller). Kept as a small helper so the key mapping is testable.
 */
export function invalidateLiveNotes(qc: Pick<QueryClient, 'invalidateQueries'>): void {
  void qc.invalidateQueries({ queryKey: ['notes'] });
}

/** Live hints plus reconnect/focus/periodic catch-up. Hints never contain account data. */
export function watchLiveChanges(pull: () => Promise<void>, invalidate: () => void): () => void {
  let disposed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let events: EventSource | undefined;
  const refresh = () => {
    if (disposed) return;
    void pull().catch(() => undefined);
    invalidate();
    invalidateLiveNotes(queryClient);
  };
  const poke = () => {
    // Coalesce bursts (including our own writes) instead of sending a pull for every event.
    if (pending) return;
    pending = setTimeout(() => {
      pending = undefined;
      refresh();
    }, 100);
  };
  const visible = () => {
    if (document.visibilityState === 'visible') refresh();
  };
  try {
    events = new EventSource('/api/v1/sync/events');
    events.addEventListener('poke', poke);
    // A fresh connection must catch changes in the gap before opening or during reconnect.
    events.addEventListener('open', refresh);
  } catch {
    // Some networks/browsers block streaming; periodic pulls keep the app current.
  }
  const timer = setInterval(refresh, 30_000);
  document.addEventListener('visibilitychange', visible);
  window.addEventListener('online', refresh);
  window.addEventListener('focus', refresh);
  return () => {
    disposed = true;
    clearTimeout(pending);
    clearInterval(timer);
    events?.close();
    document.removeEventListener('visibilitychange', visible);
    window.removeEventListener('online', refresh);
    window.removeEventListener('focus', refresh);
  };
}
