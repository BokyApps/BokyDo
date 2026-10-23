import {
  API_SCOPE_KEYS,
  API_SCOPES,
  type ApiScope,
  type AuthorizedApp,
  type PersonalAccessToken,
} from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api.js';
import { useConfirm } from '../lib/confirm.js';
import { errorMessage } from '../lib/messages.js';
import { useSensitive } from '../lib/reauth.js';
import { useSyncState } from '../lib/sync.js';
import { flattenTree, projectTree } from '../lib/views.js';
import { Alert, Button, Card, Checkbox, SecretList, SelectField, TextField } from './ui.js';

const day = (iso: string | null, never: string) =>
  iso ? new Date(iso).toLocaleDateString() : never;

/** Settings → Apps & tokens: connected apps (OAuth) and personal access tokens. */
export function ApiAccessSettings() {
  return (
    <div className="space-y-6">
      <ConnectedApps />
      <PersonalTokens />
    </div>
  );
}

function ConnectedApps() {
  const { t } = useTranslation();
  const never = t('settings.apps.never');
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const apps = useQuery({
    queryKey: ['account-apps'],
    queryFn: () => api<{ apps: AuthorizedApp[] }>('GET', '/api/v1/account/apps'),
  });
  const revoke = useMutation({
    mutationFn: (clientId: string) => api('DELETE', `/api/v1/account/apps/${clientId}`),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['account-apps'] }),
  });
  const list = apps.data?.apps ?? [];
  return (
    <Card>
      <h2 className="mb-1 font-semibold">{t('settings.apps.title')}</h2>
      <p className="mb-4 text-sm text-muted">{t('settings.apps.description')}</p>
      {list.length === 0 && <p className="text-sm text-muted">{t('settings.apps.noApps')}</p>}
      <ul className="divide-y divide-line">
        {list.map((a) => (
          <li key={a.clientId} className="flex flex-wrap items-start justify-between gap-2 py-3">
            <div className="min-w-0">
              <p className="font-medium break-words">{a.name}</p>
              <p className="text-xs text-muted">
                {t('settings.apps.appMeta', {
                  hosts: a.redirectHosts.join(', '),
                  since: day(a.firstAuthorizedAt, never),
                  last: day(a.lastUsedAt, never),
                })}
              </p>
              <p className="text-xs text-muted">{a.scopes.join(', ')}</p>
            </div>
            <Button
              variant="secondary"
              busy={revoke.isPending && revoke.variables === a.clientId}
              onClick={() =>
                void confirm({
                  title: t('settings.apps.removeTitle'),
                  message: t('settings.apps.removeMessage', { name: a.name }),
                  confirmLabel: t('settings.apps.remove'),
                  danger: true,
                }).then((ok) => ok && revoke.mutate(a.clientId))
              }
            >
              {t('settings.apps.remove')}
            </Button>
          </li>
        ))}
      </ul>
      {revoke.isError && <Alert tone="error">{errorMessage(revoke.error)}</Alert>}
    </Card>
  );
}

