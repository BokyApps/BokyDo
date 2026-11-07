import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { fetchMobileRelease } from '../lib/mobile-release.js';
import { Button, Card } from './ui.js';

export function MobileAppSettings() {
  const { t } = useTranslation();
  const release = useQuery({
    queryKey: ['mobile-release'],
    queryFn: ({ signal }) => fetchMobileRelease(signal),
    staleTime: 60_000,
    retry: false,
  });
  return (
    <Card className="space-y-6">
      <div className="flex items-center gap-4">
        <img src="/icon-192.png" alt="" className="size-16 shrink-0 rounded-2xl" />
        <div className="min-w-0">
          <h2 className="font-semibold">
            {t('settings.mobile.title', { defaultValue: 'BokyDo for Android' })}
          </h2>
          <p className="mt-1 text-sm text-muted">
            {t('settings.mobile.description', {
              defaultValue: 'Your tasks and habits, with home screen widgets.',
            })}
          </p>
        </div>
      </div>
      <ul className="list-disc space-y-2 pl-5 text-sm">
        <li>
          {t('settings.mobile.tasks', {
            defaultValue: 'Task widgets for Inbox, Today, Upcoming, or a project.',
          })}
        </li>
        <li>
          {t('settings.mobile.habits', {
            defaultValue: 'Habit widgets with check-ins from your home screen.',
          })}
        </li>
      </ul>
      <div aria-live="polite" className="space-y-3">
        {release.isPending && (
          <p className="text-sm text-muted">
            {t('settings.mobile.loading', { defaultValue: 'Checking for a download…' })}
          </p>
        )}
        {release.isError && (
          <>
            <p className="text-sm text-muted">
              {t('settings.mobile.unavailable', {
                defaultValue: 'The Android download is currently unavailable on this server.',
              })}
            </p>
            <Button variant="secondary" onClick={() => void release.refetch()}>
              {t('settings.mobile.retry', { defaultValue: 'Try again' })}
            </Button>
          </>
        )}
        {release.data && (
          <>
            <a
              href={release.data.url}
              download
              className="inline-flex items-center justify-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-on-accent hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t('settings.mobile.download', { defaultValue: 'Download for Android' })}
            </a>
            <p className="text-sm text-muted">
              {t('settings.mobile.version', {
                defaultValue: 'Version {{version}} · {{size}} MB · Android {{android}} or later',
                version: release.data.version,
                size: (release.data.sizeBytes / 1_000_000).toFixed(1),
                android: release.data.minAndroid,
              })}
            </p>
            <details className="text-xs text-muted">
              <summary className="cursor-pointer">
                {t('settings.mobile.checksum', { defaultValue: 'SHA-256 checksum' })}
              </summary>
              <code className="mt-2 block break-all select-all">{release.data.sha256}</code>
            </details>
          </>
        )}
      </div>
      <div className="border-t border-line pt-5">
        <h3 className="mb-3 text-sm font-semibold">
          {t('settings.mobile.install', { defaultValue: 'Install on your phone' })}
        </h3>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-muted">
          <li>
            {t('settings.mobile.stepDownload', {
              defaultValue: 'Open this page on your Android phone and download the APK.',
            })}
          </li>
          <li>
            {t('settings.mobile.stepInstall', {
              defaultValue:
                'Open the downloaded file. If Android asks, allow your browser to install this app, then choose Install.',
            })}
          </li>
          <li>
            {t('settings.mobile.stepSignIn', {
              defaultValue:
                'Open BokyDo, enter the server address below, and sign in with your existing account.',
            })}
          </li>
        </ol>
        <p className="mt-4 text-xs font-medium text-muted">
          {t('settings.mobile.server', { defaultValue: 'Your server address' })}
        </p>
        <code className="mt-1 block break-all select-all rounded-lg bg-surface-alt p-3 text-sm">
          {window.location.origin}
        </code>
        <p className="mt-4 text-sm text-muted">
          {t('settings.mobile.addWidgets', {
            defaultValue:
              'After signing in, long-press your home screen, choose Widgets, and look for BokyDo.',
          })}
        </p>
        <p className="mt-2 text-xs text-muted">
          {t('settings.mobile.updates', {
            defaultValue:
              'To update, install the newer APK over the existing app. Your sign-in and widgets stay in place.',
          })}
        </p>
      </div>
    </Card>
  );
}
