import type { Appearance, Preferences, PreferencesPatch } from '@bokydo/shared';
import { FAMILIES, FONTS, getTheme, TEXT_SIZES, THEMES, type Mode } from '@bokydo/themes';
import { useState, type ReactNode } from 'react';
import { AccountDataSettings } from '../components/AccountDataSettings.js';
import { AiSettings } from '../components/AiSettings.js';
import { ApiAccessSettings } from '../components/ApiAccessSettings.js';
import { WebhookSettings } from '../components/WebhookSettings.js';
import { TimeZonePicker } from '../components/TimeZonePicker.js';
import { Card, Checkbox, SelectField } from '../components/ui.js';
import { Page, ViewHeader } from '../components/ViewHeader.js';
import { AUTO_LANGUAGE, LANGUAGES, rememberLanguage } from '../i18n.js';
import { usePreferences, useSend } from '../lib/sync.js';
import { useTranslation } from 'react-i18next';
import { CalendarSettings } from './CalendarSettings.js';
import { NotificationSettings } from './NotificationSettings.js';

/** How each catalogue calls itself, in its own language. */
const LANGUAGE_NAMES: Record<(typeof LANGUAGES)[number], string> = { en: 'English' };

type Tab =
  'appearance' | 'general' | 'notifications' | 'calendar' | 'apps' | 'ai' | 'webhooks' | 'data';
const TAB_LABEL: Record<Tab, string> = {
  appearance: 'Appearance',
  general: 'General',
  notifications: 'Notifications',
  calendar: 'Calendar',
  apps: 'Apps & tokens',
  ai: 'AI',
  webhooks: 'Webhooks',
  data: 'Your data',
};

export function SettingsPage({ initialTab = 'appearance' }: { initialTab?: Tab }) {
  const { t } = useTranslation();
  const prefs = usePreferences();
  const send = useSend();
  const [tab, setTab] = useState<Tab>(initialTab);
  const update = (patch: PreferencesPatch) => send('user_update_preferences', patch);
  return (
    <Page>
      <ViewHeader title={t('settings.title')} />
      <div role="tablist" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {(Object.keys(TAB_LABEL) as Tab[]).map((key) => (
          <button
            key={key}
            role="tab"
            type="button"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm ${tab === key ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg'}`}
          >
            {t(`settings.tabs.${key}`)}
          </button>
        ))}
      </div>
      {tab === 'appearance' && <AppearanceSettings prefs={prefs} update={update} />}
      {tab === 'general' && <GeneralSettings prefs={prefs} update={update} />}
      {tab === 'notifications' && <NotificationSettings prefs={prefs} update={update} />}
      {tab === 'calendar' && <CalendarSettings />}
      {tab === 'apps' && <ApiAccessSettings />}
      {tab === 'ai' && <AiSettings />}
      {tab === 'webhooks' && <WebhookSettings />}
      {tab === 'data' && <AccountDataSettings />}
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

function AppearanceSettings({
  prefs,
  update,
}: {
  prefs: Preferences;
  update: (p: PreferencesPatch) => void;
}) {
  const { t } = useTranslation();
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
                        {[t.accent, t.p1, t.p2, t.p3].map((c) => (
                          <span
                            key={c}
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
      <Section title={t('settings.appearance.text')}>
        <div className="space-y-5">
          <SelectField
            label={t('settings.appearance.font')}
            value={a.font}
            onChange={(e) => set({ font: e.target.value as Appearance['font'] })}
            options={FONTS.map((f) => ({ value: f.id, label: f.name }))}
            hint={t('settings.appearance.fontHint')}
          />
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
