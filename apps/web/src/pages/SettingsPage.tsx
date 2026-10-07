import type { Appearance, Preferences, PreferencesPatch } from '@bokydo/shared';
import { FAMILIES, FONTS, getTheme, TEXT_SIZES, THEMES, type Mode } from '@bokydo/themes';
import { useState, type ReactNode } from 'react';
import { ApiAccessSettings } from '../components/ApiAccessSettings.js';
import { TimeZonePicker } from '../components/TimeZonePicker.js';
import { Card, Checkbox, SelectField } from '../components/ui.js';
import { Page, ViewHeader } from '../components/ViewHeader.js';
import { usePreferences, useSend } from '../lib/sync.js';
import { CalendarSettings } from './CalendarSettings.js';
import { NotificationSettings } from './NotificationSettings.js';

type Tab = 'appearance' | 'general' | 'notifications' | 'calendar' | 'apps';
const TAB_LABEL: Record<Tab, string> = {
  appearance: 'Appearance',
  general: 'General',
  notifications: 'Notifications',
  calendar: 'Calendar',
  apps: 'Apps & tokens',
};

export function SettingsPage({ initialTab = 'appearance' }: { initialTab?: Tab }) {
  const prefs = usePreferences();
  const send = useSend();
  const [tab, setTab] = useState<Tab>(initialTab);
  const update = (patch: PreferencesPatch) => send('user_update_preferences', patch);
  return (
    <Page>
      <ViewHeader title="Settings" />
      <div role="tablist" className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
        {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
          <button
            key={t}
            role="tab"
            type="button"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={`-mb-px shrink-0 border-b-2 px-3 py-2 text-sm ${tab === t ? 'border-accent font-medium text-fg' : 'border-transparent text-muted hover:text-fg'}`}
          >
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>
      {tab === 'appearance' && <AppearanceSettings prefs={prefs} update={update} />}
      {tab === 'general' && <GeneralSettings prefs={prefs} update={update} />}
      {tab === 'notifications' && <NotificationSettings prefs={prefs} update={update} />}
      {tab === 'calendar' && <CalendarSettings />}
      {tab === 'apps' && <ApiAccessSettings />}
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
      <Section title="Theme">
        <div className="space-y-5">
          <Segmented
            label="Mode"
            value={a.mode}
            options={[
              ['system', 'Match system'],
              ['light', 'Light'],
              ['dark', 'Dark'],
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
            <summary className="cursor-pointer text-muted">Pick variants separately</summary>
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <SelectField
                label="Light variant"
                value={a.lightTheme}
                onChange={(e) => set({ lightTheme: e.target.value })}
                options={variants('light')}
              />
              <SelectField
                label="Dark variant"
                value={a.darkTheme}
                onChange={(e) => set({ darkTheme: e.target.value })}
                options={variants('dark')}
              />
            </div>
          </details>
          <p className="text-xs text-muted">
            Every theme is checked for WCAG AA contrast; a few colours are nudged slightly where the
            original palette falls short.
          </p>
        </div>
      </Section>
      <Section title="Text">
        <div className="space-y-5">
          <SelectField
            label="Font"
            value={a.font}
            onChange={(e) => set({ font: e.target.value as Appearance['font'] })}
            options={FONTS.map((f) => ({ value: f.id, label: f.name }))}
            hint="Fonts are served by your BokyDo server; only the one you pick is downloaded."
          />
          <Segmented
            label="Text size"
            value={a.textSize}
            options={(Object.keys(TEXT_SIZES) as Appearance['textSize'][]).map((s) => [
              s,
              s.charAt(0).toUpperCase() + s.slice(1),
            ])}
            onChange={(textSize) => set({ textSize })}
          />
          <Segmented
            label="Density"
            value={a.density}
            options={[
              ['comfortable', 'Comfortable'],
              ['compact', 'Compact'],
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
  return (
    <>
      <Section title="Date & time">
        <div className="space-y-5">
          <TimeZonePicker value={prefs.timezone} onChange={(timezone) => update({ timezone })} />
          <div className="grid gap-4 sm:grid-cols-3">
            <SelectField
              label="Week starts on"
              value={prefs.weekStart}
              onChange={(e) => update({ weekStart: e.target.value as Preferences['weekStart'] })}
              options={[
                { value: 'monday', label: 'Monday' },
                { value: 'sunday', label: 'Sunday' },
                { value: 'saturday', label: 'Saturday' },
              ]}
            />
            <SelectField
              label="Time format"
              value={prefs.timeFormat}
              onChange={(e) => update({ timeFormat: e.target.value as Preferences['timeFormat'] })}
              options={[
                { value: '24h', label: '13:00' },
                { value: '12h', label: '1:00pm' },
              ]}
            />
            <SelectField
              label="Date format"
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
      <Section title="General">
        <div className="space-y-5">
          <SelectField
            label="Home view"
            value={prefs.startPage}
            onChange={(e) => update({ startPage: e.target.value as Preferences['startPage'] })}
            options={[
              { value: 'today', label: 'Today' },
              { value: 'inbox', label: 'Inbox' },
              { value: 'upcoming', label: 'Upcoming' },
            ]}
          />
          <Checkbox
            label="Smart date recognition"
            hint="Turn phrases like “tomorrow 5pm” or “every mon” in quick add into due dates."
            checked={prefs.smartDateRecognition}
            onChange={(e) => update({ smartDateRecognition: e.target.checked })}
          />
          <Checkbox
            label="Single-key keyboard shortcuts"
            hint="Keys like q, /, g and j/k run commands when you aren't typing. Turn this off if speech input or assistive technology presses them by accident. Ctrl+K for search still works."
            checked={prefs.keyboardShortcuts}
            onChange={(e) => update({ keyboardShortcuts: e.target.checked })}
          />
        </div>
      </Section>
    </>
  );
}
