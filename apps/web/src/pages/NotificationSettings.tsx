import {
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationPrefs,
  type NotificationPrefsPatch,
  type Preferences,
} from '@bokydo/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, Button, Card, Checkbox, inputClass, SelectField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push.js';
import { aiCatalogQuery, instanceQuery } from '../lib/queries.js';
import { relativeLabel } from '../lib/reminders.js';

export const EVENT_LABEL: Record<NotificationEvent, string> = {
  reminder: 'Reminders',
  assigned: 'A task is assigned to me',
  mentioned: 'Someone mentions me',
  commented: 'Comments on tasks I follow',
  invited: 'Invitations to projects and teams',
  sharing: 'My role or access changes',
  completed: 'A task I assigned is completed',
  security: 'Security alerts',
};

const AUTO_OPTIONS = [null, 0, 5, 10, 15, 30, 60, 120, 1440] as const;

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="mb-6">
      <h2 className="mb-4 font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

export function NotificationSettings({
  prefs,
  update,
}: {
  prefs: Preferences;
  update: (patch: { notifications: NotificationPrefsPatch }) => void;
}) {
  const n = prefs.notifications;
  const set = (patch: NotificationPrefsPatch) => update({ notifications: patch });
  const instance = useQuery(instanceQuery);
  return (
    <>
      <PushSection />
      <Section title="What to send">
        {!instance.data?.emailEnabled && (
          <p className="mb-3 text-sm text-muted">
            Email isn't set up on this server, so only in-app and push notifications are sent.
          </p>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="pb-2 font-medium">Everything shows in the inbox. Also send…</th>
              <th className="w-16 pb-2 text-center font-medium">Email</th>
              <th className="w-16 pb-2 text-center font-medium">Push</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {NOTIFICATION_EVENTS.map((e) => (
              <tr key={e}>
                <td className="py-2">{EVENT_LABEL[e]}</td>
                {(['email', 'push'] as const).map((ch) => (
                  <td key={ch} className="text-center">
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
                      aria-label={`${EVENT_LABEL[e]} by ${ch}`}
                      checked={n.channels[e][ch]}
                      disabled={e === 'security' && ch === 'email'}
                      title={
                        e === 'security' && ch === 'email'
                          ? 'Security alerts are always emailed to your verified address'
                          : undefined
                      }
                      onChange={(ev) => set({ channels: { [e]: { [ch]: ev.target.checked } } })}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-muted">
          Emails go to your verified address (Account → Security). Every email has a link to stop
          that kind of email.
        </p>
      </Section>

      <Section title="Reminders">
        <SelectField
          label="Automatic reminder for tasks with a time"
          value={n.autoReminder === null ? 'off' : String(n.autoReminder)}
          onChange={(e) =>
            set({ autoReminder: e.target.value === 'off' ? null : Number(e.target.value) })
          }
          options={AUTO_OPTIONS.map((m) => ({
            value: m === null ? 'off' : String(m),
            label: m === null ? 'Off' : relativeLabel(m),
          }))}
        />
        <p className="mt-1 text-xs text-muted">
          For tasks assigned to you, or that you created and nobody is assigned to. You can delete
          it on any task.
        </p>
      </Section>

      <Section title="Quiet hours">
        <div className="space-y-3">
          <Checkbox
            label="Don't send email or push during these hours"
            hint="Reminders and security alerts still come through. Nothing is lost: it's all in your inbox."
            checked={n.quietHours.enabled}
            onChange={(e) => set({ quietHours: { enabled: e.target.checked } })}
          />
          <div className="flex items-center gap-2 text-sm">
            <TimeInput
              label="Quiet from"
              value={n.quietHours.start}
              onChange={(start) => set({ quietHours: { start } })}
            />
            to
            <TimeInput
              label="Quiet until"
              value={n.quietHours.end}
              onChange={(end) => set({ quietHours: { end } })}
            />
          </div>
        </div>
      </Section>

      <Section title="Daily digest">
        <div className="space-y-3">
          <Checkbox
            label="Email me my day each morning"
            hint="Overdue tasks and today's tasks. Not sent on days with nothing due."
            checked={n.digest.enabled}
            onChange={(e) => set({ digest: { enabled: e.target.checked } })}
          />
          <div className="flex items-center gap-2 text-sm">
            At
            <TimeInput
              label="Digest time"
              value={n.digest.time}
              onChange={(time) => set({ digest: { time } })}
            />
          </div>
        </div>
      </Section>

      <ReportEmailSettings n={n} set={set} />
    </>
  );
}

/** Saves on blur; remounted (via `key`) when the stored value changes elsewhere. */
function TimeInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <input
      key={value}
      type="time"
      aria-label={label}
      className={`${inputClass} w-28 py-1`}
      defaultValue={value}
      onBlur={(e) =>
        /^\d\d:\d\d$/.test(e.target.value) && e.target.value !== value && onChange(e.target.value)
      }
    />
  );
}

function PushSection() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    void pushState().then(setState);
  }, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch {
      setMessage('Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title="Push notifications on this device">
      {state === 'unsupported' && (
        <p className="text-sm text-muted">This browser doesn't support push notifications.</p>
      )}
      {state === 'insecure' && (
        <Alert tone="error">
          Push notifications need HTTPS. Ask your administrator to put BokyDo behind HTTPS.
        </Alert>
      )}
      {state === 'denied' && (
        <p className="text-sm text-muted">
          Notifications are blocked for this site in your browser settings. Allow them there, then
          come back.
        </p>
      )}
      {(state === 'off' || state === 'on') && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1 text-sm">
            {state === 'on'
              ? 'On. This browser gets push notifications while you are signed in.'
              : 'Off for this browser.'}
          </span>
          {state === 'on' ? (
            <>
              <Button
                variant="secondary"
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await api<{ sent: number }>('POST', '/api/v1/push/test');
                    setMessage(
                      r.sent ? 'Sent. It should appear in a moment.' : 'Nothing was delivered.',
                    );
                  })
                }
              >
                Send a test
              </Button>
              <Button
                variant="secondary"
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    await disablePush();
                    setState('off');
                  })
                }
              >
                Turn off
              </Button>
            </>
          ) : (
            <Button busy={busy} onClick={() => void run(async () => setState(await enablePush()))}>
              Turn on
            </Button>
          )}
        </div>
      )}
      {message && <p className="mt-2 text-sm text-muted">{message}</p>}
    </Section>
  );
}

