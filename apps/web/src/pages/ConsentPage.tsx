import { API_SCOPES, type ApiScope, type OAuthRequestInfo } from '@bokydo/shared';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, AuthLayout, Button, Checkbox } from '../components/ui.js';
import { api } from '../lib/api.js';
import { errorMessage } from '../lib/messages.js';
import { clearOAuthRequest, pendingOAuthRequest } from '../lib/oauth.js';
import { sessionQuery } from '../lib/queries.js';

/**
 * "Allow <app> to access your account?" Everything shown about the app except where it sends
 * you afterwards was typed in by the app itself, so the page says so. Framing is blocked by
 * the CSP (frame-ancestors 'none') and X-Frame-Options, so the buttons can't be clickjacked.
 */
export function ConsentPage() {
  const [request] = useState(pendingOAuthRequest);
  const { data: session } = useQuery(sessionQuery);
  const info = useQuery({
    queryKey: ['oauth-request', request],
    enabled: !!request,
    retry: false,
    queryFn: () => api<OAuthRequestInfo>('POST', '/api/v1/oauth/request', { request }),
  });
  const [unchecked, setUnchecked] = useState<Set<ApiScope>>(new Set());
  const decide = useMutation({
    mutationFn: (approve: boolean) =>
      api<{ redirect: string }>('POST', '/api/v1/oauth/request/decision', {
        request,
        approve,
        ...(approve && info.data
          ? { scopes: info.data.scopes.filter((s) => !unchecked.has(s)) }
          : {}),
      }),
    onSuccess: ({ redirect }) => {
      clearOAuthRequest();
      location.assign(redirect);
    },
  });

  if (!request || info.isError)
    return (
      <AuthLayout>
        <div className="space-y-4">
          <h1 className="text-lg font-semibold">Connect an app</h1>
          <Alert tone="error">
            This sign-in request has expired or was already used. Start again from the app.
          </Alert>
        </div>
      </AuthLayout>
    );
  if (!info.data) return <AuthLayout>Loading…</AuthLayout>;
  const app = info.data;
  const granted = app.scopes.filter((s) => !unchecked.has(s));
  const toggle = (s: ApiScope) =>
    setUnchecked((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  return (
    <AuthLayout>
      <div className="space-y-4">
        <h1 className="text-lg font-semibold break-words">
          Allow “{app.clientName}” to access your account?
        </h1>
        <p className="text-sm text-muted">
          Signed in as <strong className="text-fg">{session?.user.username}</strong>.{' '}
          {app.audience === 'mcp' && 'It will use BokyDo as an AI assistant connector (MCP). '}
          {app.verified
            ? 'This is an official app registered by this server.'
            : "The app named itself; BokyDo can't verify the name."}
        </p>
        <Alert tone="info">
          {app.redirectKind === 'web' ? (
            <>
              After you decide, you'll be sent to <strong>{app.redirectHost}</strong>. Only continue
              if that's the service you're connecting.
            </>
          ) : app.redirectKind === 'loopback' ? (
            <>It's a program running on this computer ({app.redirectHost}).</>
          ) : (
            <>It's an app on this device ({app.redirectHost}).</>
          )}
        </Alert>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">It will be able to:</legend>
          {app.scopes.map((s) => (
            <Checkbox
              key={s}
              label={API_SCOPES[s]}
              checked={!unchecked.has(s)}
              onChange={() => toggle(s)}
            />
          ))}
        </fieldset>
        {granted.includes('sync') && (
          <Alert tone="warning">
            This is full access, as if the app were you. Only allow apps you trust.
          </Alert>
        )}
        {decide.isError && <Alert tone="error">{errorMessage(decide.error)}</Alert>}
        <div className="flex flex-wrap gap-2">
          <Button
            busy={decide.isPending && decide.variables}
            disabled={granted.length === 0 || decide.isPending}
            onClick={() => decide.mutate(true)}
          >
            Allow
          </Button>
          <Button
            variant="secondary"
            busy={decide.isPending && !decide.variables}
            disabled={decide.isPending}
            onClick={() => decide.mutate(false)}
          >
            Deny
          </Button>
        </div>
        <p className="text-xs text-muted">
          You can remove its access at any time in Settings → Apps &amp; tokens.
        </p>
      </div>
    </AuthLayout>
  );
}
