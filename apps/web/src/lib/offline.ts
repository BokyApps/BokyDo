import type { Command } from '@bokydo/shared';
import {
  deserializeState,
  serializeState,
  type SerializedState,
  type SyncSnapshot,
} from '@bokydo/sync-client';

/**
 * The opt-in offline copy: the confirmed sync state and the pending command queue, one record per
 * user id in IndexedDB `bokydo-offline`. It is off by default and only ever written while the
 * "Keep a copy on this device" setting is on; turning the setting off, or signing out, deletes it.
 * The flag and the remembered user id live in localStorage (both cleared by the sign-out wipe).
 */
const DB_NAME = 'bokydo-offline';
const STORE = 'snapshots';
const ENABLED_KEY = 'bokydo.offline';
const USER_KEY = 'bokydo.offline.user';

interface StoredSnapshot {
  userId: string;
  state: SerializedState;
  queue: Command[];
  cursor: string | null;
}

const storage = (): Storage | null => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function offlineEnabled(): boolean {
  return storage()?.getItem(ENABLED_KEY) === '1';
}

/** Turn the setting on or off; off deletes everything it had stored. */
export async function setOfflineEnabled(on: boolean): Promise<void> {
  const store = storage();
  if (on) store?.setItem(ENABLED_KEY, '1');
  else store?.removeItem(ENABLED_KEY);
  if (!on) await wipeOffline();
}

function rememberedUser(): string | null {
  return storage()?.getItem(USER_KEY) ?? null;
}

const hasIndexedDb = () => typeof indexedDB !== 'undefined';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE))
        request.result.createObjectStore(STORE, { keyPath: 'userId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transact<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = run(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error);
        };
      }),
  );
}

function deleteDatabase(): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
}

/** The snapshot for the remembered user, or null when the setting is off or nothing was stored. */
export async function readOffline(): Promise<SyncSnapshot | null> {
  if (!offlineEnabled() || !hasIndexedDb()) return null;
  const userId = rememberedUser();
  if (!userId) return null;
  const stored = await transact<StoredSnapshot | undefined>('readonly', (store) =>
    store.get(userId),
  ).catch(() => undefined);
  if (!stored || stored.userId !== userId) return null;
  return {
    state: deserializeState(stored.state),
    queue: stored.queue,
    cursor: stored.cursor,
  };
}

/** Persist the current snapshot for a user (no-op unless the setting is on). */
export async function writeOffline(userId: string, snapshot: SyncSnapshot): Promise<void> {
  if (!offlineEnabled() || !hasIndexedDb() || !snapshot.state.user) return;
  const record: StoredSnapshot = {
    userId,
    state: serializeState(snapshot.state),
    queue: snapshot.queue,
    cursor: snapshot.cursor,
  };
  await transact('readwrite', (store) => store.put(record)).catch(() => undefined);
  storage()?.setItem(USER_KEY, userId);
}

/** Delete every stored user except the one just signed in (a different user on a shared browser). */
export async function pruneOffline(keepUserId: string): Promise<void> {
  if (!offlineEnabled() || !hasIndexedDb()) return;
  const ids =
    (await transact<IDBValidKey[]>('readonly', (store) => store.getAllKeys()).catch(
      () => [] as IDBValidKey[],
    )) ?? [];
  await Promise.all(
    ids
      .filter((id): id is string => typeof id === 'string' && id !== keepUserId)
      .map((id) => transact('readwrite', (store) => store.delete(id)).catch(() => undefined)),
  );
  storage()?.setItem(USER_KEY, keepUserId);
}

/** Forget the device's offline copy: the database, the remembered user and the opt-in flag. */
export async function wipeOffline(): Promise<void> {
  storage()?.removeItem(USER_KEY);
  storage()?.removeItem(ENABLED_KEY);
  if (hasIndexedDb()) await deleteDatabase();
}
