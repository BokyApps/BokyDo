import { InvitationsPage, JoinPage } from './pages/SharingPages.js';
import type { InstanceStatus, SessionInfo } from '@bokydo/shared';
import {
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from './components/AppShell.js';
import { RouteAnnouncer } from './components/RouteAnnouncer.js';
import { Spinner } from './components/ui.js';
import { instanceQuery, queryClient, sessionQuery } from './lib/queries.js';
import { AccountSecurityPage } from './pages/AccountSecurityPage.js';
import { AdminSettingsPage } from './pages/AdminSettingsPage.js';
import { AdminUsersPage } from './pages/AdminUsersPage.js';
import { ChangePasswordPage } from './pages/ChangePasswordPage.js';
import { CompletedPage } from './pages/CompletedPage.js';
import { ProductivityPage } from './pages/ProductivityPage.js';
import { ArchivedPage, FilterPage, FiltersLabelsPage, LabelPage } from './pages/LabelsPages.js';
import { TemplatesPage } from './pages/TemplatesPage.js';
import { InboxPage, ProjectView } from './pages/ProjectPage.js';
import { HomeRedirect, TaskLinkPage } from './pages/RoutePages.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { TodayPage } from './pages/TodayPage.js';
import { UpcomingPage } from './pages/UpcomingPage.js';
import { LoginPage } from './pages/LoginPage.js';
import {
  ForgotPasswordPage,
  RegisterPage,
  ResetPasswordPage,
  VerifyEmailPage,
} from './pages/PublicPages.js';
import { SetupPage } from './pages/SetupPage.js';
import { SetupPendingPage } from './pages/SetupPendingPage.js';
import { UnsubscribePage } from './pages/UnsubscribePage.js';
import { stashOAuthRequest } from './lib/oauth.js';
import { ConsentPage } from './pages/ConsentPage.js';
import { AdminBackupsPage } from './pages/AdminBackupsPage.js';

type Gate = '/login' | '/change-password' | '/account/security' | '/setup' | '/setup-pending';
/** Screens that only make sense while signed out. */
const SIGNED_OUT_ONLY = ['/login', '/forgot-password', '/reset-password', '/register', '/invite'];
/** Screens that are only reachable as the current gate. */
const GATE_ONLY = ['/change-password', '/setup', '/setup-pending'];

/** Where the user must be right now, or null when the app itself is available. */
function requiredGate(instance: InstanceStatus, session: SessionInfo | null): Gate | null {
  if (!session) return '/login';
  if (session.user.mustChangePassword) return '/change-password';
  if (session.user.mustEnrollMfa) return '/account/security';
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
  if (!session && SIGNED_OUT_ONLY.includes(path)) return;
  if (gate === path) return;
  if (gate) throw redirect({ to: gate });
  if (SIGNED_OUT_ONLY.includes(path) || GATE_ONLY.includes(path)) throw redirect({ to: '/' });
  if (opts.adminOnly && !session?.user.isAdmin) throw redirect({ to: '/' });
}

const RootLayout = () => (
  <>
    <RouteAnnouncer />
    <Outlet />
  </>
);
const rootRoute = createRootRoute({ component: RootLayout, pendingComponent: Spinner });
const page = (path: string, component: () => React.ReactNode, opts?: { adminOnly?: boolean }) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => guard(path, opts),
    component,
  });

const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AppShell });
const appPage = (path: string, component: () => React.ReactNode, opts?: { adminOnly?: boolean }) =>
  createRoute({
    getParentRoute: () => appRoute,
    path,
    beforeLoad: () => guard(path, opts),
    component,
  });

const projectRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/project/$projectId',
  beforeLoad: () => guard('/project'),
  component: function Project() {
    const { projectId } = projectRoute.useParams();
    return <ProjectView key={projectId} projectId={projectId} />;
  },
});
const labelRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/label/$name',
  beforeLoad: () => guard('/label'),
  component: function Label() {
    const { name } = labelRoute.useParams();
    return <LabelPage key={name} name={name} />;
  },
});
const filterRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/filter/$filterId',
  beforeLoad: () => guard('/filter'),
  component: function Filter() {
    const { filterId } = filterRoute.useParams();
    return <FilterPage id={filterId} />;
  },
});
const taskRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/task/$taskId',
  beforeLoad: () => guard('/task'),
  component: function TaskLink() {
    const { taskId } = taskRoute.useParams();
    return <TaskLinkPage taskId={taskId} />;
  },
});

const routeTree = rootRoute.addChildren([
  page('/login', LoginPage),
  page('/forgot-password', ForgotPasswordPage),
  page('/reset-password', ResetPasswordPage),
  page('/register', () => <RegisterPage />),
  page('/invite', () => <RegisterPage invite />),
  // Works signed in or out (the link may be opened on another device).
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/verify-email',
    component: VerifyEmailPage,
  }),
  // Opened from an email; the signed link is enough (no sign-in).
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/unsubscribe',
    component: UnsubscribePage,
  }),
  // An app's sign-in request (OAuth). The handle moves from the fragment into this tab's
  // storage first, so it survives the detour through sign-in.
  createRoute({
    getParentRoute: () => rootRoute,
    path: '/oauth/consent',
    beforeLoad: async () => {
      stashOAuthRequest();
      await guard('/oauth/consent');
    },
    component: ConsentPage,
  }),
  page('/change-password', ChangePasswordPage),
  page('/setup', SetupPage),
  page('/setup-pending', SetupPendingPage),
  page('/account/password', ChangePasswordPage),
  appRoute.addChildren([
    appPage('/', HomeRedirect),
    appPage('/inbox', InboxPage),
    appPage('/today', TodayPage),
    appPage('/upcoming', UpcomingPage),
    appPage('/completed', CompletedPage),
    appPage('/productivity', ProductivityPage),
    appPage('/filters-labels', FiltersLabelsPage),
    appPage('/templates', TemplatesPage),
    appPage('/archived', ArchivedPage),
    appPage('/settings', () => <SettingsPage />),
    appPage('/settings/notifications', () => <SettingsPage initialTab="notifications" />),
    appPage('/settings/calendar', () => <SettingsPage initialTab="calendar" />),
    appPage('/settings/apps', () => <SettingsPage initialTab="apps" />),
    appPage('/settings/data', () => <SettingsPage initialTab="data" />),
    appPage('/invitations', InvitationsPage),
    appPage('/join', JoinPage),
    projectRoute,
    labelRoute,
    filterRoute,
    taskRoute,
    appPage('/account/security', AccountSecurityPage),
    appPage('/admin/settings', AdminSettingsPage, { adminOnly: true }),
    appPage('/admin/users', AdminUsersPage, { adminOnly: true }),
    appPage('/admin/backups', AdminBackupsPage, { adminOnly: true }),
  ]),
]);

export const router = createRouter({ routeTree, defaultPendingComponent: Spinner });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
