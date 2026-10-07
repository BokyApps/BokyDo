import { NotificationBell } from './Notifications.js';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { resyncPush } from '../lib/push.js';
import { api, clearCsrfToken } from '../lib/api.js';
import { ConfirmProvider } from '../lib/confirm.js';
import { sessionQuery } from '../lib/queries.js';
import { PreferenceEffects, SyncProvider, usePreferences } from '../lib/sync.js';
import { TaskUIProvider, useTaskUI } from '../lib/task-ui.js';
import { ToastProvider } from '../lib/toasts.js';
import { MenuIcon, PlusIcon, SettingsIcon } from './icons.js';
import { BulkBar, QuickAddDialog, SearchDialog, ShortcutsDialog } from './Overlays.js';
import { Sidebar } from './Sidebar.js';
import { TaskDetailDialog } from './TaskDetail.js';
import { IconButton, Logo, MenuItem, Popover } from './ui.js';

/** Signed-in layout: providers for sync, toasts and task UI around the sidebar + page. */
export function AppShell() {
  return (
    <ToastProvider>
      <ConfirmProvider>
        <SyncProvider>
          <TaskUIProvider>
            <PreferenceEffects />
            <Layout />
          </TaskUIProvider>
        </SyncProvider>
      </ConfirmProvider>
    </ToastProvider>
  );
}

const isTyping = (t: EventTarget | null) =>
  t instanceof HTMLElement &&
  (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

function Layout() {
  const ui = useTaskUI();
  const navigate = useNavigate();
  const shortcuts = usePreferences().keyboardShortcuts;
  const [sidebarOpen, setSidebarOpen] = useState(
    () => window.matchMedia('(min-width: 768px)').matches,
  );
  const [searchOpen, setSearchOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const pendingG = useRef(false);

  // Push: re-attach this browser's subscription to the current session, and open what a
  // clicked notification points at (same-origin paths only).
  useEffect(() => {
    void resyncPush().catch(() => undefined);
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (e: MessageEvent<{ type?: string; url?: unknown }>) => {
      const url = e.data?.url;
      if (e.data?.type === 'bokydo:open' && typeof url === 'string' && /^\/(?!\/)/.test(url))
        void navigate({ href: url });
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [navigate]);

  // Global keyboard shortcuts (Todoist-like). Ignored while typing or when a dialog is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || document.querySelector('dialog[open]')) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchOpen(true);
        return;
      }
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Single-character shortcuts can be turned off (WCAG 2.1.4); Ctrl+K above always works.
      if (!shortcuts) return;
      if (pendingG.current) {
        pendingG.current = false;
        const to = {
          i: '/inbox',
          t: '/today',
          u: '/upcoming',
          f: '/filters-labels',
          c: '/completed',
        }[e.key] as
          '/inbox' | '/today' | '/upcoming' | '/filters-labels' | '/completed' | undefined;
        if (to) {
          e.preventDefault();
          void navigate({ to });
        }
        return;
      }
      if (e.key === 'q' || e.key === 'a') {
        e.preventDefault();
        ui.openQuickAdd();
      } else if (e.key === '/') {
        e.preventDefault();
        setSearchOpen(true);
      } else if (e.key === '?') setHelpOpen(true);
      else if (e.key === 'g') {
        pendingG.current = true;
        setTimeout(() => (pendingG.current = false), 1200);
      } else if (e.key === 'm') setSidebarOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [ui, navigate, shortcuts]);

  return (
    <div className="flex h-svh flex-col">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded focus:bg-surface focus:p-2"
      >
        Skip to content
      </a>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line bg-surface px-2">
        <IconButton
          label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          aria-expanded={sidebarOpen}
          onClick={() => setSidebarOpen(!sidebarOpen)}
        >
          <MenuIcon />
        </IconButton>
        <Link to="/" aria-label="BokyDo home">
          <Logo className="text-lg" />
        </Link>
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label={shortcuts ? 'Quick add (q)' : 'Quick add'}
            onClick={() => ui.openQuickAdd()}
          >
            <PlusIcon />
          </IconButton>
          <NotificationBell />
          <UserMenu onShortcuts={() => setHelpOpen(true)} />
        </div>
      </header>
      <div className="relative flex min-h-0 flex-1">
        {sidebarOpen && (
          <>
            <div
              className="fixed inset-0 top-12 z-20 bg-black/30 md:hidden"
              onClick={() => setSidebarOpen(false)}
              aria-hidden
            />
            <aside className="absolute inset-y-0 left-0 z-30 w-72 border-r border-line bg-surface md:static md:z-auto md:w-64 md:bg-bg">
              <Sidebar
                onSearch={() => setSearchOpen(true)}
                onNavigate={() =>
                  !window.matchMedia('(min-width: 768px)').matches && setSidebarOpen(false)
                }
              />
            </aside>
          </>
        )}
        <main id="main" className="min-w-0 flex-1 overflow-y-auto focus:outline-none">
          <Outlet />
        </main>
      </div>
      <TaskDetailDialog />
      <QuickAddDialog />
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
      <ShortcutsDialog open={helpOpen} onClose={() => setHelpOpen(false)} />
      <BulkBar />
    </div>
  );
}

function UserMenu({ onShortcuts }: { onShortcuts: () => void }) {
  const { data: session } = useQuery(sessionQuery);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({
    mutationFn: () => api('POST', '/api/v1/auth/logout'),
    onSettled: async () => {
      clearCsrfToken();
      queryClient.clear();
      await navigate({ to: '/login' });
    },
  });
  const go = (
    to: '/settings' | '/account/security' | '/admin/users' | '/admin/settings' | '/admin/backups',
    close: () => void,
  ) => {
    close();
    void navigate({ to });
  };
  return (
    <Popover
      align="right"
      trigger={(p) => (
        <button
          type="button"
          {...p}
          className="flex items-center gap-2 rounded-lg px-2 py-1 text-sm hover:bg-surface-alt"
        >
          <span
            aria-hidden
            className="flex size-7 items-center justify-center rounded-full bg-accent text-xs font-semibold text-on-accent"
          >
            {session?.user.username.slice(0, 1).toUpperCase()}
          </span>
          <span className="hidden sm:inline">{session?.user.username}</span>
          <span className="sr-only">, account menu</span>
        </button>
      )}
    >
      {(close) => (
        <>
          <MenuItem icon={<SettingsIcon />} onClick={() => go('/settings', close)}>
            Settings
          </MenuItem>
          <MenuItem onClick={() => go('/account/security', close)}>Account security</MenuItem>
          {session?.user.isAdmin && (
            <>
              <MenuItem onClick={() => go('/admin/users', close)}>Admin: users</MenuItem>
              <MenuItem onClick={() => go('/admin/settings', close)}>Admin: settings</MenuItem>
              <MenuItem onClick={() => go('/admin/backups', close)}>Admin: backups</MenuItem>
            </>
          )}
          <MenuItem
            onClick={() => {
              close();
              onShortcuts();
            }}
          >
            Keyboard shortcuts
          </MenuItem>
          <div className="my-1 border-t border-line" />
          <MenuItem onClick={() => logout.mutate()}>Sign out</MenuItem>
        </>
      )}
    </Popover>
  );
}
