import { NOTIFICATION_EVENTS, type NotificationEvent } from '@bokydo/shared';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Alert, AuthLayout, Button } from '../components/ui.js';
import { api } from '../lib/api.js';
import { EVENT_LABEL_KEY } from './NotificationSettings.js';

const describe = (t: TFunction, topic: string) =>
  topic === 'digest'
    ? t('unsubscribe.digest')
    : topic === 'report'
      ? t('unsubscribe.report')
      : (NOTIFICATION_EVENTS as readonly string[]).includes(topic)
        ? t('unsubscribe.quoted', { topic: t(EVENT_LABEL_KEY[topic as NotificationEvent]) })
        : null;

/** /unsubscribe#<token>: stop one kind of email, signed in or not (the link is the proof). */
export function UnsubscribePage() {
  const { t } = useTranslation();
  const [token] = useState(() => (location.hash.length > 1 ? location.hash.slice(1) : ''));
  const topic = describe(t, token.split('.')[1] ?? '');
  useEffect(() => {
    if (location.hash) history.replaceState(null, '', '/unsubscribe');
  }, []);
  const stop = useMutation({
    mutationFn: () => api('POST', '/api/v1/notifications/unsubscribe', { token }),
  });
  return (
    <AuthLayout>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">{t('unsubscribe.title')}</h1>
        {!topic ? (
          <Alert tone="error">{t('unsubscribe.incomplete')}</Alert>
        ) : stop.isSuccess ? (
          <>
            <Alert tone="success">{t('unsubscribe.done', { topic })}</Alert>
            <p className="text-sm text-muted">
              {t('unsubscribe.changeInPrefix')}{' '}
              <Link to="/settings/notifications" className="text-accent underline">
                {t('unsubscribe.changeInLink')}
              </Link>
              .
            </p>
          </>
        ) : (
          <>
            <p>{t('unsubscribe.confirm', { topic })}</p>
            {stop.isError && <Alert tone="error">{t('unsubscribe.invalid')}</Alert>}
            <Button busy={stop.isPending} onClick={() => stop.mutate()}>
              {t('unsubscribe.stop')}
            </Button>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
