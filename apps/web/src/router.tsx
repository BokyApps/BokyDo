import type { InstanceStatus, SessionInfo } from '@bokydo/shared';
import {
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
  type RouteComponent,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from './components/AppShell.js';
import { RouteAnnouncer } from './components/RouteAnnouncer.js';
import { Spinner } from './components/ui.js';
import { instanceQuery, queryClient, sessionQuery } from './lib/queries.js';
import { stashOAuthRequest } from './lib/oauth.js';

/**
 * Route-level code splitting (F-023): each screen is its own chunk, loaded on navigation. The
 * start-up bundle keeps only the shell and the guard; Settings, Admin, Productivity, the project
 * views (board, calendar) and the import/AI panels arrive when they are opened.
 */
function lazy<T extends Record<string, unknown>, K extends keyof T & string>(
  importer: () => Promise<T>,
  name: K,
) {
  return lazyRouteComponent(importer, name);
}

const HomeRedirect = lazy(() => import('./pages/RoutePages.js'), 'HomeRedirect');
const TaskLinkPage = lazy(() => import('./pages/RoutePages.js'), 'TaskLinkPage');
const LoginPage = lazy(() => import('./pages/LoginPage.js'), 'LoginPage');
const ForgotPasswordPage = lazy(() => import('./pages/PublicPages.js'), 'ForgotPasswordPage');
const ResetPasswordPage = lazy(() => import('./pages/PublicPages.js'), 'ResetPasswordPage');
const VerifyEmailPage = lazy(() => import('./pages/PublicPages.js'), 'VerifyEmailPage');
const RegisterPage = lazy(() => import('./pages/PublicPages.js'), 'RegisterPage');
const UnsubscribePage = lazy(() => import('./pages/UnsubscribePage.js'), 'UnsubscribePage');
const ConsentPage = lazy(() => import('./pages/ConsentPage.js'), 'ConsentPage');
const ChangePasswordPage = lazy(
  () => import('./pages/ChangePasswordPage.js'),
  'ChangePasswordPage',
);
const SetupPage = lazy(() => import('./pages/SetupPage.js'), 'SetupPage');
const SetupPendingPage = lazy(() => import('./pages/SetupPendingPage.js'), 'SetupPendingPage');
const InboxPage = lazy(() => import('./pages/ProjectPage.js'), 'InboxPage');
const ProjectView = lazy(() => import('./pages/ProjectPage.js'), 'ProjectView');
const LabelPage = lazy(() => import('./pages/LabelsPages.js'), 'LabelPage');
const FilterPage = lazy(() => import('./pages/LabelsPages.js'), 'FilterPage');
const FiltersLabelsPage = lazy(() => import('./pages/LabelsPages.js'), 'FiltersLabelsPage');
const ArchivedPage = lazy(() => import('./pages/LabelsPages.js'), 'ArchivedPage');
const TodayPage = lazy(() => import('./pages/TodayPage.js'), 'TodayPage');
const UpcomingPage = lazy(() => import('./pages/UpcomingPage.js'), 'UpcomingPage');
const CompletedPage = lazy(() => import('./pages/CompletedPage.js'), 'CompletedPage');
const ProductivityPage = lazy(() => import('./pages/ProductivityPage.js'), 'ProductivityPage');
const TemplatesPage = lazy(() => import('./pages/TemplatesPage.js'), 'TemplatesPage');
const SettingsPage = lazy(() => import('./pages/SettingsPage.js'), 'SettingsPage');
const InvitationsPage = lazy(() => import('./pages/SharingPages.js'), 'InvitationsPage');
const JoinPage = lazy(() => import('./pages/SharingPages.js'), 'JoinPage');
const AccountSecurityPage = lazy(
  () => import('./pages/AccountSecurityPage.js'),
  'AccountSecurityPage',
);
const AdminSettingsPage = lazy(() => import('./pages/AdminSettingsPage.js'), 'AdminSettingsPage');
const AdminUsersPage = lazy(() => import('./pages/AdminUsersPage.js'), 'AdminUsersPage');
const AdminBackupsPage = lazy(() => import('./pages/AdminBackupsPage.js'), 'AdminBackupsPage');

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
const page = (path: string, component: RouteComponent, opts?: { adminOnly?: boolean }) =>
  createRoute({
    getParentRoute: () => rootRoute,
    path,
    beforeLoad: () => guard(path, opts),
    component,
  });

const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: AppShell });
const appPage = (path: string, component: RouteComponent, opts?: { adminOnly?: boolean }) =>
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
  page('/register', RegisterPage),
  page('/invite', () => <RegisterPage invite />),
  // Works signed in or out (the link may be opened on another device).
  page('/verify-email', VerifyEmailPage),
  // Opened from an email; the signed link is enough (no sign-in).
  page('/unsubscribe', UnsubscribePage),
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
    appPage('/settings', SettingsPage),
    appPage('/settings/notifications', () => <SettingsPage initialTab="notifications" />),
    appPage('/settings/calendar', () => <SettingsPage initialTab="calendar" />),
    appPage('/settings/apps', () => <SettingsPage initialTab="apps" />),
    appPage('/settings/ai', () => <SettingsPage initialTab="ai" />),
    appPage('/settings/data', () => <SettingsPage initialTab="data" />),
    appPage('/settings/device', () => <SettingsPage initialTab="device" />),
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
