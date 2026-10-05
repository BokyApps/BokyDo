import {
  DEFAULT_PREFERENCES,
  type Command,
  type CommandResult,
  type SyncRequest,
  type SyncResponse,
  type Task,
} from '@bokydo/shared';
import { describe, expect, it, vi } from 'vitest';
import { SyncStore } from './store.js';

const USER = {
  id: 'u1',
  username: 'alice',
  isAdmin: false,
  inboxProjectId: 'inbox',
  preferences: DEFAULT_PREFERENCES,
};
const INBOX = {
  id: 'inbox',
  name: 'Inbox',
  color: 'charcoal' as const,
  parentId: null,
  childOrder: 'a0',
  viewStyle: 'list' as const,
  isInbox: true,
  isArchived: false,
  isFavorite: false,
  role: 'owner' as const,
  updatedAt: '',
};
let n = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;
const addTask = (id: string, content: string): Command => ({
  type: 'task_add',
  uuid: uuid(),
  args: { id, content },
});

function response(partial: Partial<SyncResponse> = {}): SyncResponse {
  return {
    cursor: '1',
    fullSync: false,
    user: USER,
    projects: [],
    sections: [],
    tasks: [],
    labels: [],
    filters: [],
    removed: { projects: [], sections: [], tasks: [], labels: [], filters: [] },
    results: {},
    ...partial,
  };
}

function serverTask(id: string, content: string): Task {
  return {
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
  };
}

/** A transport whose responses the test resolves by hand. */
function manualTransport() {
  const calls: {
    request: SyncRequest;
    resolve: (r: SyncResponse) => void;
    reject: (e: unknown) => void;
  }[] = [];
  return {
    calls,
    transport: {
      sync: (request: SyncRequest) =>
        new Promise<SyncResponse>((resolve, reject) => calls.push({ request, resolve, reject })),
    },
  };
}

async function ready() {
  const t = manualTransport();
  const timers: (() => void)[] = [];
  const rejected: [Command, CommandResult][] = [];
  const store = new SyncStore(t.transport, {
    onRejected: (c, r) => rejected.push([c, r]),
    setTimer: (fn) => timers.push(fn),
  });
  const first = store.pull();
  t.calls[0]!.resolve(response({ fullSync: true, projects: [INBOX] }));
  await first;
  return { store, ...t, timers, rejected };
}

describe('SyncStore', () => {
  it('shows a new task immediately, before the server answers', async () => {
    const { store, calls } = await ready();
    store.enqueue(addTask('t1', 'Buy milk'));
    expect(store.state.tasks.get('t1')).toMatchObject({ content: 'Buy milk', projectId: 'inbox' });
    expect(store.pendingCount).toBe(1);
    const call = calls.at(-1)!;
    call.resolve(
      response({
        tasks: [serverTask('t1', 'Buy milk')],
        results: { [(call.request.commands![0] as Command).uuid]: { ok: true } },
      }),
    );
    await store.whenIdle();
    expect(store.pendingCount).toBe(0);
  });

  it('rolls back a rejected command and reports it', async () => {
    const { store, calls, rejected } = await ready();
    const command = addTask('t1', 'Nope');
    store.enqueue(command);
    expect(store.state.tasks.has('t1')).toBe(true);
    calls
      .at(-1)!
      .resolve(response({ results: { [command.uuid]: { ok: false, error: 'forbidden' } } }));
    await store.whenIdle();
    expect(store.state.tasks.has('t1')).toBe(false);
    expect(rejected).toEqual([[command, { ok: false, error: 'forbidden' }]]);
  });

  it('rebases commands queued while a batch is in flight', async () => {
    const { store, calls } = await ready();
    const first = addTask('t1', 'first');
    store.enqueue(first);
    const second = addTask('t2', 'second');
    store.enqueue(second); // queued behind the in-flight batch
    calls
      .at(-1)!
      .resolve(
        response({ tasks: [serverTask('t1', 'first')], results: { [first.uuid]: { ok: true } } }),
      );
    await new Promise((r) => setTimeout(r, 0));
    expect(store.state.tasks.has('t1')).toBe(true);
    expect(store.state.tasks.get('t2')).toMatchObject({ content: 'second' });
    expect(calls.at(-1)!.request.commands).toEqual([second]);
  });

  it('keeps commands through network failures and retries with the same UUIDs', async () => {
    const { store, calls, timers } = await ready();
    const command = addTask('t1', 'offline');
    store.enqueue(command);
    calls.at(-1)!.reject(new Error('network down'));
    await new Promise((r) => setTimeout(r, 0));
    expect(store.state.tasks.has('t1')).toBe(true);
    expect(store.pendingCount).toBe(1);
    timers.shift()!();
    expect(calls.at(-1)!.request.commands).toEqual([command]);
  });

  it('merges remote changes and drops everything under a removed project', async () => {
    const { store, calls } = await ready();
    const shared = { ...INBOX, id: 'p2', name: 'Shared', isInbox: false, role: 'editor' as const };
    let pull = store.pull();
    calls.at(-1)!.resolve(
      response({
        projects: [shared],
        tasks: [{ ...serverTask('t9', 'theirs'), projectId: 'p2' }],
      }),
    );
    await pull;
    expect(store.state.tasks.has('t9')).toBe(true);
    pull = store.pull();
    calls.at(-1)!.resolve(
      response({
        removed: { projects: ['p2'], sections: [], tasks: [], labels: [], filters: [] },
      }),
    );
    await pull;
    expect(store.state.projects.has('p2')).toBe(false);
    expect(store.state.tasks.has('t9')).toBe(false);
  });

  it('applies cascades optimistically', async () => {
    const { store } = await ready();
    store.enqueue(addTask('parent', 'p'));
    store.enqueue({
      type: 'task_add',
      uuid: uuid(),
      args: { id: 'child', parentId: 'parent', content: 'c' },
    });
    store.enqueue({ type: 'task_complete', uuid: uuid(), args: { id: 'parent' } });
    expect(store.state.tasks.get('child')!.isCompleted).toBe(true);
    store.enqueue({ type: 'task_delete', uuid: uuid(), args: { id: 'parent' } });
    expect(store.state.tasks.has('child')).toBe(false);
  });

  it('rolls recurring tasks forward instead of completing them', async () => {
    const { store } = await ready();
    store.enqueue({
      type: 'task_add',
      uuid: uuid(),
      args: {
        id: 'daily',
        content: 'Stretch',
        due: {
          date: '2000-01-01',
          time: null,
          timezone: null,
          string: 'every day',
          recurrence: { rrule: 'FREQ=DAILY', anchor: 'scheduled' },
        },
      },
    });
    store.enqueue({
      type: 'task_add',
      uuid: uuid(),
      args: { id: 'step', parentId: 'daily', content: 'Warm up' },
    });
    store.enqueue({ type: 'task_complete', uuid: uuid(), args: { id: 'step' } });
    store.enqueue({ type: 'task_complete', uuid: uuid(), args: { id: 'daily' } });
    const daily = store.state.tasks.get('daily')!;
    expect(daily.isCompleted).toBe(false);
    expect(daily.due!.date > '2000-01-01').toBe(true);
    expect(daily.due!.string).toBe('every day');
    expect(store.state.tasks.get('step')!.isCompleted).toBe(false);
  });

  it('notifies subscribers', async () => {
    const { store } = await ready();
    const listener = vi.fn();
    store.subscribe(listener);
    store.enqueue(addTask('t1', 'x'));
    expect(listener).toHaveBeenCalled();
  });
});
