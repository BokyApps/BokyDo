/** Live hints plus reconnect/focus/periodic catch-up. Hints never contain account data. */
export function watchLiveChanges(pull: () => Promise<void>, invalidate: () => void): () => void {
  let disposed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  let events: EventSource | undefined;
  const refresh = () => {
    if (disposed) return;
    void pull().catch(() => undefined);
    invalidate();
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
