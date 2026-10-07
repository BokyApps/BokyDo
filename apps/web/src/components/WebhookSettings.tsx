import { webhookEventNames, type WebhookSubscriptionInfo } from '@bokydo/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { api } from '../lib/api.js';
import { useConfirm } from '../lib/confirm.js';
import { errorMessage } from '../lib/messages.js';
import { useSensitive } from '../lib/reauth.js';
import { Alert, Button, Card, Checkbox, SecretList, TextField } from './ui.js';

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : 'never');

const EVENT_LABELS: Record<(typeof webhookEventNames)[number], string> = {
  task_added: 'Task added',
  task_updated: 'Task updated',
  task_moved: 'Task moved',
  task_completed: 'Task completed',
  task_uncompleted: 'Task uncompleted',
  task_deleted: 'Task deleted',
  comment_added: 'Comment added',
  project_archived: 'Project archived',
  project_unarchived: 'Project unarchived',
};

const STATUS_LABEL: Record<NonNullable<WebhookSubscriptionInfo['lastDeliveryStatus']>, string> = {
  pending: 'waiting to be sent',
  delivered: 'delivered',
  dropped: 'dropped (no access any more)',
  failed: 'failed after retries',
};

/**
 * Settings → Webhooks: per-user endpoints notified about task, project and comment events.
 * Creating and rotating shows the signing secret once, like a personal access token.
 */
export function WebhookSettings() {
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const sensitive = useSensitive();
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<Set<string>>(new Set(['task_added']));
  const [created, setCreated] = useState<string | null>(null);
  const webhooks = useQuery({
    queryKey: ['webhooks'],
    queryFn: () => api<{ webhooks: WebhookSubscriptionInfo[] }>('GET', '/api/v1/webhooks'),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['webhooks'] });
  const create = useMutation({
    mutationFn: () =>
      sensitive(() =>
        api<{ id: string; secret: string }>('POST', '/api/v1/webhooks', {
          url,
          events: [...events],
        }),
      ),
    onSuccess: async ({ secret }) => {
      setCreated(secret);
      setUrl('');
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api('DELETE', `/api/v1/webhooks/${id}`),
    onSuccess: refresh,
  });
  const rotate = useMutation({
    mutationFn: (id: string) =>
      sensitive(() => api<{ id: string; secret: string }>('POST', `/api/v1/webhooks/${id}/rotate`)),
    onSuccess: async ({ secret }) => {
      setCreated(secret);
      await refresh();
    },
  });
  const test = useMutation({
    mutationFn: (id: string) => api<{ id: string }>('POST', `/api/v1/webhooks/${id}/test`),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setCreated(null);
    create.mutate();
  };
  const toggle = (name: string) =>
    setEvents((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  const list = webhooks.data?.webhooks ?? [];

  return (
    <Card>
      <h2 className="mb-1 font-semibold">Webhooks</h2>
      <p className="mb-4 text-sm text-muted">
        BokyDo POSTs a signed JSON payload to your endpoint for each event you choose, in projects
        you can see. Verify the <code>X-BokyDo-Signature</code> header; see the webhook docs on
        your server for examples. Endpoints must be public https addresses.
      </p>
      {created && (
        <div className="mb-4 space-y-2">
          <Alert tone="success">Copy your signing secret now. It won't be shown again.</Alert>
          <SecretList items={[created]} filename="bokydo-webhook-secret.txt" />
        </div>
      )}
      {list.length === 0 && <p className="mb-4 text-sm text-muted">No webhook endpoints yet.</p>}
      <ul className="mb-4 divide-y divide-line">
        {list.map((w) => (
          <li key={w.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
            <div className="min-w-0">
              <p className="font-medium break-words">{w.url}</p>
              <p className="text-xs text-muted">
                {w.events.map((e) => EVENT_LABELS[e]).join(', ')}
              </p>
              <p className="text-xs text-muted">
                since {day(w.createdAt)} · last delivery {day(w.lastDeliveryAt)}{' '}
                {w.lastDeliveryStatus ? `(${STATUS_LABEL[w.lastDeliveryStatus]}` : ''}
                {w.lastDeliveryStatus === 'failed' && w.lastError ? `: ${w.lastError}` : ''}
                {w.lastDeliveryStatus ? ')' : ''}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                variant="secondary"
                busy={test.isPending && test.variables === w.id}
                onClick={() => test.mutate(w.id)}
              >
                Send test
              </Button>
              <Button
                variant="secondary"
                busy={rotate.isPending && rotate.variables === w.id}
                onClick={() =>
                  void confirm({
                    title: 'New signing secret?',
                    message:
                      'The old secret stops working immediately. Your endpoint must be updated with the new one.',
                    confirmLabel: 'Rotate',
                    danger: true,
                  }).then((ok) => ok && rotate.mutate(w.id))
                }
              >
                Rotate secret
              </Button>
              <Button
                variant="secondary"
                busy={remove.isPending && remove.variables === w.id}
                onClick={() =>
                  void confirm({
                    title: 'Remove this webhook?',
                    message: `Events will no longer be sent to ${w.url}.`,
                    confirmLabel: 'Remove',
                    danger: true,
                  }).then((ok) => ok && remove.mutate(w.id))
                }
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {test.isSuccess && test.variables && (
        <p className="mb-3 text-sm text-muted">
          Test delivery queued — it will arrive within seconds.
        </p>
      )}
      <form onSubmit={submit} className="space-y-3 border-t border-line pt-4">
        <TextField
          label="Endpoint URL"
          type="url"
          value={url}
          placeholder="https://hooks.example.com/bokydo"
          maxLength={2048}
          required
          onChange={(e) => setUrl(e.target.value)}
        />
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Which events to send</legend>
          {webhookEventNames.map((name) => (
            <Checkbox
              key={name}
              label={EVENT_LABELS[name]}
              checked={events.has(name)}
              onChange={() => toggle(name)}
            />
          ))}
        </fieldset>
        {create.isError && <Alert tone="error">{errorMessage(create.error)}</Alert>}
        {rotate.isError && <Alert tone="error">{errorMessage(rotate.error)}</Alert>}
        <Button type="submit" busy={create.isPending} disabled={!url.trim() || events.size === 0}>
          Add webhook
        </Button>
      </form>
    </Card>
  );
}
