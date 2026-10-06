import { NOTIFICATION_EVENTS, type NotificationEvent } from '@bokydo/shared';
import { useMutation } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Alert, AuthLayout, Button } from '../components/ui.js';
import { api } from '../lib/api.js';
import { EVENT_LABEL } from './NotificationSettings.js';

const describe = (topic: string) =>
  topic === 'digest'
    ? 'the daily digest'
    : (NOTIFICATION_EVENTS as readonly string[]).includes(topic)
      ? `“${EVENT_LABEL[topic as NotificationEvent]}”`
      : null;

/** /unsubscribe#<token>: stop one kind of email, signed in or not (the link is the proof). */
export function UnsubscribePage() {
  const [token] = useState(() => (location.hash.length > 1 ? location.hash.slice(1) : ''));
  const topic = describe(token.split('.')[1] ?? '');
  useEffect(() => {
    if (location.hash) history.replaceState(null, '', '/unsubscribe');
  }, []);
  const stop = useMutation({
    mutationFn: () => api('POST', '/api/v1/notifications/unsubscribe', { token }),
  });
  return (
    <AuthLayout>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold">Email notifications</h1>
        {!topic ? (
          <Alert tone="error">This link is incomplete. Open it from the email again.</Alert>
        ) : stop.isSuccess ? (
          <>
            <Alert tone="success">Done. You won't get emails about {topic} any more.</Alert>
            <p className="text-sm text-muted">
              You can change this any time in{' '}
              <Link to="/settings/notifications" className="text-accent underline">
                Settings → Notifications
              </Link>
              .
            </p>
          </>
        ) : (
          <>
            <p>Stop emails about {topic}? You'll still see them in the app.</p>
            {stop.isError && (
              <Alert tone="error">This link isn't valid any more. Change it in Settings.</Alert>
            )}
            <Button busy={stop.isPending} onClick={() => stop.mutate()}>
              Stop these emails
            </Button>
          </>
        )}
      </div>
    </AuthLayout>
  );
}
