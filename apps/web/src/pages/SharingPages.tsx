import { useMutation, useQuery } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { ROLE_LABEL } from '../components/Sharing.js';
import { Alert, Button, Card, Spinner } from '../components/ui.js';
import { EmptyState, Page, ViewHeader } from '../components/ViewHeader.js';
import { api } from '../lib/api.js';
import { useStore, useSyncState } from '../lib/sync.js';
import type { GrantableRole } from '@bokydo/shared';

const JOIN_KEY = 'bokydo.join';

/** The invite token travels in the URL fragment; keep it across the sign-in redirect. */
export function stashJoinToken(): void {
  if (location.pathname !== '/join' || location.hash.length < 2) return;
  try {
    sessionStorage.setItem(JOIN_KEY, location.hash.slice(1));
  } catch {
    // storage unavailable: the user can open the link again after signing in
  }
}

export function pendingJoinToken(): string | null {
  try {
    return sessionStorage.getItem(JOIN_KEY);
  } catch {
    return null;
  }
}

function clearJoinToken() {
  try {
    sessionStorage.removeItem(JOIN_KEY);
  } catch {
    // nothing to clear
  }
}

/** Direct invitations waiting for the current user. */
export function InvitationsPage() {
  const state = useSyncState();
  const store = useStore();
  const navigate = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const respond = async (id: string, action: 'accept' | 'decline', projectId: string) => {
    setBusy(id);
    try {
      await api('POST', `/api/v1/invites/${id}/${action}`);
      await store.pull();
      if (action === 'accept') void navigate({ to: '/project/$projectId', params: { projectId } });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Page>
      <ViewHeader title="Invitations" />
      {state.invitations.length === 0 && <EmptyState title="No invitations right now" />}
      <ul className="space-y-2">
        {state.invitations.map((i) => (
          <li key={i.id}>
            <Card className="flex flex-wrap items-center gap-3 !p-4">
              <div className="min-w-0 flex-1">
                <p className="font-medium">{i.projectName}</p>
                <p className="text-sm text-muted">
                  {i.invitedBy ?? 'Someone'} invited you as {ROLE_LABEL[i.role].toLowerCase()} ·
                  expires {new Date(i.expiresAt).toLocaleDateString()}
                </p>
              </div>
              <Button
                variant="secondary"
                busy={busy === i.id}
                onClick={() => void respond(i.id, 'decline', i.projectId)}
              >
                Decline
              </Button>
              <Button
                busy={busy === i.id}
                onClick={() => void respond(i.id, 'accept', i.projectId)}
              >
                Join project
              </Button>
            </Card>
          </li>
        ))}
      </ul>
    </Page>
  );
}

/** /join#<token>: preview a one-time invite link, then join. */
export function JoinPage() {
  const navigate = useNavigate();
  const store = useStore();
  const [token] = useState(() =>
    location.hash.length > 1 ? location.hash.slice(1) : pendingJoinToken(),
  );
  const preview = useQuery({
    queryKey: ['join-preview', token],
    enabled: Boolean(token),
    retry: false,
    queryFn: () =>
      api<{
        projectName: string;
        role: GrantableRole;
        invitedBy: string | null;
        alreadyMember: boolean;
      }>('POST', '/api/v1/invites/link/preview', { token }),
  });
  const join = useMutation({
    mutationFn: () => api<{ projectId: string }>('POST', '/api/v1/invites/link/accept', { token }),
    onSuccess: async ({ projectId }) => {
      clearJoinToken();
      await store.pull();
      void navigate({ to: '/project/$projectId', params: { projectId }, replace: true });
    },
  });
  // Keep the token out of history and screenshots once it's read.
  useEffect(() => {
    if (location.hash) history.replaceState(null, '', '/join');
  }, []);

  return (
    <Page>
      <ViewHeader title="Join a project" />
      {!token && <Alert tone="error">This invite link is incomplete. Ask for a new one.</Alert>}
      {preview.isLoading && <Spinner />}
      {(preview.isError || join.isError) && (
        <Alert tone="error">
          This invite link has expired, was already used, or was revoked. Ask for a new one.
        </Alert>
      )}
      {preview.data && !join.isError && (
        <Card className="space-y-3">
          <p>
            <strong>{preview.data.invitedBy ?? 'Someone'}</strong> invited you to{' '}
            <strong>{preview.data.projectName}</strong> as{' '}
            {ROLE_LABEL[preview.data.role].toLowerCase()}.
          </p>
          {preview.data.alreadyMember && (
            <p className="text-sm text-muted">
              You're already a member. Joining keeps your current role if it's higher.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => {
                clearJoinToken();
                void navigate({ to: '/' });
              }}
            >
              Not now
            </Button>
            <Button busy={join.isPending} onClick={() => join.mutate()}>
              Join project
            </Button>
          </div>
        </Card>
      )}
    </Page>
  );
}
