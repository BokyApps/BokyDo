import 'fake-indexeddb/auto';
import { DEFAULT_PREFERENCES, type Command, type Task } from '@bokydo/shared';
import { emptyState, type SyncSnapshot } from '@bokydo/sync-client';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  offlineEnabled,
  pruneOffline,
  readOffline,
  setOfflineEnabled,
  wipeOffline,
  writeOffline,
} from './offline.js';

class MemoryStorage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

const user = (id: string) => ({
  id,
  username: id,
  isAdmin: false,
  inboxProjectId: 'inbox',
  preferences: DEFAULT_PREFERENCES,
  timeZone: 'UTC',
});

const task = (id: string, content: string): Task => ({
  id,
  projectId: 'inbox',
  sectionId: null,
  parentId: null,
  content,
  description: '',
  priority: 4,
  due: null,
  deadline: null,
  durationMinutes: null,
  labels: [],
  assigneeId: null,
  assignedById: null,
  childOrder: 'a0',
  isCompleted: false,
  completedAt: null,
  createdById: 'u1',
  createdAt: '',
  updatedAt: '',
});

const command: Command = {
  type: 'task_add',
  uuid: '00000000-0000-4000-8000-000000000001',
  args: { id: 'queued', content: 'written offline' },
};

function snapshot(id: string): SyncSnapshot {
  const state = emptyState();
  state.user = user(id);
  state.tasks = new Map([[`t-${id}`, task(`t-${id}`, `task for ${id}`)]]);
  return { state, queue: [command], cursor: '42' };
}

beforeEach(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  await wipeOffline();
});

describe('offline copy', () => {
  it('round-trips the confirmed state and queue for a user', async () => {
    await setOfflineEnabled(true);
    await writeOffline('u1', snapshot('u1'));
    const restored = await readOffline();
    expect(restored?.cursor).toBe('42');
    expect(restored?.queue).toEqual([command]);
    expect(restored?.state.user?.id).toBe('u1');
    expect(restored?.state.tasks.get('t-u1')).toMatchObject({ content: 'task for u1' });
  });

  it('stays off, and writes nothing, until the setting is turned on', async () => {
    expect(offlineEnabled()).toBe(false);
    await writeOffline('u1', snapshot('u1'));
    expect(await readOffline()).toBeNull();
  });

  it('turning the setting off deletes the copy', async () => {
    await setOfflineEnabled(true);
    await writeOffline('u1', snapshot('u1'));
    expect(await readOffline()).not.toBeNull();
    await setOfflineEnabled(false);
    expect(offlineEnabled()).toBe(false);
    expect(await readOffline()).toBeNull();
  });

  it('keeps only the signed-in user when another signed in on this browser', async () => {
    await setOfflineEnabled(true);
    await writeOffline('u1', snapshot('u1'));
    await writeOffline('u2', snapshot('u2'));
    await pruneOffline('u1');
    const restored = await readOffline();
    expect(restored?.state.user?.id).toBe('u1');
    expect(restored?.state.tasks.has('t-u1')).toBe(true);
    expect(restored?.state.tasks.has('t-u2')).toBe(false);
  });

  it('wipe deletes the database', async () => {
    await setOfflineEnabled(true);
    await writeOffline('u1', snapshot('u1'));
    await wipeOffline();
    expect(await readOffline()).toBeNull();
  });
});
