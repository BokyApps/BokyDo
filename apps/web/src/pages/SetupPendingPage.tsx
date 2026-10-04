import { AuthLayout } from '../components/ui.js';

export function SetupPendingPage() {
  return (
    <AuthLayout>
      <h1 className="text-lg font-semibold">Almost ready</h1>
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        An administrator is still setting up this BokyDo instance. Check back soon.
      </p>
    </AuthLayout>
  );
}
