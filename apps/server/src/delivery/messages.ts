import type { NotificationEvent, NotificationType } from '@bokydo/shared';
import type { PushMessage } from './webpush.js';

/** Which preference governs a notification type. */
export function eventOf(type: NotificationType): NotificationEvent {
  switch (type) {
    case 'reminder':
    case 'assigned':
    case 'mentioned':
    case 'commented':
    case 'invited':
    case 'completed':
    case 'security':
      return type;
    case 'role_changed':
    case 'removed_from_project':
    case 'became_owner':
      return 'sharing';
  }
}

/** One line of user-supplied text, safe for a subject line or a push title. */
export function clean(value: unknown, max = 120): string {
  const s = typeof value === 'string' ? value : '';
  // Control characters (incl. CR/LF) become spaces: no header or line injection.
  // eslint-disable-next-line no-control-regex
  const flat = s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export interface NotificationContent {
  /** Subject line / push title. */
  title: string;
  /** Extra lines (an excerpt), or empty. */
  detail: string;
  /** Same-origin path to open. */
  path: string;
}

export function contentOf(
  n: {
    type: NotificationType;
    data: Record<string, unknown>;
    taskId: string | null;
    projectId: string | null;
  },
  actor: string | null,
): NotificationContent {
  const d = n.data;
  const who = clean(actor, 60) || 'Someone';
  const title = d.title ? `“${clean(d.title, 80)}”` : 'a task';
  const place = d.workspaceName
    ? `the team “${clean(d.workspaceName, 60)}”`
    : d.projectName
      ? `“${clean(d.projectName, 60)}”`
      : d.name
        ? `“${clean(d.name, 60)}”`
        : 'a project';
  const path = n.taskId ? `/task/${n.taskId}` : n.projectId ? `/project/${n.projectId}` : '/';
  const excerpt = typeof d.excerpt === 'string' ? d.excerpt.slice(0, 280) : '';
  switch (n.type) {
    case 'reminder':
      return { title: `Reminder: ${title}${d.late ? ' (sent late)' : ''}`, detail: '', path };
    case 'assigned':
      return { title: `${who} assigned ${title} to you`, detail: '', path };
    case 'mentioned':
      return {
        title: `${who} mentioned you${d.title ? ` on ${title}` : ` in ${place}`}`,
        detail: excerpt,
        path,
      };
    case 'commented':
      return { title: `${who} commented on ${title}`, detail: excerpt, path };
    case 'invited':
      return { title: `${who} invited you to ${place}`, detail: '', path: '/invitations' };
    case 'completed':
      return { title: `${who} completed ${title}`, detail: '', path };
    case 'role_changed':
      return { title: `${who} made you ${clean(d.role, 20)} in ${place}`, detail: '', path };
    case 'removed_from_project':
      return { title: `${who} removed you from ${place}`, detail: '', path: '/' };
    case 'became_owner':
      return { title: `${who} made you the owner of ${place}`, detail: '', path };
    case 'security':
      return {
        title: clean(d.message) || 'Security alert on your account',
        detail: '',
        path: '/account/security',
      };
  }
}

export function pushMessageOf(c: NotificationContent, tag?: string): PushMessage {
  return {
    title: c.title,
    body: c.detail ? clean(c.detail, 200) : '',
    url: c.path,
    ...(tag ? { tag } : {}),
  };
}