function PersonalTokens() {
  const { t } = useTranslation();
  const never = t('settings.tokens.never');
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const sensitive = useSensitive();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<Set<ApiScope>>(new Set(['tasks:read']));
  const [expires, setExpires] = useState('90');
  // null = every project; otherwise the projects the token is limited to.
  const [limitTo, setLimitTo] = useState<Set<string> | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const state = useSyncState();
  const inbox = state.user ? state.projects.get(state.user.inboxProjectId) : undefined;
  const projects = [
    ...(inbox ? [{ project: inbox, depth: 0 }] : []),
    ...flattenTree(projectTree(state)),
  ];
  const projectName = (id: string) => state.projects.get(id)?.name ?? t('settings.tokens.deletedProject');
  // Full access is the whole account (settings, labels, notifications): it can't be limited.
  const limitable = !scopes.has('sync');
  const limited = limitable ? limitTo : null;
  const tokens = useQuery({
    queryKey: ['account-tokens'],
    queryFn: () => api<{ tokens: PersonalAccessToken[] }>('GET', '/api/v1/account/tokens'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['account-tokens'] });
  const create = useMutation({
    mutationFn: () =>
      sensitive(() =>
        api<{ token: string }>('POST', '/api/v1/account/tokens', {
          name,
          scopes: [...scopes],
          expiresInDays: expires === 'never' ? null : Number(expires),
          projectIds: limited ? [...limited] : null,
        }),
      ),
    onSuccess: async ({ token }) => {
      setCreated(token);
      setName('');
      setLimitTo(null);
      await refresh();
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/v1/account/tokens/${id}`),
    onSuccess: refresh,
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setCreated(null);
    create.mutate();
  };
  const toggle = (s: ApiScope) =>
    setScopes((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  const toggleProject = (id: string) =>
    setLimitTo((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <Card>
      <h2 className="mb-1 font-semibold">{t('settings.tokens.title')}</h2>
      <p className="mb-4 text-sm text-muted">{t('settings.tokens.description')}</p>
      {created && (
        <div className="mb-4 space-y-2">
          <Alert tone="success">{t('settings.tokens.copyNow')}</Alert>
          <SecretList items={[created]} filename="bokydo-token.txt" />
        </div>
      )}
      <ul className="mb-4 divide-y divide-line">
        {(tokens.data?.tokens ?? []).map((token) => (
          <li key={token.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
            <div className="min-w-0">
              <p className="font-medium break-words">{token.name}</p>
              <p className="text-xs text-muted">
                {t('settings.tokens.tokenMeta', {
                  scopes: token.scopes.join(', '),
                  expires: token.expiresAt ? day(token.expiresAt, never) : never,
                  last: day(token.lastUsedAt, never),
                })}
              </p>
              {token.projectIds && (
                <p className="text-xs break-words text-muted">
                  {t('settings.tokens.limitedTo', {
                    names: token.projectIds.map(projectName).join(', '),
                  })}
                </p>
              )}
            </div>
            <Button
              variant="secondary"
              busy={revoke.isPending && revoke.variables === token.id}
              onClick={() =>
                void confirm({
                  title: t('settings.tokens.revokeTitle'),
                  message: t('settings.tokens.revokeMessage', { name: token.name }),
                  confirmLabel: t('settings.tokens.revoke'),
                  danger: true,
                }).then((ok) => ok && revoke.mutate(token.id))
              }
            >
              {t('settings.tokens.revoke')}
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={submit} className="space-y-3 border-t border-line pt-4">
        <TextField
          label={t('settings.tokens.newName')}
          value={name}
          maxLength={80}
          required
          onChange={(e) => setName(e.target.value)}
        />
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">{t('settings.tokens.whatItMayDo')}</legend>
          {API_SCOPE_KEYS.map((s) => (
            <Checkbox
              key={s}
              label={API_SCOPES[s]}
              hint={s}
              checked={scopes.has(s)}
              onChange={() => toggle(s)}
            />
          ))}
        </fieldset>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">{t('settings.tokens.whichProjects')}</legend>
          {limitable ? (
            <>
              <SelectField
                label={t('settings.tokens.projectsLink')}
                hideLabel
                value={limitTo ? 'some' : 'all'}
                onChange={(e) => setLimitTo(e.target.value === 'some' ? new Set() : null)}
                options={[
                  { value: 'all', label: t('settings.tokens.allProjects') },
                  { value: 'some', label: t('settings.tokens.someProjects') },
                ]}
              />
              {limitTo && (
                <div className="max-h-60 space-y-2 overflow-y-auto rounded border border-line p-2">
                  {projects.map(({ project, depth }) => (
                    <div key={project.id} style={{ paddingLeft: `${depth * 1.25}rem` }}>
                      <Checkbox
                        label={project.name}
                        checked={limitTo.has(project.id)}
                        onChange={() => toggleProject(project.id)}
                      />
                    </div>
                  ))}
                  <p className="text-xs text-muted">{t('settings.tokens.limitNote')}</p>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">{t('settings.tokens.fullAccessNote')}</p>
          )}
        </fieldset>
        <SelectField
          label={t('settings.tokens.expires')}
          value={expires}
          onChange={(e) => setExpires(e.target.value)}
          options={[
            { value: '7', label: t('settings.tokens.in7d') },
            { value: '30', label: t('settings.tokens.in30d') },
            { value: '90', label: t('settings.tokens.in90d') },
            { value: '366', label: t('settings.tokens.inAYear') },
            { value: 'never', label: never },
          ]}
        />
        {create.isError && <Alert tone="error">{errorMessage(create.error)}</Alert>}
        <Button
          type="submit"
          busy={create.isPending}
          disabled={!name.trim() || scopes.size === 0 || limited?.size === 0}
        >
          {t('settings.tokens.createToken')}
        </Button>
      </form>
    </Card>
  );
}
