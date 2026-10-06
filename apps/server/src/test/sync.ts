import type {
  CommandArgs,
  Comment,
  Reminder,
  CommandType,
  EntityType,
  Filter,
  Label,
  Project,
  Section,
  SyncResponse,
  Task,
} from '@bokydo/shared';
import { randomUUID } from 'node:crypto';
import { newId } from '../db/ids.js';
import type { SyncService } from '../sync/sync-service.js';

export const id = () => newId();

export function cmd<T extends CommandType>(
  type: T,
  args: CommandArgs<T> | Record<string, unknown>,
  uuid = randomUUID(),
) {
  return { type, uuid, args };
}

/** A minimal sync client that mirrors server state the way real clients will. */
export class SyncUser {
  cursor: string | null = null;
  projects = new Map<string, Project>();
  sections = new Map<string, Section>();
  tasks = new Map<string, Task>();
  labels = new Map<string, Label>();
  filters = new Map<string, Filter>();
  comments = new Map<string, Comment>();
  reminders = new Map<string, Reminder>();
  last!: SyncResponse;

  constructor(
    private readonly sync: SyncService,
    readonly userId: string,
  ) {}

  get inbox(): string {
    return this.last.user.inboxProjectId;
  }

  async run(...commands: ReturnType<typeof cmd>[]): Promise<SyncResponse> {
    const res = await this.sync.sync(this.userId, {
      cursor: this.cursor,
      commands: commands as never,
    });
    this.merge(res);
    return res;
  }

  /** Run commands and assert they all succeeded. */
  async ok(...commands: ReturnType<typeof cmd>[]): Promise<SyncResponse> {
    const res = await this.run(...commands);
    for (const c of commands) {
      if (!res.results[c.uuid]?.ok)
        throw new Error(`${c.type} failed: ${JSON.stringify(res.results[c.uuid])}`);
    }
    return res;
  }

  /** The result of a single command. */
  async result(command: ReturnType<typeof cmd>) {
    return (await this.run(command)).results[command.uuid];
  }

  merge(res: SyncResponse): void {
    this.last = res;
    this.cursor = res.cursor;
    const maps: Record<EntityType, Map<string, { id: string }>> = {
      projects: this.projects,
      sections: this.sections,
      tasks: this.tasks,
      labels: this.labels,
      filters: this.filters,
      comments: this.comments,
      reminders: this.reminders,
    };
    if (res.fullSync) for (const m of Object.values(maps)) m.clear();
    for (const type of Object.keys(maps) as EntityType[]) {
      for (const e of res[type]) maps[type].set(e.id, e);
      for (const gone of res.removed[type]) maps[type].delete(gone);
    }
    // Client-side cascade for projects that disappeared.
    for (const [sid, s] of this.sections)
      if (!this.projects.has(s.projectId)) this.sections.delete(sid);
    for (const [tid, t] of this.tasks) if (!this.projects.has(t.projectId)) this.tasks.delete(tid);
    for (const [cid, c] of this.comments)
      if (!this.projects.has(c.projectId) || (c.taskId && !this.tasks.has(c.taskId)))
        this.comments.delete(cid);
  }
}
