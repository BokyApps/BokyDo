import {
  DEFAULT_PREFERENCES,
  detectTimeZone,
  type Command,
  type CommandType,
  type Preferences,
  type SyncRequest,
  type SyncResponse,
} from '@bokydo/shared';
import { SyncStore, type SyncState } from '@bokydo/sync-client';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { api } from './api.js';
import { applyAppearance, watchSystemMode } from './appearance.js';
import { rememberLanguage, setLanguage } from '../i18n.js';
import { useToast } from './toasts.js';

const SyncContext = createContext<SyncStore | null>(null);

const REJECTIONS: Record<string, string> = {
  forbidden: "You don't have permission to do that in this project.",
  not_found: 'That item no longer exists.',
  conflict: 'That conflicts with a change made elsewhere.',
  limit_exceeded: "You've hit a limit for this.",
  invalid: "That change wasn't valid.",
};

/** One sync engine per signed-in session: optimistic local state, server sync, live pokes. */
export function SyncProvider({ children }: { children: ReactNode }) {
  const toast = useToast();
  const [store] = useState(
    () =>
      new SyncStore(
        { sync: (request: SyncRequest) => api<SyncResponse>('POST', '/api/v1/sync', request) },
        {
          onRejected: (_command, result) =>
            toast({
              tone: 'error',
              message: REJECTIONS[result.error] ?? 'A change could not be saved.',
            }),
        },
      ),
  );
  useEffect(() => {
    void store.pull();
    const events = new EventSource('/api/v1/sync/events');
    events.addEventListener('poke', () => void store.pull());
    // Catch up after the tab was in the background or the network blipped.
    const onVisible = () => document.visibilityState === 'visible' && void store.pull();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onVisible);
    return () => {
      events.close();
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onVisible);
    };
  }, [store]);
  return <SyncContext.Provider value={store}>{children}</SyncContext.Provider>;
}

export function useStore(): SyncStore {
  const store = useContext(SyncContext);
  if (!store) throw new Error('useStore needs <SyncProvider>');
  return store;
}

export function useSyncState(): SyncState {
  const store = useStore();
  return useSyncExternalStore(
    (cb) => {
      const off = store.subscribe(cb);
      return () => void off();
    },
    () => store.state,
  );
}

export function usePreferences(): Preferences {
  return useSyncState().user?.preferences ?? DEFAULT_PREFERENCES;
}

/** The user's zone, else the device's, else UTC. */
export function useTimeZone(): string {
  const prefs = usePreferences();
  return useMemo(() => prefs.timezone ?? detectTimeZone() ?? 'UTC', [prefs.timezone]);
}

export const newId = () => crypto.randomUUID();

/** Build and enqueue a command; returns it (callers keep it to undo). */
export function useSend() {
  const store = useStore();
  return useMemo(
    () =>
      <T extends CommandType>(type: T, args: Extract<Command, { type: T }>['args']) => {
        const command = { type, uuid: newId(), args } as Command;
        store.enqueue(command);
        return command;
      },
    [store],
  );
}

/**
 * Keep the document's appearance in sync with the user's preferences, and set the time zone
 * from the device the first time (users rarely know their IANA zone name).
 */
export function PreferenceEffects() {
  const state = useSyncState();
  const send = useSend();
  const prefs = state.user?.preferences;
  useEffect(() => {
    if (!prefs) return;
    applyAppearance(prefs.appearance);
    return watchSystemMode(() => prefs.appearance);
  }, [prefs]);
  // The synced language wins over this device's remembered one (W12c, ADR 0023).
  useEffect(() => {
    if (prefs?.language)
      void setLanguage(prefs.language).then(() => rememberLanguage(prefs.language));
  }, [prefs?.language]);
  useEffect(() => {
    if (state.user && prefs && prefs.timezone === null) {
      const detected = detectTimeZone();
      if (detected) send('user_update_preferences', { timezone: detected });
    }
  }, [state.user, prefs, send]);
  return null;
}
