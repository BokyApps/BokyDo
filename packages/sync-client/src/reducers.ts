import { localNow, nextOccurrence } from '@bokydo/nlp';
import { generateKeyBetween, type Command, type Task } from '@bokydo/shared';
import { dropOrphans, type Draft } from './state.js';

/**
 * Optimistic versions of the server's command handlers. They only need to be close enough for
 * instant feedback: the server stays authoritative and the next sync replaces this guesswork.
 * A command whose preconditions don't hold locally is a no-op here (the server will reject it).
 */
export function applyCommand(d: Draft, command: Command, now: string): void {
  switch (command.type) {
    case 'project_add': {
      const a = command.args;
      const siblings = [...d.projects.values()].filter((p) => p.parentId === (a.parentId ?? null));
      d.projects.set(a.id, {
        id: a.id,
        name: a.name,
        color: a.color ?? 'charcoal',
        parentId: a.parentId ?? null,
        childOrder: a.childOrder ?? after(siblings.map((p) => p.childOrder)),
        viewStyle: a.viewStyle ?? 'list',
        isInbox: false,
        isArchived: false,
        isFavorite: a.isFavorite ?? false,
        role: 'owner',
        updatedAt: now,
      });
      return;
    }
    case 'project_update':
      return patch(d.projects, command.args.id, { ...without(command.args, 'id'), updatedAt: now });
    case 'project_move':
      return patch(d.projects, command.args.id, {
        parentId: command.args.parentId,
        ...(command.args.childOrder ? { childOrder: command.args.childOrder } : {}),
      });
    case 'project_archive':
    case 'project_unarchive':
      for (const id of [
        command.args.id,
        ...descendants(d.projects, command.args.id, (p) => p.parentId),
      ]) {
        patch(d.projects, id, { isArchived: command.type === 'project_archive' });
      }
      return;
    case 'project_delete':
      for (const id of [
        command.args.id,
        ...descendants(d.projects, command.args.id, (p) => p.parentId),
      ]) {
        d.projects.delete(id);
      }
      dropOrphans(d);
      return;

    case 'section_add': {
      const a = command.args;
      const siblings = [...d.sections.values()].filter((s) => s.projectId === a.projectId);
      d.sections.set(a.id, {
        id: a.id,
        projectId: a.projectId,
        name: a.name,
        sectionOrder: a.sectionOrder ?? after(siblings.map((s) => s.sectionOrder)),
        isArchived: false,
        updatedAt: now,
      });
      return;
    }
    case 'section_update':
      return patch(d.sections, command.args.id, { name: command.args.name, updatedAt: now });
    case 'section_move': {
      const { id, projectId, sectionOrder } = command.args;
      patch(d.sections, id, {
        ...(projectId ? { projectId } : {}),
        ...(sectionOrder ? { sectionOrder } : {}),
      });
      if (projectId)
        for (const t of d.tasks.values())
          if (t.sectionId === id) patch(d.tasks, t.id, { projectId });
      return;
    }
    case 'section_archive':
    case 'section_unarchive':
      return patch(d.sections, command.args.id, { isArchived: command.type === 'section_archive' });
    case 'section_delete':
      d.sections.delete(command.args.id);
      dropOrphans(d);
      return;

    case 'task_add': {
      const a = command.args;
      const parent = a.parentId ? d.tasks.get(a.parentId) : undefined;
      const projectId = parent?.projectId ?? a.projectId ?? d.user?.inboxProjectId;
      if (!projectId || !d.user) return;
      const sectionId = parent ? parent.sectionId : (a.sectionId ?? null);
      const siblings = [...d.tasks.values()].filter(
        (t) =>
          t.projectId === projectId &&
          t.sectionId === sectionId &&
          t.parentId === (a.parentId ?? null),
      );
      d.tasks.set(a.id, {
        id: a.id,
        projectId,
        sectionId,
        parentId: a.parentId ?? null,
        content: a.content,
        description: a.description ?? '',
        priority: a.priority ?? 4,
        due: a.due ?? null,
        deadline: a.deadline ?? null,
        durationMinutes: a.durationMinutes ?? null,
        labels: a.labels ?? [],
        assigneeId: a.assigneeId ?? null,
        assignedById: a.assigneeId ? d.user.id : null,
        childOrder: a.childOrder ?? after(siblings.map((t) => t.childOrder)),
        isCompleted: false,
        completedAt: null,
        createdById: d.user.id,
        createdAt: now,
        updatedAt: now,
      });
      return;
    }
    case 'task_update':
      return patch(d.tasks, command.args.id, { ...without(command.args, 'id'), updatedAt: now });
    case 'task_move': {
      const { id, projectId, sectionId, parentId, childOrder } = command.args;
      const task = d.tasks.get(id);
      if (!task) return;
      const parent = parentId ? d.tasks.get(parentId) : undefined;
      const next: Partial<Task> = parent
        ? { projectId: parent.projectId, sectionId: parent.sectionId, parentId: parent.id }
        : {
            projectId: projectId ?? task.projectId,
            sectionId:
              sectionId !== undefined
                ? sectionId
                : projectId && projectId !== task.projectId
                  ? null
                  : task.sectionId,
            parentId:
              parentId === null || projectId !== undefined || sectionId !== undefined
                ? null
                : task.parentId,
          };
      if (childOrder) next.childOrder = childOrder;
      patch(d.tasks, id, next);
      const moved = d.tasks.get(id) ?? task;
      for (const child of descendants(d.tasks, id, (t) => t.parentId)) {
        patch(d.tasks, child, { projectId: moved.projectId, sectionId: moved.sectionId });
      }
      return;
    }
    case 'task_complete': {
      const ids = descendants(d.tasks, command.args.id, (t) => t.parentId);
      const task = d.tasks.get(command.args.id);
      // Recurring: move to the next occurrence and reopen sub-tasks, like the server.
      const timeZone =
        d.user?.preferences.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const next =
        task?.due?.recurrence && !task.isCompleted
          ? nextOccurrence(task.due, localNow(timeZone, new Date(now)))
          : null;
      if (task && next) {
        patch(d.tasks, task.id, { due: next, updatedAt: now });
        for (const id of ids)
          if (d.tasks.get(id)?.isCompleted)
            patch(d.tasks, id, { isCompleted: false, completedAt: null });
        return;
      }
      for (const id of [command.args.id, ...ids]) {
        const t = d.tasks.get(id);
        if (t && !t.isCompleted) patch(d.tasks, id, { isCompleted: true, completedAt: now });
      }
      return;
    }
    case 'task_uncomplete':
      for (
        let t = d.tasks.get(command.args.id);
        t;
        t = t.parentId ? d.tasks.get(t.parentId) : undefined
      ) {
        if (t.isCompleted) patch(d.tasks, t.id, { isCompleted: false, completedAt: null });
      }
      return;
    case 'task_delete':
      for (const id of [
        command.args.id,
        ...descendants(d.tasks, command.args.id, (t) => t.parentId),
      ]) {
        d.tasks.delete(id);
      }
      return;

    case 'label_add': {
      const a = command.args;
      d.labels.set(a.id, {
        id: a.id,
        name: a.name,
        color: a.color ?? 'charcoal',
        itemOrder: a.itemOrder ?? after([...d.labels.values()].map((l) => l.itemOrder)),
        isFavorite: a.isFavorite ?? false,
      });
      return;
    }
    case 'label_update': {
      const old = d.labels.get(command.args.id);
      patch(d.labels, command.args.id, without(command.args, 'id'));
      const renamed = command.args.name;
      if (old && renamed && renamed !== old.name) renameLabel(d, old.name, renamed);
      return;
    }
    case 'label_delete': {
      const old = d.labels.get(command.args.id);
      d.labels.delete(command.args.id);
      if (old) renameLabel(d, old.name, null);
      return;
    }

    case 'filter_add': {
      const a = command.args;
      d.filters.set(a.id, {
        id: a.id,
        name: a.name,
        query: a.query,
        color: a.color ?? 'charcoal',
        itemOrder: a.itemOrder ?? after([...d.filters.values()].map((f) => f.itemOrder)),
        isFavorite: a.isFavorite ?? false,
      });
      return;
    }
    case 'filter_update':
      return patch(d.filters, command.args.id, without(command.args, 'id'));
    case 'filter_delete':
      d.filters.delete(command.args.id);
      return;

    case 'notifications_mark_read': {
      const ids = command.args.ids ? new Set(command.args.ids) : null;
      let marked = 0;
      d.notifications = d.notifications.map((n) => {
        if (n.read || (ids && !ids.has(n.id))) return n;
        marked++;
        return { ...n, read: true };
      });
      d.unreadNotifications = ids ? Math.max(0, d.unreadNotifications - marked) : 0;
      return;
    }
    case 'comment_add': {
      const a = command.args;
      const projectId = a.projectId ?? (a.taskId ? d.tasks.get(a.taskId)?.projectId : undefined);
      if (!projectId || !d.user) return;
      d.comments.set(a.id, {
        id: a.id,
        projectId,
        taskId: a.taskId ?? null,
        userId: d.user.id,
        content: a.content,
        createdAt: now,
        updatedAt: now,
        reactions: {},
        // Filled in by the server's response (names and types come from the uploads).
        attachments: [],
      });
      return;
    }
    case 'comment_update':
      return patch(d.comments, command.args.id, { content: command.args.content, updatedAt: now });
    case 'comment_delete':
      d.comments.delete(command.args.id);
      return;
    case 'reaction_toggle': {
      const c = d.comments.get(command.args.commentId);
      const me = d.user?.id;
      if (!c || !me) return;
      const { emoji } = command.args;
      const who = c.reactions[emoji] ?? [];
      const next = who.includes(me) ? who.filter((x) => x !== me) : [...who, me];
      const reactions = Object.fromEntries(
        Object.entries({ ...c.reactions, [emoji]: next }).filter(([, who]) => who.length > 0),
      );
      d.comments.set(c.id, { ...c, reactions });
      return;
    }
    case 'project_member_update': {
      const a = command.args;
      d.members = d.members.map((m) =>
        m.projectId === a.projectId && m.userId === a.userId ? { ...m, role: a.role } : m,
      );
      if (a.userId === d.user?.id) patch(d.projects, a.projectId, { role: a.role });
      return;
    }
    case 'project_member_remove': {
      const a = command.args;
      d.members = d.members.filter((m) => !(m.projectId === a.projectId && m.userId === a.userId));
      if (a.userId === d.user?.id) {
        d.projects.delete(a.projectId);
        dropOrphans(d);
        return;
      }
      for (const t of d.tasks.values())
        if (t.projectId === a.projectId && t.assigneeId === a.userId)
          patch(d.tasks, t.id, { assigneeId: null, assignedById: null });
      return;
    }
    case 'project_transfer': {
      const a = command.args;
      const me = d.user?.id;
      d.members = d.members.map((m) =>
        m.projectId !== a.projectId
          ? m
          : m.userId === a.userId
            ? { ...m, role: 'owner' }
            : m.userId === me
              ? { ...m, role: 'admin' }
              : m,
      );
      patch(d.projects, a.projectId, { role: 'admin' });
      return;
    }
    case 'user_update_preferences': {
      if (!d.user) return;
      const { appearance, ...rest } = command.args;
      const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
      const appearanceDefined = Object.fromEntries(
        Object.entries(appearance ?? {}).filter(([, v]) => v !== undefined),
      );
      d.user = {
        ...d.user,
        preferences: {
          ...d.user.preferences,
          ...defined,
          appearance: { ...d.user.preferences.appearance, ...appearanceDefined },
        },
      };
      return;
    }
  }
}

