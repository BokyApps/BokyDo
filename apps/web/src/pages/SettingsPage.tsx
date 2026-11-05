import type { Appearance, Preferences, PreferencesPatch } from '@bokydo/shared';
import { FAMILIES, FONTS, getTheme, TEXT_SIZES, THEMES, type Mode } from '@bokydo/themes';
import { useEffect, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { AccountDataSettings } from '../components/AccountDataSettings.js';
import { AiSettings } from '../components/AiSettings.js';
import { ApiAccessSettings } from '../components/ApiAccessSettings.js';
import { DeviceSettings } from '../components/DeviceSettings.js';
import { WebhookSettings } from '../components/WebhookSettings.js';
import { TimeZonePicker } from '../components/TimeZonePicker.js';
import { Card, Checkbox, SelectField } from '../components/ui.js';
import { Page, ViewHeader } from '../components/ViewHeader.js';
import { AUTO_LANGUAGE, LANGUAGES, rememberLanguage } from '../i18n.js';
import { usePreferences, useSend, useSyncState } from '../lib/sync.js';
import { preloadFonts } from '../lib/appearance.js';
import { useTranslation } from 'react-i18next';
import { CalendarSettings } from './CalendarSettings.js';
import { NotificationSettings } from './NotificationSettings.js';
import { AccountSecurityPage } from './AccountSecurityPage.js';
import { AdminUsersPage } from './AdminUsersPage.js';
import { AdminSettingsPage } from './AdminSettingsPage.js';
import { AdminBackupsPage } from './AdminBackupsPage.js';

/** How each catalogue calls itself, in its own language. */
const LANGUAGE_NAMES: Record<(typeof LANGUAGES)[number], string> = { en: 'English' };

type Tab =
  | 'themes'
  | 'general'
  | 'notifications'
  | 'calendar'
  | 'apps'
  | 'ai'
  | 'webhooks'
  | 'data'
  | 'device';
type SettingsSection = Tab | 'security' | 'admin-users' | 'admin-instance' | 'admin-backups';
export function SettingsPage({ initialTab = 'themes' }: { initialTab?: SettingsSection }) {
  const { t } = useTranslation();
  const prefs = usePreferences();
  const send = useSend();
  const state = useSyncState();
  const isAdmin = Boolean(state.user?.isAdmin);
  const tab = initialTab;
  const update = (patch: PreferencesPatch) => send('user_update_preferences', patch);
  const personal = [
    ['themes', t('settings.tabs.themes', { defaultValue: 'Themes' }), '/settings/themes'],
    ['general', t('settings.tabs.general'), '/settings/general'],
    ['notifications', t('settings.tabs.notifications'), '/settings/notifications'],
    [
      'security',
      t('settings.tabs.security', { defaultValue: 'Account security' }),
      '/settings/security',
    ],
    ['data', t('settings.tabs.data'), '/settings/data'],
    ['device', t('settings.tabs.device'), '/settings/device'],
  ] as const;
  const integrations = [
    ['calendar', t('settings.tabs.calendar'), '/settings/calendar'],
    ['apps', t('settings.tabs.apps'), '/settings/apps'],
    ['ai', t('settings.tabs.ai'), '/settings/ai'],
    ['webhooks', t('settings.tabs.webhooks'), '/settings/webhooks'],
  ] as const;
  const administration = [
    [
      'admin-users',
      t('settings.tabs.adminUsers', { defaultValue: 'Users' }),
      '/settings/admin/users',
    ],
    [
      'admin-instance',
      t('settings.tabs.adminInstance', { defaultValue: 'Instance settings' }),
      '/settings/admin/instance',
    ],
    [
      'admin-backups',
      t('settings.tabs.adminBackups', { defaultValue: 'Backups' }),
      '/settings/admin/backups',
    ],
  ] as const;
  const groups = [
    [t('settings.groups.personal', { defaultValue: 'Personal' }), personal],
    [t('settings.groups.integrations', { defaultValue: 'Integrations' }), integrations],
    ...(isAdmin
      ? [
          [
            t('settings.groups.administration', { defaultValue: 'Administration' }),
            administration,
          ] as const,
        ]
      : []),
  ] as const;
  return (
    <Page wide>
      <ViewHeader title={t('settings.title')} />
      <div className="grid min-w-0 gap-6 md:grid-cols-[13rem_minmax(0,1fr)]">
        <nav
          aria-label={t('settings.navigation', { defaultValue: 'Settings sections' })}
          className="grid grid-cols-2 gap-x-4 gap-y-5 md:block md:space-y-5"
        >
          {groups.map(([title, items]) => (
            <section key={title} className="min-w-0">
              <h2 className="mb-2 px-2 text-xs font-semibold uppercase tracking-wide text-muted">
                {title}
              </h2>
              <div className="space-y-1">
                {items.map(([key, label, to]) => (
                  <Link
                    key={key}
                    to={to}
                    aria-current={tab === key ? 'page' : undefined}
                    className={`block rounded-lg px-3 py-2 text-sm ${tab === key ? 'bg-surface-alt font-medium text-fg' : 'text-muted hover:bg-surface-alt hover:text-fg'}`}
                  >
                    {label}
                  </Link>
                ))}
              </div>
            </section>
          ))}
        </nav>
        <div className="min-w-0">
          {tab === 'themes' && <ThemesSettings prefs={prefs} update={update} />}
          {tab === 'general' && <GeneralSettings prefs={prefs} update={update} />}
          {tab === 'notifications' && <NotificationSettings prefs={prefs} update={update} />}
          {tab === 'calendar' && <CalendarSettings />}
          {tab === 'apps' && <ApiAccessSettings />}
          {tab === 'ai' && <AiSettings />}
          {tab === 'webhooks' && <WebhookSettings />}
          {tab === 'data' && <AccountDataSettings />}
          {tab === 'device' && <DeviceSettings />}
          {tab === 'security' && <AccountSecurityPage embedded />}
          {tab === 'admin-users' && isAdmin && <AdminUsersPage embedded />}
          {tab === 'admin-instance' && isAdmin && <AdminSettingsPage embedded />}
          {tab === 'admin-backups' && isAdmin && <AdminBackupsPage embedded />}
        </div>
      </div>
    </Page>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="mb-6">
      <h2 className="mb-4 font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

/* Labels for each text size come from the catalogue; the keys are the preference values. */
const TEXT_SIZE_LABEL: Record<keyof typeof TEXT_SIZES, string> = {
  small: 'settings.appearance.textSize.small',
  default: 'settings.appearance.textSize.default',
  large: 'settings.appearance.textSize.large',
  larger: 'settings.appearance.textSize.larger',
};

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{label}</legend>
      <div className="inline-flex flex-wrap gap-1 rounded-lg border border-line p-1">
        {options.map(([v, l]) => (
          <button
            key={v}
            type="button"
            aria-pressed={value === v}
            onClick={() => onChange(v)}
            className={`rounded-md px-3 py-1 text-sm ${value === v ? 'bg-accent text-on-accent' : 'hover:bg-surface-alt'}`}
          >
            {l}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function ThemesSettings({
  prefs,
  update,
}: {
  prefs: Preferences;
  update: (p: PreferencesPatch) => void;
}) {
  const { t } = useTranslation();
  useEffect(() => preloadFonts(), []);
  const a = prefs.appearance;
  const set = (patch: Partial<Appearance>) => update({ appearance: patch });
  const activeFamily =
    getTheme(a.darkTheme).family === getTheme(a.lightTheme).family
      ? getTheme(a.lightTheme).family
      : null;
  const variants = (mode: Mode) =>
    THEMES.filter((t) => t.mode === mode).map((t) => ({
      value: t.id,
      label: `${FAMILIES.find((f) => f.id === t.family)?.name} ${t.name}`,
    }));

  return (
    <>
      <Section title={t('settings.appearance.theme')}>
        <div className="space-y-5">
          <Segmented
            label={t('settings.appearance.mode')}
            value={a.mode}
            options={[
              ['system', t('settings.appearance.matchSystem')],
              ['light', t('settings.appearance.light')],
              ['dark', t('settings.appearance.dark')],
            ]}
            onChange={(mode) => set({ mode })}
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            {FAMILIES.map((f) => {
              const light = getTheme(f.defaultLight).tokens;
              const dark = getTheme(f.defaultDark).tokens;
              const selected = activeFamily === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => set({ lightTheme: f.defaultLight, darkTheme: f.defaultDark })}
                  className={`overflow-hidden rounded-xl border text-left text-sm ${selected ? 'border-accent ring-2 ring-accent' : 'border-line hover:border-muted'}`}
                >
                  <div className="flex h-14">
                    {[light, dark].map((t, i) => (
                      <div
                        key={i}
                        className="flex flex-1 items-end gap-1 p-2"
                        style={{ backgroundColor: t.bg }}
                      >
                        <span
                          className="h-6 flex-1 rounded"
                          style={{ backgroundColor: t.surface, border: `1px solid ${t.border}` }}
                        />
                        {[t.accent, t.p1, t.p2, t.p3].map((c, colorIndex) => (
                          <span
                            key={`${colorIndex}-${c}`}
                            className="size-2.5 rounded-full"
                            style={{ backgroundColor: c }}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="px-3 py-2 font-medium">{f.name}</div>
                </button>
              );
            })}
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted">
              {t('settings.appearance.pickVariants')}
            </summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SelectField
                label={t('settings.appearance.lightVariant')}
                value={a.lightTheme}
                onChange={(e) => set({ lightTheme: e.target.value })}
                options={variants('light')}
              />
              <SelectField
                label={t('settings.appearance.darkVariant')}
                value={a.darkTheme}
                onChange={(e) => set({ darkTheme: e.target.value })}
                options={variants('dark')}
              />
            </div>
          </details>
          <p className="text-xs text-muted">{t('settings.appearance.contrastNote')}</p>
        </div>
      </Section>
      <Section title={t('settings.appearance.fonts', { defaultValue: 'Fonts' })}>
        <div className="space-y-5">
          <SelectField
            label={t('settings.appearance.font')}
            value={a.font}
            onChange={(e) => set({ font: e.target.value as Appearance['font'] })}
            options={FONTS.map((f) => ({ value: f.id, label: f.name }))}
            hint={t('settings.appearance.fontHint')}
          />
          <p className="rounded-lg border border-line bg-surface-alt p-4 text-sm">
            {t('settings.appearance.fontPreview', {
              defaultValue:
                'The quick brown fox jumps over the lazy dog. 0123456789 — BokyDo keeps your day moving.',
            })}
          </p>
          <Segmented
            label={t('settings.appearance.textSize.label')}
            value={a.textSize}
            options={(Object.keys(TEXT_SIZES) as Appearance['textSize'][]).map((s) => [
              s,
              t(TEXT_SIZE_LABEL[s]),
            ])}
            onChange={(textSize) => set({ textSize })}
          />
          <Segmented
            label={t('settings.appearance.density')}
            value={a.density}
            options={[
              ['comfortable', t('settings.appearance.comfortable')],
              ['compact', t('settings.appearance.compact')],
            ]}
            onChange={(density) => set({ density })}
          />
        </div>
      </Section>
    </>
  );
}

function GeneralSettings({
  prefs,
  update,
}: {
  prefs: Preferences;
  update: (p: PreferencesPatch) => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      <Section title={t('settings.general.dateAndTime')}>
        <div className="space-y-5">
          <TimeZonePicker value={prefs.timezone} onChange={(timezone) => update({ timezone })} />
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              label={t('settings.general.weekStartsOn')}
              value={prefs.weekStart}
              onChange={(e) => update({ weekStart: e.target.value as Preferences['weekStart'] })}
              options={[
                { value: 'monday', label: t('settings.general.monday') },
                { value: 'sunday', label: t('settings.general.sunday') },
                { value: 'saturday', label: t('settings.general.saturday') },
              ]}
            />
            <SelectField
              label={t('settings.general.timeFormat')}
              value={prefs.timeFormat}
              onChange={(e) => update({ timeFormat: e.target.value as Preferences['timeFormat'] })}
              options={[
                { value: '24h', label: '13:00' },
                { value: '12h', label: '1:00pm' },
              ]}
            />
            <SelectField
              label={t('settings.general.dateFormat')}
              value={prefs.dateFormat}
              onChange={(e) => update({ dateFormat: e.target.value as Preferences['dateFormat'] })}
              options={[
                { value: 'dmy', label: '31 Dec' },
                { value: 'mdy', label: 'Dec 31' },
                { value: 'ymd', label: '2026 Dec 31' },
              ]}
            />
          </div>
        </div>
      </Section>
      <Section title={t('settings.tabs.general')}>
        <div className="space-y-5">
          <SelectField
            label={t('settings.language')}
            value={prefs.language}
            onChange={(e) => {
              rememberLanguage(e.target.value);
              update({ language: e.target.value });
            }}
            options={[
              { value: AUTO_LANGUAGE, label: t('settings.languageAuto') },
              ...LANGUAGES.map((code) => ({ value: code, label: LANGUAGE_NAMES[code] })),
            ]}
            hint={t('settings.languageHint')}
          />
          <SelectField
            label={t('settings.general.homeView')}
            value={prefs.startPage}
            onChange={(e) => update({ startPage: e.target.value as Preferences['startPage'] })}
            options={[
              { value: 'today', label: t('nav.today') },
              { value: 'inbox', label: t('nav.inbox') },
              { value: 'upcoming', label: t('nav.upcoming') },
            ]}
          />
          <Checkbox
            label={t('settings.general.smartDate')}
            hint={t('settings.general.smartDateHint')}
            checked={prefs.smartDateRecognition}
            onChange={(e) => update({ smartDateRecognition: e.target.checked })}
          />
          <Checkbox
            label={t('settings.general.shortcuts')}
            hint={t('settings.general.shortcutsHint')}
            checked={prefs.keyboardShortcuts}
            onChange={(e) => update({ keyboardShortcuts: e.target.checked })}
          />
        </div>
      </Section>
    </>
  );
}