const WEEKDAY_LABEL = {
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
  sunday: 'Sunday',
} as const;

/** The AI report by email (W9): shown only when the user has a model for reports. */
function ReportEmailSettings({
  n,
  set,
}: {
  n: NotificationPrefs;
  set: (patch: NotificationPrefsPatch) => void;
}) {
  const catalog = useQuery(aiCatalogQuery);
  if (!catalog.data?.available.includes('reports')) return null;
  const r = n.report;
  return (
    <Section title="AI report by email">
      <div className="space-y-3">
        <Checkbox
          label="Email me a report written by AI"
          hint="Written from your tasks when it is sent, with your AI settings and budget. AI can be wrong: check anything important in the app."
          checked={r.enabled}
          onChange={(e) => set({ report: { enabled: e.target.checked } })}
        />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <SelectField
            label="Report"
            hideLabel
            value={r.kind}
            onChange={(e) => set({ report: { kind: e.target.value as 'day' | 'week' } })}
            options={[
              { value: 'day', label: 'A plan for each day' },
              { value: 'week', label: 'A weekly review' },
            ]}
          />
          {r.kind === 'week' && (
            <>
              on
              <SelectField
                label="Weekday"
                hideLabel
                value={r.weekday}
                onChange={(e) =>
                  set({ report: { weekday: e.target.value as keyof typeof WEEKDAY_LABEL } })
                }
                options={Object.entries(WEEKDAY_LABEL).map(([value, label]) => ({ value, label }))}
              />
            </>
          )}
          at
          <TimeInput
            label="Report time"
            value={r.time}
            onChange={(time) => set({ report: { time } })}
          />
        </div>
      </div>
    </Section>
  );
}
