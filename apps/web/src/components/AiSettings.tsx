import {
  AI_FEATURES,
  AI_FEATURE_KEYS,
  AI_PROVIDERS,
  AI_PROVIDER_KEYS,
  providerSupports,
  type AiCredential,
  type AiFeature,
  type AiProvider,
  type AiRouting,
} from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';
import { useConfirm } from '../lib/confirm.js';
import { parseHeaderLines } from '../lib/ai-headers.js';
import { errorMessage } from '../lib/messages.js';
import { adminSettingsQuery } from '../lib/queries.js';
import { Alert, Button, Card, Checkbox, SelectField, TextField } from './ui.js';

/** The same panels serve your own keys and the instance's; only the endpoints differ. */
type Scope = 'user' | 'instance';

const ENDPOINTS = {
  user: {
    credentials: '/api/v1/ai/credentials',
    routing: '/api/v1/ai/routing',
    usage: '/api/v1/ai/usage',
  },
  instance: {
    credentials: '/api/v1/admin/ai/credentials',
    routing: '/api/v1/admin/ai/routing',
    usage: '/api/v1/admin/ai/usage',
  },
} as const;

interface Catalog {
  policy: { userKeys: boolean; instance: boolean };
  available: AiFeature[];
}

interface UserUsage {
  month: string;
  instance: {
    tokens: number;
    audioSeconds: number;
    tokenBudget: number | null;
    audioSecondsBudget: number | null;
  };
  byFeature: {
    feature: AiFeature;
    billing: 'own' | 'instance';
    calls: number;
    tokens: number;
    audioSeconds: number;
  }[];
}

interface InstanceUsage {
  budget: { tokens: number | null; audioSeconds: number | null };
  users: {
    userId: string;
    username: string;
    calls: number;
    tokens: number;
    audioSeconds: number;
  }[];
}

const n = (value: number) => value.toLocaleString();
const minutes = (seconds: number) => `${Math.round((seconds / 60) * 10) / 10} min`;
const budget = (used: number, limit: number | null, fmt: (v: number) => string) =>
  limit === null ? `${fmt(used)} (no limit)` : `${fmt(used)} of ${fmt(limit)}`;

/** Settings → AI: your own provider keys, which model serves which feature, and what you've used. */
export function AiSettings() {
  const catalog = useQuery({
    queryKey: ['ai-catalog'],
    queryFn: () => api<Catalog>('GET', '/api/v1/ai/catalog'),
  });
  const userKeys = catalog.data?.policy.userKeys ?? true;
  return (
    <div className="space-y-6">
      {!userKeys && (
        <Alert tone="info">
          This instance does not accept your own provider keys. Ask an administrator to configure
          the instance's AI settings.
        </Alert>
      )}
      <CredentialsPanel scope="user" canWrite={userKeys} />
      <RoutingPanel scope="user" canWrite={userKeys} />
      <UsagePanel />
    </div>
  );
}

/** Admin settings → AI: the policy, the instance's own keys, its routing, and everyone's usage. */
export function AiAdminSettings() {
  return (
    <div className="space-y-8">
      <AiPolicyForm />
      <CredentialsPanel scope="instance" canWrite />
      <RoutingPanel scope="instance" canWrite />
      <InstanceUsagePanel />
    </div>
  );
}

