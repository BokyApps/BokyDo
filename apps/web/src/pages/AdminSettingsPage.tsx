import {
  normalizePublicUrl,
  parsePushHost,
  type PublicSettings,
  type SettingsPatch,
} from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AiAdminSettings } from '../components/AiSettings.js';
import { EmailSettingsForm } from '../components/EmailSettingsForm.js';
import { TimeZonePicker } from '../components/TimeZonePicker.js';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  SelectField,
  TextArea,
  TextField,
} from '../components/ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { adminSettingsQuery } from '../lib/queries.js';

export function AdminSettingsPage() {
  const { t } = useTranslation();
  const { data: settings } = useQuery(adminSettingsQuery);
  if (!settings) return null;
  return (
    <div className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">{t('admin.title')}</h1>
      <Section title={t('admin.instance.title')}>
        <InstanceForm settings={settings} />
      </Section>
      <Section title={t('admin.security.title')}>
        <SecurityForm settings={settings} />
      </Section>
      <Section title={t('admin.email.title')}>
        <EmailSettingsForm settings={settings} />
      </Section>
      <Section title={t('admin.push.title')}>
        <PushHostsForm settings={settings} />
      </Section>
      <Section title={t('settings.tabs.ai')}>
        <AiAdminSettings />
      </Section>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card>
      <h2 className="mb-4 text-base font-semibold">{title}</h2>
      {children}
    </Card>
  );
}

function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api('PATCH', '/api/v1/admin/settings', patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }),
  });
}

function SaveRow({ save }: { save: ReturnType<typeof useSaveSettings> }) {
  const { t } = useTranslation();
  return (
    <>
      {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">{t('admin.saved')}</Alert>}
      <Button type="submit" busy={save.isPending}>
        {t('common.save')}
      </Button>
    </>
  );
}

function InstanceForm({ settings }: { settings: PublicSettings }) {
  const { t } = useTranslation();
  const save = useSaveSettings();
  const [name, setName] = useState(settings['instance.name']);
  const [publicUrl, setPublicUrl] = useState(settings['instance.publicUrl'] ?? '');
  const [hops, setHops] = useState(String(settings['instance.trustedProxyHops']));
  const [timezone, setTimezone] = useState(settings['instance.defaultTimezone']);
  const [weekStart, setWeekStart] = useState<string>(settings['instance.weekStart']);
  const [maxMb, setMaxMb] = useState(String(settings['attachments.maxSizeMb']));
  const normalized = normalizePublicUrl(publicUrl);
  const movesAway = normalized !== null && normalized !== window.location.origin;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      'instance.name': name,
      'instance.publicUrl': publicUrl.trim() || null,
      'instance.trustedProxyHops': Number(hops),
      'instance.defaultTimezone': timezone,
      'instance.weekStart': weekStart as 'monday' | 'sunday' | 'saturday',
      'attachments.maxSizeMb': Number(maxMb),
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <TextField
        label={t('admin.instance.name')}
        required
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField
        label={t('admin.instance.publicUrl')}
        type="url"
        value={publicUrl}
        onChange={(e) => setPublicUrl(e.target.value)}
        hint={t('admin.instance.publicUrlHint')}
      />
      {movesAway && (
        <Alert tone="warning">
          {t('admin.instance.publicUrlWarning', {
            current: window.location.origin,
            next: normalized,
          })}
        </Alert>
      )}
      <SelectField
        label={t('admin.instance.proxies')}
        value={hops}
        onChange={(e) => setHops(e.target.value)}
        hint={t('admin.instance.proxiesHint')}
        options={['0', '1', '2', '3', '4', '5'].map((v) => ({
          value: v,
          label:
            v === '0'
              ? t('admin.instance.noProxies')
              : t('admin.instance.proxyCount', { count: Number(v) }),
        }))}
      />
      <TimeZonePicker
        label={t('admin.instance.defaultTimezone')}
        value={timezone}
        onChange={setTimezone}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label={t('settings.general.weekStartsOn')}
          value={weekStart}
          onChange={(e) => setWeekStart(e.target.value)}
          options={[
            { value: 'monday', label: t('settings.general.monday') },
            { value: 'sunday', label: t('settings.general.sunday') },
            { value: 'saturday', label: t('settings.general.saturday') },
          ]}
        />
      </div>
      <TextField
        label={t('admin.instance.maxAttachment')}
        type="number"
        min={0}
        max={100}
        value={maxMb}
        onChange={(e) => setMaxMb(e.target.value)}
        hint={t('admin.instance.maxAttachmentHint')}
      />
      <SaveRow save={save} />
    </form>
  );
}