/** Shallow-merge defined fields into an entity (an omitted or undefined field is left alone). */
function patch<T extends { id: string }>(
  map: Map<string, T>,
  id: string,
  changes: { [K in keyof T]?: T[K] | undefined },
): void {
  const current = map.get(id);
  if (!current) return;
  const defined = Object.fromEntries(Object.entries(changes).filter(([, v]) => v !== undefined));
  map.set(id, { ...current, ...defined });
}

function without<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const { [key]: _drop, ...rest } = obj;
  return rest;
}

function after(keys: string[]): string {
  const last = keys.reduce<string | null>((max, k) => (max === null || k > max ? k : max), null);
  return generateKeyBetween(last, null);
}

function descendants<T extends { id: string }>(
  map: Map<string, T>,
  rootId: string,
  parentOf: (x: T) => string | null,
): string[] {
  const out: string[] = [];
  const queue = [rootId];
  for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
    for (const item of map.values()) {
      if (parentOf(item) === id) {
        out.push(item.id);
        queue.push(item.id);
      }
    }
  }
  return out;
}

function renameLabel(d: Draft, from: string, to: string | null): void {
  for (const t of d.tasks.values()) {
    if (!t.labels.includes(from)) continue;
    const labels =
      to === null ? t.labels.filter((l) => l !== from) : t.labels.map((l) => (l === from ? to : l));
    d.tasks.set(t.id, { ...t, labels });
  }
}