function AiPolicyForm() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(adminSettingsQuery);
  const [userKeys, setUserKeys] = useState<boolean | null>(null);
  const [access, setAccess] = useState<string | null>(null);
  const [tokens, setTokens] = useState<string | null>(null);
  const [unlimitedTokens, setUnlimitedTokens] = useState<boolean | null>(null);
  const [audio, setAudio] = useState<string | null>(null);
  const [unlimitedAudio, setUnlimitedAudio] = useState<boolean | null>(null);

  const save = useMutation({
    mutationFn: (patch: Record<string, unknown>) => api('PATCH', '/api/v1/admin/settings', patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['admin', 'settings'] }),
  });

  if (!settings) return null;
  const tokenValue = tokens ?? String(settings['ai.monthlyTokenBudget'] ?? '');
  const audioValue = audio ?? String(settings['ai.monthlyAudioMinutes'] ?? '');
  const tokensUnlimited = unlimitedTokens ?? settings['ai.monthlyTokenBudget'] === null;
  const audioUnlimited = unlimitedAudio ?? settings['ai.monthlyAudioMinutes'] === null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      'ai.userKeys': userKeys ?? settings['ai.userKeys'],
      'ai.instanceAccess': (access ?? settings['ai.instanceAccess']) as
        'off' | 'admins' | 'everyone',
      'ai.monthlyTokenBudget': tokensUnlimited ? null : Number(tokenValue),
      'ai.monthlyAudioMinutes': audioUnlimited ? null : Number(audioValue),
    });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <h3 className="text-sm font-semibold text-muted">Keys and budget</h3>
      <SelectField
        label="Who may use the instance's AI keys"
        value={access ?? settings['ai.instanceAccess']}
        onChange={(e) => setAccess(e.target.value)}
        hint="This is what lets someone use AI without bringing their own key."
        options={[
          { value: 'off', label: 'Nobody' },
          { value: 'admins', label: 'Admins only' },
          { value: 'everyone', label: 'Everyone' },
        ]}
      />
      {(access ?? settings['ai.instanceAccess']) !== 'off' && (
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <TextField
              label="Monthly tokens per user"
              type="number"
              min={0}
              disabled={tokensUnlimited}
              value={tokensUnlimited ? '' : tokenValue}
              onChange={(e) => setTokens(e.target.value)}
              hint="Counts against the instance's keys only. Resets on the 1st (UTC)."
            />
            <Checkbox
              label="Unlimited tokens"
              checked={tokensUnlimited}
              onChange={(e) => setUnlimitedTokens(e.target.checked)}
            />
          </div>
          <div className="space-y-2">
            <TextField
              label="Monthly speech-to-text minutes per user"
              type="number"
              min={0}
              disabled={audioUnlimited}
              value={audioUnlimited ? '' : audioValue}
              onChange={(e) => setAudio(e.target.value)}
              hint="Used by Ramble transcription."
            />
            <Checkbox
              label="Unlimited minutes"
              checked={audioUnlimited}
              onChange={(e) => setUnlimitedAudio(e.target.checked)}
            />
          </div>
        </div>
      )}
      <Checkbox
        label="Let people add their own provider keys"
        hint="Their usage is metered but never counts against the budgets above."
        checked={userKeys ?? settings['ai.userKeys']}
        onChange={(e) => setUserKeys(e.target.checked)}
      />
      {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Saved.</Alert>}
      <Button type="submit" busy={save.isPending}>
        Save
      </Button>
    </form>
  );
}

