import type { AppNotification } from '@bokydo/shared';
import { Link, useNavigate } from '@tanstack/react-router';
import { useSend, useSyncState } from '../lib/sync.js';
import { useTaskUI } from '../lib/task-ui.js';
import { Avatar } from './Sharing.js';
import { Button, Popover } from './ui.js';

const text = (n: AppNotification, actor: string): string => {
  const d = n.data;
  const title = typeof d.title === 'string' ? `“${d.title}”` : 'a task';
  const project = typeof d.projectName === 'string' ? `“${d.projectName}”` : 'a project';
  switch (n.type) {
    case 'assigned':
      return `${actor} assigned ${title} to you`;
    case 'mentioned':
      return `${actor} mentioned you${d.title ? ` on ${title}` : ` in ${project}`}`;
    case 'commented':
      return `${actor} commented on ${title}`;
    case 'role_changed':
      return `${actor} made you ${String(d.role)} in ${project}`;
    case 'removed_from_project':
      return `${actor} removed you from ${project}`;
    case 'became_owner':
      return `${actor} made you the owner of ${project}`;
  }
};

export const BellIcon = () => (
  <svg
    viewBox="0 0 24 24"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4" />
  </svg>
);

/** Header bell: unread count and the latest notifications. */
export function NotificationBell() {
  const state = useSyncState();
  const send = useSend();
  const navigate = useNavigate();
  const ui = useTaskUI();
  const unread = state.unreadNotifications;
  const open = (n: AppNotification, close: () => void) => {
    if (!n.read) send('notifications_mark_read', { ids: [n.id] });
    close();
    if (n.taskId && state.tasks.has(n.taskId)) ui.openTask(n.taskId);
    else if (n.projectId && state.projects.has(n.projectId))
      void navigate({ to: '/project/$projectId', params: { projectId: n.projectId } });
  };
  return (
    <Popover
      align="right"
      trigger={(p) => (
        <button
          type="button"
          aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}
          className="relative rounded-md p-1.5 text-muted hover:bg-surface-alt hover:text-fg"
          {...p}
        >
          <BellIcon />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-accent px-1 text-center text-[0.65rem] leading-4 font-semibold text-on-accent">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
        </button>
      )}
      panelClassName="w-80 max-w-[calc(100vw-2rem)]"
    >
      {(close) => (
        <div className="space-y-1 p-1">
          <div className="flex items-center justify-between px-2 py-1">
            <span className="font-semibold">Notifications</span>
            {unread > 0 && (
              <Button
                variant="ghost"
                onClick={() => send('notifications_mark_read', { all: true })}
              >
                Mark all read
              </Button>
            )}
          </div>
          {state.notifications.length === 0 && (
            <p className="px-2 py-3 text-muted">You're all caught up.</p>
          )}
          <ul className="max-h-96 overflow-y-auto">
            {state.notifications.map((n) => {
              const actor =
                (n.actorId && state.collaborators.get(n.actorId)?.username) || 'Someone';
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => open(n, close)}
                    className={`flex w-full gap-2 rounded-md px-2 py-2 text-left hover:bg-surface-alt ${n.read ? 'text-muted' : ''}`}
                  >
                    <Avatar name={actor} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm">{text(n, actor)}</span>
                      {typeof n.data.excerpt === 'string' && (
                        <span className="block truncate text-xs text-muted">{n.data.excerpt}</span>
                      )}
                      <span className="block text-xs text-muted">
                        {new Date(n.createdAt).toLocaleString()}
                      </span>
                    </span>
                    {!n.read && (
                      <span
                        className="mt-1.5 size-2 shrink-0 rounded-full bg-accent"
                        aria-label="unread"
                      />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
          {state.invitations.length > 0 && (
            <Link
              to="/invitations"
              onClick={close}
              className="block rounded-md px-2 py-2 text-sm text-accent hover:bg-surface-alt"
            >
              {state.invitations.length} project invitation
              {state.invitations.length === 1 ? '' : 's'} waiting
            </Link>
          )}
        </div>
      )}
    </Popover>
  );
}
