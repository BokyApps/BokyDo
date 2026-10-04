import type { InstanceStatus, SessionInfo } from '@bokydo/shared';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from './components/AppShell.js';
import { Spinner } from './components/ui.js';
import { instanceQuery, queryClient, sessionQuery } from './lib/queries.js';
import { AdminSettingsPage } from './pages/AdminSettingsPage.js';
import { ChangePasswordPage } from './pages/ChangePasswordPage.js';
import { HomePage } from './pages/HomePage.js';
import { LoginPage } from './pages/LoginPage.js';
import { SetupPage } from './pages/SetupPage.js';
import { SetupPendingPage } from './pages/SetupPendingPage.js';

type Gate = '/login' | '/change-password' | '/setup' | '/setup-pending';
const GATES: string[] = ['/login', '/change-password', '/setup', '/setup-pending'];

/** Where the user must be right now, or null when the app itself is available. */
function requiredGate(instance: InstanceStatus, session: SessionInfo | null): Gate | null {
  if (!session) return '/login';
  if (session.user.mustChangePassword) return '/change-password';
  if (!instance.setupComplete) return session.user.isAdmin ? '/setup' : '/setup-pending';
  return null;
}

/** Route guard: the server enforces all of this too; this just keeps the UI on the right screen. */
async function guard(path: string, opts: { adminOnly?: boolean } = {}) {
  // fetchQuery refetches anything invalidated (e.g. right after sign-in) and otherwise serves the cache.
  const [instance, session] = await Promise.all([
    queryClient.fetchQuery(instanceQuery),
    queryClient.fetchQuery(sessionQuery),
  ]);
  const gate = requiredGate(instance, session);
  if (gate === path) return;
  if (gate) throw redirect({ to: gate });
  if (GATES.includes(path)) throw redirect({ to: '/' });
  if (opts.adminOnly && !session?.user.isAdmin) throw redirect({ to: '/' });
}

const rootRoute = createRootRoute({ component: Outlet, pendingComponent: Spinner });

const gateRoute = (path: Gate, component: () => React.ReactNode) =>
  createRoute({ getParentRoute: () => rootRoute, path, beforeLoad: () => guard(path), component });

const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AppShell });
const homeRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  beforeLoad: () => guard('/'),
  component: HomePage,
});
const adminSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/admin/settings',
  beforeLoad: () => guard('/admin/settings', { adminOnly: true }),
  component: AdminSettingsPage,
});
const accountPasswordRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/account/password',
  beforeLoad: () => guard('/account/password'),
  component: ChangePasswordPage,
});

const routeTree = rootRoute.addChildren([
  gateRoute('/login', LoginPage),
  gateRoute('/change-password', ChangePasswordPage),
  gateRoute('/setup', SetupPage),
  gateRoute('/setup-pending', SetupPendingPage),
  accountPasswordRoute,
  appRoute.addChildren([homeRoute, adminSettingsRoute]),
]);

export const router = createRouter({ routeTree, defaultPendingComponent: Spinner });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
