import { DEFAULT_PREFERENCES, type Command, type SyncResponse } from '@bokydo/shared';
import { SyncStore, type SyncState } from '@bokydo/sync-client';

/** Test support: BokyDo's own client state after some commands, without a server. */
const USER = {
  id: 'u1',
  username: 'alice',
  isAdmin: false,
  inboxProjectId: 'inbox',
  preferences: DEFAULT_PREFERENCES,
};
const signedIn = (): SyncResponse => ({
  cursor: '1',
  fullSync: true,
  user: USER,
  projects: [],
  sections: [],
  tasks: [],
  labels: [],
  filters: [],
  comments: [],
  removed: {
    projects: [],
    sections: [],
    tasks: [],
    labels: [],
    filters: [],
    comments: [],
    reminders: [],
  },
  collaborators: [],
  members: [],
  invitations: [],
  notifications: [],
  unreadNotifications: 0,
  workspaces: [],
  workspaceMembers: [],
  folders: [],
  reminders: [],
  results: {},
});

/**
 * BokyDo's own client state after these commands: a signed-in user, and a store that applies
 * commands optimistically and never reaches a server (its second request just waits).
 */
export async function storeWith(
  commands: PlannedCommand[],
  before: PlannedCommand[] = [],
): Promise<SyncState> {
  let calls = 0;
  const store = new SyncStore({
    sync: () => (++calls === 1 ? Promise.resolve(signedIn()) : new Promise(() => undefined)),
  });
  await store.pull();
  for (const c of [...before, ...commands])
    store.enqueue({ ...c, uuid: crypto.randomUUID() } as Command);
  return store.state;
}

/** A command before the store gives it a uuid. */
type PlannedCommand = Command extends infer C
  ? C extends Command
    ? Pick<C, 'type' | 'args'>
    : never
  : never;