function CredentialsPanel({ scope, canWrite }: { scope: Scope; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const [form, setForm] = useState<{ open: boolean; credential: AiCredential | null }>({
    open: false,
    credential: null,
  });
  const list = useQuery({
    queryKey: ['ai-credentials', scope],
    queryFn: () => api<{ credentials: AiCredential[] }>('GET', ENDPOINTS[scope].credentials),
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['ai-credentials', scope] });
    void queryClient.invalidateQueries({ queryKey: ['ai-routing', scope] });
  };
  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `${ENDPOINTS[scope].credentials}/${id}`),
    onSuccess: invalidate,
  });
  const test = useMutation({
    mutationFn: (id: string) =>
      api<{ ok: boolean; models?: string[] }>('POST', `${ENDPOINTS[scope].credentials}/${id}/test`),
  });
  const credentials = list.data?.credentials ?? [];
  const own = scope === 'user';

  return (
    <Card>
      <h2 className={own ? 'mb-1 font-semibold' : 'mb-4 text-base font-semibold'}>
        {own ? 'Your AI keys' : 'Instance AI keys'}
      </h2>
      {own && (
        <p className="mb-4 text-sm text-muted">
          Keys are stored encrypted and are never sent back to this page — only a note that one
          exists.
        </p>
      )}
      {list.isLoading && <p className="text-sm text-muted">Loading…</p>}
      {list.isError && <Alert>{errorMessage(list.error)}</Alert>}
      {!list.isLoading && credentials.length === 0 && (
        <p className="text-sm text-muted">
          {own ? 'No keys yet.' : 'The instance has no keys yet.'}
        </p>
      )}
      <ul className="divide-y divide-line">
        {credentials.map((c) => (
          <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
            <div className="min-w-0">
              <p className="font-medium break-words">
                {c.label}{' '}
                <span className="text-xs font-normal text-muted">
                  {AI_PROVIDERS[c.provider].name}
                </span>
              </p>
              <p className="text-xs text-muted">
                {c.baseUrl ?? AI_PROVIDERS[c.provider].defaultBaseUrl ?? 'no address'} ·{' '}
                {c.hasKey ? 'key set' : 'no key'}
                {c.headerNames.length > 0 && ` · headers: ${c.headerNames.join(', ')}`}
                {c.lastUsedAt && ` · last used ${new Date(c.lastUsedAt).toLocaleDateString()}`}
              </p>
              {test.isSuccess && test.variables === c.id && (
                <p className="text-xs text-success">
                  Reachable
                  {test.data?.models?.length ? ` · ${test.data.models.length} models` : ''}.
                </p>
              )}
              {test.isError && test.variables === c.id && (
                <p className="text-xs text-danger">{errorMessage(test.error)}</p>
              )}
            </div>
            <div className="flex shrink-0 gap-1">
              <Button
                variant="ghost"
                busy={test.isPending && test.variables === c.id}
                disabled={!canWrite}
                onClick={() => test.mutate(c.id)}
              >
                Test
              </Button>
              <Button
                variant="ghost"
                disabled={!canWrite}
                onClick={() => setForm({ open: true, credential: c })}
              >
                Edit
              </Button>
              <Button
                variant="ghost"
                busy={remove.isPending && remove.variables === c.id}
                onClick={() =>
                  void confirm({
                    title: 'Remove this key?',
                    message: `“${c.label}” will be deleted, and any feature using it is switched off.`,
                    confirmLabel: 'Remove',
                    danger: true,
                  }).then((ok) => ok && remove.mutate(c.id))
                }
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {remove.isError && <Alert>{errorMessage(remove.error)}</Alert>}

      {canWrite && !form.open && (
        <div className="mt-4">
          <Button variant="secondary" onClick={() => setForm({ open: true, credential: null })}>
            Add a key
          </Button>
        </div>
      )}
      {form.open && (
        <CredentialForm
          scope={scope}
          credential={form.credential}
          onClose={() => setForm({ open: false, credential: null })}
          onSaved={() => {
            invalidate();
            setForm({ open: false, credential: null });
          }}
        />
      )}
    </Card>
  );
}

function CredentialForm({
  scope,
  credential,
  onClose,
  onSaved,
}: {
  scope: Scope;
  credential: AiCredential | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = credential !== null;
  const [provider, setProvider] = useState<AiProvider>(credential?.provider ?? 'openai');
  const [label, setLabel] = useState(credential?.label ?? '');
  const [baseUrl, setBaseUrl] = useState(credential?.baseUrl ?? '');
  const [apiKey, setApiKey] = useState('');
  const [headers, setHeaders] = useState('');
  const info = AI_PROVIDERS[provider];
  const needsBaseUrl = info.baseUrl === 'required';

  const save = useMutation({
    mutationFn: () => {
      const parsedHeaders = parseHeaderLines(headers);
      if (editing) {
        // Only send what changed; a blank key or header box keeps what is stored.
        return api('PATCH', `${ENDPOINTS[scope].credentials}/${credential.id}`, {
          label,
          ...(needsBaseUrl ? { baseUrl } : {}),
          ...(apiKey ? { apiKey } : {}),
          ...(parsedHeaders ? { headers: parsedHeaders } : {}),
        });
      }
      return api('POST', ENDPOINTS[scope].credentials, {
        provider,
        label,
        ...(needsBaseUrl ? { baseUrl } : {}),
        ...(apiKey ? { apiKey } : {}),
        ...(parsedHeaders ? { headers: parsedHeaders } : {}),
      });
    },
    onSuccess: onSaved,
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate();
  };

  return (
    <form onSubmit={submit} className="mt-4 space-y-4 rounded-lg border border-line p-4">
      <h3 className="font-medium">{editing ? `Edit “${credential.label}”` : 'Add a key'}</h3>
      {editing ? (
        <p className="text-sm text-muted">
          {AI_PROVIDERS[credential.provider].name}. The provider cannot be changed; add a new key
          instead. Leave a field blank to keep what is stored.
        </p>
      ) : (
        <SelectField
          label="Provider"
          value={provider}
          onChange={(e) => setProvider(e.target.value as AiProvider)}
          options={AI_PROVIDER_KEYS.map((key) => ({ value: key, label: AI_PROVIDERS[key].name }))}
          hint={info.capabilities.join(', ')}
        />
      )}
      <TextField
        label="Label"
        required
        maxLength={80}
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        hint="How this key appears in the list and in each feature's settings."
      />
      {needsBaseUrl ? (
        <TextField
          label="Base URL"
          type="url"
          required
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          hint="For example http://ollama:11434/v1. A private address only works if an administrator allow-lists it."
        />
      ) : (
        info.defaultBaseUrl && (
          <p className="text-sm text-muted">
            Uses {info.defaultBaseUrl}
            {info.dialect !== 'openai' && ` · ${info.dialect} dialect`}
          </p>
        )
      )}
      <TextField
        label="API key"
        type="password"
        autoComplete="off"
        required={!editing && info.apiKey === 'required'}
        value={apiKey}
        onChange={(e) => setApiKey(e.target.value)}
        hint={info.apiKey === 'optional' ? 'Optional for this provider.' : undefined}
      />
      {info.customHeaders && (
        <label className="block space-y-1">
          <span className="text-sm font-medium">
            Custom headers <span className="font-normal text-muted">(optional)</span>
          </span>
          <textarea
            className="min-h-20 w-full rounded-md border border-line bg-bg px-2 py-1 font-mono text-xs"
            placeholder={'X-Organisation: team-name'}
            value={headers}
            onChange={(e) => setHeaders(e.target.value)}
          />
          <span className="block text-xs text-muted">
            One <code>Name: value</code> per line.{' '}
            {editing && credential.headerNames.length > 0
              ? `Stored: ${credential.headerNames.join(', ')} — typing here replaces all of them.`
              : 'Only custom endpoints accept these.'}
          </span>
        </label>
      )}
      {save.isError && <Alert>{errorMessage(save.error)}</Alert>}
      <div className="flex gap-2">
        <Button type="submit" busy={save.isPending}>
          {editing ? 'Save' : 'Add'}
        </Button>
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function RoutingPanel({ scope, canWrite }: { scope: Scope; canWrite: boolean }) {
  const queryClient = useQueryClient();
  const credentials = useQuery({
    queryKey: ['ai-credentials', scope],
    queryFn: () => api<{ credentials: AiCredential[] }>('GET', ENDPOINTS[scope].credentials),
  });
  const routing = useQuery({
    queryKey: ['ai-routing', scope],
    queryFn: () => api<{ routing: AiRouting }>('GET', ENDPOINTS[scope].routing),
  });
  const [draft, setDraft] = useState<AiRouting | null>(null);
  const [issues, setIssues] = useState<{ path: string; message: string }[] | null>(null);
  const current = draft ?? routing.data?.routing ?? {};
  const list = credentials.data?.credentials ?? [];
  const own = scope === 'user';

  const save = useMutation({
    mutationFn: (next: AiRouting) => api('PUT', ENDPOINTS[scope].routing, next),
    onSuccess: () => {
      setIssues(null);
      queryClient.invalidateQueries({ queryKey: ['ai-routing', scope] });
    },
    onError: (err) => {
      const body = (err as { body?: { issues?: { path: string; message: string }[] } }).body;
      setIssues(body?.issues ?? null);
    },
  });

  const set = (feature: AiFeature, value: { credentialId: string; model: string } | null) => {
    const entries = Object.entries(current).filter(([key]) => key !== feature);
    if (value) entries.push([feature, value]);
    setDraft(Object.fromEntries(entries) as AiRouting);
  };

  return (
    <Card>
      <h2 className={own ? 'mb-1 font-semibold' : 'mb-4 text-base font-semibold'}>
        {own ? 'Which model does what' : 'Instance feature routing'}
      </h2>
      {own && (
        <p className="mb-4 text-sm text-muted">
          Features left unset are simply switched off for you. Instance keys are used only when an
          administrator shares them.
        </p>
      )}
      {list.length === 0 ? (
        <p className="text-sm text-muted">Add a key first.</p>
      ) : (
        <div className="space-y-3">
          {AI_FEATURE_KEYS.map((feature) => {
            const capability = AI_FEATURES[feature];
            const usable = list.filter((c) => providerSupports(c.provider, capability));
            const route = current[feature];
            return (
              <div key={feature} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr] sm:items-end">
                <div>
                  <p className="text-sm font-medium">{feature}</p>
                  <p className="text-xs text-muted">needs {capability}</p>
                </div>
                <SelectField
                  label="Key"
                  hideLabel
                  disabled={!canWrite}
                  value={route?.credentialId ?? ''}
                  onChange={(e) =>
                    set(
                      feature,
                      e.target.value
                        ? { credentialId: e.target.value, model: route?.model ?? '' }
                        : null,
                    )
                  }
                  options={[
                    { value: '', label: 'Off' },
                    ...usable.map((c) => ({ value: c.id, label: `${c.label} (${c.provider})` })),
                  ]}
                />
                <TextField
                  label="Model"
                  hideLabel
                  disabled={!canWrite || !route}
                  placeholder="gpt-4o-mini"
                  value={route?.model ?? ''}
                  onChange={(e) =>
                    route &&
                    set(feature, { credentialId: route.credentialId, model: e.target.value })
                  }
                />
              </div>
            );
          })}
          {list.length > 0 &&
            list.every((c) =>
              AI_FEATURE_KEYS.every((f) => !providerSupports(c.provider, AI_FEATURES[f])),
            ) && <Alert tone="info">None of these keys can serve any feature yet.</Alert>}
        </div>
      )}
      {issues && (
        <Alert>
          <ul className="list-inside list-disc">
            {issues.map((i) => (
              <li key={i.path}>
                <strong>{i.path}</strong>: {i.message}
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {save.isError && !issues && <Alert>{errorMessage(save.error)}</Alert>}
      {save.isSuccess && <Alert tone="success">Saved.</Alert>}
      {canWrite && list.length > 0 && (
        <div className="mt-4">
          <Button
            busy={save.isPending}
            disabled={Object.values(current).some((r) => !r.model.trim())}
            onClick={() => save.mutate(current)}
          >
            Save routing
          </Button>
        </div>
      )}
    </Card>
  );
}

function UsagePanel() {
  const usage = useQuery({
    queryKey: ['ai-usage'],
    queryFn: () => api<UserUsage>('GET', ENDPOINTS.user.usage),
  });
  if (usage.isError) return <Alert>{errorMessage(usage.error)}</Alert>;
  if (!usage.data) return null;
  const { month, instance, byFeature } = usage.data;
  return (
    <Card>
      <h2 className="mb-1 font-semibold">This month ({month})</h2>
      <p className="mb-4 text-sm text-muted">
        Speech-to-text is billed by the minute by most providers, so it is counted separately.
      </p>
      <p className="text-sm">
        Instance keys: {budget(instance.tokens, instance.tokenBudget, n)} tokens ·{' '}
        {budget(instance.audioSeconds, instance.audioSecondsBudget, minutes)}
      </p>
      {byFeature.length > 0 && (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1">Feature</th>
              <th className="py-1">Key</th>
              <th className="py-1">Calls</th>
              <th className="py-1">Tokens</th>
              <th className="py-1">Audio</th>
            </tr>
          </thead>
          <tbody>
            {byFeature.map((row) => (
              <tr key={`${row.feature}-${row.billing}`} className="border-t border-line">
                <td className="py-1">{row.feature}</td>
                <td className="py-1 text-muted">{row.billing === 'own' ? 'yours' : 'instance'}</td>
                <td className="py-1">{n(row.calls)}</td>
                <td className="py-1">{n(row.tokens)}</td>
                <td className="py-1">{row.audioSeconds ? minutes(row.audioSeconds) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function InstanceUsagePanel() {
  const usage = useQuery({
    queryKey: ['ai-usage', 'instance'],
    queryFn: () => api<InstanceUsage>('GET', ENDPOINTS.instance.usage),
  });
  if (usage.isError) return <Alert>{errorMessage(usage.error)}</Alert>;
  if (!usage.data) return null;
  const { budget: limits, users } = usage.data;
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold text-muted">Usage this month</h3>
      <p className="text-sm text-muted">
        Budget per user:{' '}
        {limits.tokens === null ? 'unlimited tokens' : `${n(limits.tokens)} tokens`} ·{' '}
        {limits.audioSeconds === null ? 'unlimited audio' : minutes(limits.audioSeconds)}
      </p>
      {users.length === 0 ? (
        <p className="text-sm text-muted">Nobody has used the instance's keys yet.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted">
              <th className="py-1">User</th>
              <th className="py-1">Calls</th>
              <th className="py-1">Tokens</th>
              <th className="py-1">Audio</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.userId} className="border-t border-line">
                <td className="py-1">{u.username}</td>
                <td className="py-1">{n(u.calls)}</td>
                <td className="py-1">{n(u.tokens)}</td>
                <td className="py-1">{u.audioSeconds ? minutes(u.audioSeconds) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
