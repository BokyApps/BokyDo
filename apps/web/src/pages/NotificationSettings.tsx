import {
  NOTIFICATION_EVENTS,
  type NotificationEvent,
  type NotificationPrefs,
  type NotificationPrefsPatch,
  type Preferences,
} from '@bokydo/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, Button, Card, Checkbox, inputClass, SelectField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { disablePush, enablePush, pushState, type PushState } from '../lib/push.js';
import { aiCatalogQuery, instanceQuery } from '../lib/queries.js';
import { relativeLabel } from '../lib/reminders.js';

// Labels come from the catalogue; the keys are the raw event values.
export const EVENT_LABEL_KEY: Record<NotificationEvent, string> = {
  reminder: 'settings.notifications.events.reminder',
  assigned: 'settings.notifications.events.assigned',
  mentioned: 'settings.notifications.events.mentioned',
  commented: 'settings.notifications.events.commented',
  invited: 'settings.notifications.events.invited',
  sharing: 'settings.notifications.events.sharing',
  completed: 'settings.notifications.events.completed',
  security: 'settings.notifications.events.security',
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
  const { t } = useTranslation();
  const n = prefs.notifications;
  const set = (patch: NotificationPrefsPatch) => update({ notifications: patch });
  const instance = useQuery(instanceQuery);
  const eventLabel = (e: NotificationEvent) => t(EVENT_LABEL_KEY[e]);
  return (
    <>
      <PushSection />
      <Section title={t('settings.notifications.whatToSend')}>
        {!instance.data?.emailEnabled && (
          <p className="mb-3 text-sm text-muted">{t('settings.notifications.emailNotSetUp')}</p>
        )}
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="pb-2 font-medium">{t('settings.notifications.tableHeader')}</th>
              <th className="w-16 pb-2 text-center font-medium">{t('settings.notifications.email')}</th>
              <th className="w-16 pb-2 text-center font-medium">{t('settings.notifications.push')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {NOTIFICATION_EVENTS.map((e) => (
              <tr key={e}>
                <td className="py-2">{eventLabel(e)}</td>
                {(['email', 'push'] as const).map((ch) => (
                  <td key={ch} className="text-center">
                    <input
                      type="checkbox"
                      className="size-4 accent-accent"
                      aria-label={t('settings.notifications.byChannel', {
                        event: eventLabel(e),
                        channel: t(`settings.notifications.${ch}`),
                      })}
                      checked={n.channels[e][ch]}
                      disabled={e === 'security' && ch === 'email'}
                      title={
                        e === 'security' && ch === 'email'
                          ? t('settings.notifications.securityEmailNote')
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
        <p className="mt-3 text-xs text-muted">{t('settings.notifications.emailsNote')}</p>
      </Section>

      <Section title={t('settings.notifications.reminders')}>
        <SelectField
          label={t('settings.notifications.autoReminder')}
          value={n.autoReminder === null ? 'off' : String(n.autoReminder)}
          onChange={(e) =>
            set({ autoReminder: e.target.value === 'off' ? null : Number(e.target.value) })
          }
          options={AUTO_OPTIONS.map((m) => ({
            value: m === null ? 'off' : String(m),
            label: m === null ? t('settings.notifications.off') : relativeLabel(m),
          }))}
        />
        <p className="mt-1 text-xs text-muted">{t('settings.notifications.autoReminderNote')}</p>
      </Section>

      <Section title={t('settings.notifications.quietHours')}>
        <div className="space-y-3">
          <Checkbox
            label={t('settings.notifications.quietEnabled')}
            hint={t('settings.notifications.quietHint')}
            checked={n.quietHours.enabled}
            onChange={(e) => set({ quietHours: { enabled: e.target.checked } })}
          />
          <div className="flex items-center gap-2 text-sm">
            <TimeInput
              label={t('settings.notifications.quietFrom')}
              value={n.quietHours.start}
              onChange={(start) => set({ quietHours: { start } })}
            />
            {t('settings.notifications.to')}
            <TimeInput
              label={t('settings.notifications.quietUntil')}
              value={n.quietHours.end}
              onChange={(end) => set({ quietHours: { end } })}
            />
          </div>
        </div>
      </Section>

      <Section title={t('settings.notifications.digest')}>
        <div className="space-y-3">
          <Checkbox
            label={t('settings.notifications.digestEnabled')}
            hint={t('settings.notifications.digestHint')}
            checked={n.digest.enabled}
            onChange={(e) => set({ digest: { enabled: e.target.checked } })}
          />
          <div className="flex items-center gap-2 text-sm">
            {t('settings.notifications.at')}
            <TimeInput
              label={t('settings.notifications.digestTime')}
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
  const { t } = useTranslation();
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
      setMessage(t('settings.notifications.pushError'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section title={t('settings.notifications.pushTitle')}>
      {state === 'unsupported' && (
        <p className="text-sm text-muted">{t('settings.notifications.pushUnsupported')}</p>
      )}
      {state === 'insecure' && (
        <Alert tone="error">{t('settings.notifications.pushInsecure')}</Alert>
      )}
      {state === 'denied' && (
        <p className="text-sm text-muted">{t('settings.notifications.pushDenied')}</p>
      )}
      {(state === 'off' || state === 'on') && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex-1 text-sm">
            {state === 'on'
              ? t('settings.notifications.pushOn')
              : t('settings.notifications.pushOff')}
          </span>
          {state === 'on' ? (
            <>
              <Button
                variant="secondary"
                busy={busy}
                onClick={() =>
                  void run(async () => {
                    const r = await api<{ sent: number }>('POST', '/api/v1/push/test');
                    setMessage(r.sent ? t('settings.notifications.pushSent') : t('settings.notifications.pushNothing'));
                  })
                }
              >
                {t('settings.notifications.pushTest')}
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
                {t('settings.notifications.turnOff')}
              </Button>
            </>
          ) : (
            <Button busy={busy} onClick={() => void run(async () => setState(await enablePush()))}>
              {t('settings.notifications.turnOn')}
            </Button>
          )}
        </div>
      )}
      {message && <p className="mt-2 text-sm text-muted">{message}</p>}
    </Section>
  );
}

// Weekday names come from the catalogue; the keys are the preference values.
const WEEKDAY_KEY = {
  monday: 'settings.notifications.weekday.monday',
  tuesday: 'settings.notifications.weekday.tuesday',
  wednesday: 'settings.notifications.weekday.wednesday',
  thursday: 'settings.notifications.weekday.thursday',
  friday: 'settings.notifications.weekday.friday',
  saturday: 'settings.notifications.weekday.saturday',
  sunday: 'settings.notifications.weekday.sunday',
} as const;

/** The AI report by email (W9): shown only when the user has a model for reports. */
function ReportEmailSettings({
  n,
  set,
}: {
  n: NotificationPrefs;
  set: (patch: NotificationPrefsPatch) => void;
}) {
  const { t } = useTranslation();
  const catalog = useQuery(aiCatalogQuery);
  if (!catalog.data?.available.includes('reports')) return null;
  const r = n.report;
  return (
    <Section title={t('settings.notifications.reportTitle')}>
      <div className="space-y-3">
        <Checkbox
          label={t('settings.notifications.reportEnabled')}
          hint={t('settings.notifications.reportHint')}
          checked={r.enabled}
          onChange={(e) => set({ report: { enabled: e.target.checked } })}
        />
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <SelectField
            label={t('settings.notifications.reportKind')}
            hideLabel
            value={r.kind}
            onChange={(e) => set({ report: { kind: e.target.value as 'day' | 'week' } })}
            options={[
              { value: 'day', label: t('settings.notifications.reportDay') },
              { value: 'week', label: t('settings.notifications.reportWeek') },
            ]}
          />
          {r.kind === 'week' && (
            <>
              {t('settings.notifications.on')}
              <SelectField
                label={t('settings.notifications.weekday')}
                hideLabel
                value={r.weekday}
                onChange={(e) =>
                  set({ report: { weekday: e.target.value as keyof typeof WEEKDAY_KEY } })
                }
                options={Object.entries(WEEKDAY_KEY).map(([value, key]) => ({
                  value,
                  label: t(key),
                }))}
              />
            </>
          )}
          {t('settings.notifications.at')}
          <TimeInput
            label={t('settings.notifications.reportTime')}
            value={r.time}
            onChange={(time) => set({ report: { time } })}
          />
        </div>
      </div>
    </Section>
  );
}
