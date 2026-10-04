import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate } from '@tanstack/react-router';
import { api, clearCsrfToken } from '../lib/api.js';
import { sessionQuery } from '../lib/queries.js';
import { Button, Logo } from './ui.js';

export function AppShell() {
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

  return (
    <div className="min-h-svh">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2 dark:border-neutral-800 dark:bg-neutral-900">
        <Link to="/" aria-label="Home">
          <Logo />
        </Link>
        <nav className="flex items-center gap-1 text-sm">
          {session?.user.isAdmin && (
            <Link
              to="/admin/settings"
              className="rounded-lg px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
              activeProps={{ className: 'font-medium' }}
            >
              Admin
            </Link>
          )}
          <Link
            to="/account/password"
            className="rounded-lg px-3 py-2 hover:bg-neutral-100 dark:hover:bg-neutral-800"
          >
            {session?.user.username}
          </Link>
          <Button variant="ghost" onClick={() => logout.mutate()} busy={logout.isPending}>
            Sign out
          </Button>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