function SecurityForm({ settings }: { settings: PublicSettings }) {
  const { t } = useTranslation();
  const save = useSaveSettings();
  const [registration, setRegistration] = useState<string>(settings['access.registrationMode']);
  const [minLength, setMinLength] = useState(String(settings['security.passwordMinLength']));
  const [mfa, setMfa] = useState<string>(settings['security.mfaEnforcement']);
  const [idleDays, setIdleDays] = useState(String(settings['security.sessionIdleDays']));
  const [maxDays, setMaxDays] = useState(String(settings['security.sessionMaxDays']));
  const [breachCheck, setBreachCheck] = useState(settings['security.breachedPasswordCheck']);
  const [loginAlerts, setLoginAlerts] = useState(settings['security.newLoginAlerts']);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      'access.registrationMode': registration as 'closed' | 'invite' | 'open',
      'security.passwordMinLength': Number(minLength),
      'security.mfaEnforcement': mfa as 'off' | 'admins' | 'everyone',
      'security.sessionIdleDays': Number(idleDays),
      'security.sessionMaxDays': Number(maxDays),
      'security.breachedPasswordCheck': breachCheck,
      'security.newLoginAlerts': loginAlerts,
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <SelectField
        label={t('admin.security.registration')}
        value={registration}
        onChange={(e) => setRegistration(e.target.value)}
        options={[
          { value: 'invite', label: t('admin.security.regInvite') },
          { value: 'closed', label: t('admin.security.regClosed') },
          { value: 'open', label: t('admin.security.regOpen') },
        ]}
      />
      {registration === 'open' && (
        <Alert tone="warning">{t('admin.security.regOpenWarning')}</Alert>
      )}
      <TextField
        label={t('admin.security.passwordMinLength')}
        type="number"
        min={10}
        max={128}
        value={minLength}
        onChange={(e) => setMinLength(e.target.value)}
      />
      <SelectField
        label={t('admin.security.mfa')}
        value={mfa}
        onChange={(e) => setMfa(e.target.value)}
        hint={t('admin.security.mfaHint')}
        options={[
          { value: 'off', label: t('admin.security.mfaOff') },
          { value: 'admins', label: t('admin.security.mfaAdmins') },
          { value: 'everyone', label: t('admin.security.mfaEveryone') },
        ]}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label={t('admin.security.sessionIdle')}
          type="number"
          min={1}
          max={365}
          value={idleDays}
          onChange={(e) => setIdleDays(e.target.value)}
        />
        <TextField
          label={t('admin.security.sessionMax')}
          type="number"
          min={1}
          max={365}
          value={maxDays}
          onChange={(e) => setMaxDays(e.target.value)}
        />
      </div>
      <Checkbox
        label={t('admin.security.loginAlerts')}
        checked={loginAlerts}
        onChange={(e) => setLoginAlerts(e.target.checked)}
      />
      <Checkbox
        label={t('admin.security.breachCheck')}
        hint={t('admin.security.breachCheckHint')}
        checked={breachCheck}
        onChange={(e) => setBreachCheck(e.target.checked)}
      />
      <SaveRow save={save} />
    </form>
  );
}

/** Extra push services (UnifiedPush distributors, self-hosted) devices may register with. */
function PushHostsForm({ settings }: { settings: PublicSettings }) {
  const { t } = useTranslation();
  const save = useSaveSettings();
  const [text, setText] = useState(settings['push.allowedHosts'].join('\n'));
  const hosts = text
    .split(/[\s,]+/)
    .map((h) => h.trim())
    .filter(Boolean);
  const invalid = hosts.filter((h) => !parsePushHost(h));
  const hasNtfy = hosts.some((h) => h.toLowerCase() === 'ntfy.sh');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({ 'push.allowedHosts': hosts });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <p className="text-sm text-muted">{t('admin.push.description')}</p>
      <TextArea
        label={t('admin.push.allowedHosts')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        placeholder="ntfy.sh"
        hint={t('admin.push.allowedHostsHint')}
      />
      {invalid.length > 0 && (
        <Alert tone="warning">{t('admin.push.invalidHosts', { hosts: invalid.join(', ') })}</Alert>
      )}
      {!hasNtfy && (
        <Button
          variant="ghost"
          onClick={() => setText((t) => (t.trim() ? `${t.trim()}\nntfy.sh` : 'ntfy.sh'))}
        >
          {t('admin.push.addNtfy')}
        </Button>
      )}
      <SaveRow save={save} />
    </form>
  );
}
