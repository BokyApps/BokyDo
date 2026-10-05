import { normalizePublicUrl, type PublicSettings, type SettingsPatch } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent, type ReactNode } from 'react';
import { EmailSettingsForm } from '../components/EmailSettingsForm.js';
import { TimeZonePicker } from '../components/TimeZonePicker.js';
import { Alert, Button, Card, Checkbox, SelectField, TextField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { adminSettingsQuery } from '../lib/queries.js';

export function AdminSettingsPage() {
  const { data: settings } = useQuery(adminSettingsQuery);
  if (!settings) return null;
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <h1 className="text-2xl font-semibold">Admin settings</h1>
      <Section title="Instance">
        <InstanceForm settings={settings} />
      </Section>
      <Section title="Access & security">
        <SecurityForm settings={settings} />
      </Section>
      <Section title="Email">
        <EmailSettingsForm settings={settings} />
      </Section>
    </main>
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
  return (
    <>
      {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Saved.</Alert>}
      <Button type="submit" busy={save.isPending}>
        Save
      </Button>
    </>
  );
}

function InstanceForm({ settings }: { settings: PublicSettings }) {
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
        label="Instance name"
        required
        maxLength={80}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <TextField
        label="Public URL"
        type="url"
        value={publicUrl}
        onChange={(e) => setPublicUrl(e.target.value)}
        hint="Browsers must use exactly this address to make changes."
      />
      {movesAway && (
        <Alert tone="warning">
          This differs from the address you're using now ({window.location.origin}). After saving,
          changes will only be accepted from {normalized}.
        </Alert>
      )}
      <SelectField
        label="Trusted reverse proxies"
        value={hops}
        onChange={(e) => setHops(e.target.value)}
        hint="How many proxies in front of BokyDo add X-Forwarded-For. Set this only if one actually does: trusting a header nobody sets lets clients fake their IP."
        options={['0', '1', '2', '3', '4', '5'].map((v) => ({
          value: v,
          label: v === '0' ? 'None (direct connection)' : `${v} proxy${v === '1' ? '' : 'ies'}`,
        }))}
      />
      <TimeZonePicker label="Default time zone" value={timezone} onChange={setTimezone} />
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="Week starts on"
          value={weekStart}
          onChange={(e) => setWeekStart(e.target.value)}
          options={[
            { value: 'monday', label: 'Monday' },
            { value: 'sunday', label: 'Sunday' },
            { value: 'saturday', label: 'Saturday' },
          ]}
        />
      </div>
      <TextField
        label="Largest attachment (MB)"
        type="number"
        min={0}
        max={100}
        value={maxMb}
        onChange={(e) => setMaxMb(e.target.value)}
        hint="Files are stored on this server's data volume. 0 turns uploads off."
      />
      <SaveRow save={save} />
    </form>
  );
}

function SecurityForm({ settings }: { settings: PublicSettings }) {
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
        label="Registration"
        value={registration}
        onChange={(e) => setRegistration(e.target.value)}
        options={[
          { value: 'invite', label: 'Invite only (recommended)' },
          { value: 'closed', label: 'Closed: admins create accounts' },
          { value: 'open', label: 'Open: anyone can sign up' },
        ]}
      />
      {registration === 'open' && (
        <Alert tone="warning">
          Anyone who can reach this server will be able to create an account.
        </Alert>
      )}
      <TextField
        label="Minimum password length"
        type="number"
        min={10}
        max={128}
        value={minLength}
        onChange={(e) => setMinLength(e.target.value)}
      />
      <SelectField
        label="Require two-factor authentication"
        value={mfa}
        onChange={(e) => setMfa(e.target.value)}
        hint="Users without an authenticator app or passkey are asked to set one up before they can continue."
        options={[
          { value: 'off', label: 'Optional' },
          { value: 'admins', label: 'Required for admins' },
          { value: 'everyone', label: 'Required for everyone' },
        ]}
      />
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          label="Sign out after inactivity (days)"
          type="number"
          min={1}
          max={365}
          value={idleDays}
          onChange={(e) => setIdleDays(e.target.value)}
        />
        <TextField
          label="Maximum session length (days)"
          type="number"
          min={1}
          max={365}
          value={maxDays}
          onChange={(e) => setMaxDays(e.target.value)}
        />
      </div>
      <Checkbox
        label="Email users about sign-ins from new places"
        checked={loginAlerts}
        onChange={(e) => setLoginAlerts(e.target.checked)}
      />
      <Checkbox
        label="Reject passwords found in data breaches"
        hint="Checks Have I Been Pwned. Only the first 5 characters of a hash of the password leave this server."
        checked={breachCheck}
        onChange={(e) => setBreachCheck(e.target.checked)}
      />
      <SaveRow save={save} />
    </form>
  );
}
