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
import { useQueryClient } from '@tanstack/react-query';
import { watchLiveChanges } from './live-sync.js';
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
import { offlineEnabled, pruneOffline, readOffline, writeOffline } from './offline.js';
import { useToast } from './toasts.js';

const SyncContext = createContext<SyncStore | null>(null);
const SyncReadyContext = createContext(false);

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
  const queryClient = useQueryClient();
  const [serverSynced, setServerSynced] = useState(false);
  const [store] = useState(() => {
    let receivedServerResponse = false;
    return new SyncStore(
      {
        sync: async (request: SyncRequest) => {
          const response = await api<SyncResponse>('POST', '/api/v1/sync', request);
          receivedServerResponse = true;
          // History is fetched separately from sync (which only retains recent completions).
          // Refresh every project/page after confirmed writes and live/reconnect catch-up.
          // Cancel even an initial fetch: its pre-write snapshot must not win this refresh.
          await queryClient.cancelQueries({ queryKey: ['completed'] });
          void queryClient.invalidateQueries({ queryKey: ['completed'] });
          return response;
        },
      },
      {
        onRejected: (_command, result) =>
          toast({
            tone: 'error',
            message: REJECTIONS[result.error] ?? 'A change could not be saved.',
          }),
        // Keep the opt-in offline copy current after every change and every confirmation.
        onPersist: (snapshot) => {
          if (receivedServerResponse) setServerSynced(true);
          const userId = snapshot.state.user?.id;
          if (userId) void writeOffline(userId, snapshot);
        },
      },
    );
  });
  useEffect(() => {
    let disposed = false;
    let stopLive: (() => void) | undefined;
    void (async () => {
      // Hydrate from the device before the first network round trip, when the setting is on.
      if (offlineEnabled()) {
        const snapshot = await readOffline();
        if (disposed) return;
        if (snapshot) store.hydrate(snapshot);
      }
      if (disposed) return;
      await store.pull();
      const userId = store.state.user?.id;
      // A different user on this browser: their copy is not ours to keep.
      if (userId) void pruneOffline(userId);
      if (disposed) return;
      stopLive = watchLiveChanges(
        () => store.pull(),
        () => {
          void queryClient.invalidateQueries({ queryKey: ['habits'] });
        },
      );
    })();
    return () => {
      disposed = true;
      stopLive?.();
    };
  }, [store, queryClient]);
  return (
    <SyncContext.Provider value={store}>
      <SyncReadyContext.Provider value={serverSynced}>{children}</SyncReadyContext.Provider>
    </SyncContext.Provider>
  );
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

/** True only after applying a successful server response, never for an offline snapshot. */
export function useSyncReady(): boolean {
  return useContext(SyncReadyContext);
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
