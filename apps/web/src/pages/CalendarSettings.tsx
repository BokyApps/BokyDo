import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, Card, Checkbox, SelectField } from '../components/ui.js';
import { api } from '../lib/api.js';
import { calendarFeedsQuery, feedHref, type CalendarFeed } from '../lib/calendar-feeds.js';
import { useConfirm } from '../lib/confirm.js';
import { errorMessage } from '../lib/messages.js';
import { useSyncState } from '../lib/sync.js';

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' });

/** A link that exists only on screen: after this it can't be shown again, only replaced. */
interface Revealed {
  feedId: string;
  name: string;
  href: string;
}

export function CalendarSettings() {
  const state = useSyncState();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const feeds = useQuery(calendarFeedsQuery);
  const [revealed, setRevealed] = useState<Revealed | null>(null);
  const [copied, setCopied] = useState(false);
  const [kind, setKind] = useState<'project' | 'filter'>('project');
  const [targetId, setTargetId] = useState('');
  const [showDescriptions, setShowDescriptions] = useState(false);

  const projects = [...state.projects.values()]
    .filter((p) => !p.isArchived)
    .sort((a, b) => Number(b.isInbox) - Number(a.isInbox) || a.name.localeCompare(b.name));
  const savedFilters = [...state.filters.values()].sort((a, b) => a.name.localeCompare(b.name));
  const targets =
    kind === 'project'
      ? projects.map((p) => ({ value: p.id, label: p.isInbox ? 'Inbox' : p.name }))
      : savedFilters.map((f) => ({ value: f.id, label: f.name }));
  const chosen = targets.some((t) => t.value === targetId) ? targetId : (targets[0]?.value ?? '');
  const nameOf = (id: string) => targets.find((t) => t.value === id)?.label ?? 'Calendar';

  const refresh = () => queryClient.invalidateQueries({ queryKey: calendarFeedsQuery.queryKey });
  const reveal = (feedId: string, name: string, url: string) => {
    setCopied(false);
    setRevealed({ feedId, name, href: feedHref(url) });
  };

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string; url: string }>('POST', '/api/v1/calendar-feeds', {
        kind,
        targetId: chosen,
        showDescriptions,
      }),
    onSuccess: (res) => {
      reveal(res.id, nameOf(chosen), res.url);
      void refresh();
    },
  });
  const rotate = useMutation({
    mutationFn: (feed: CalendarFeed) =>
      api<{ id: string; url: string }>('POST', `/api/v1/calendar-feeds/${feed.id}/rotate`, {}),
    onSuccess: (res, feed) => {
      reveal(res.id, feed.targetName ?? 'Calendar', res.url);
      void refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (feed: CalendarFeed) => api('DELETE', `/api/v1/calendar-feeds/${feed.id}`),
    onSuccess: (_res, feed) => {
      setRevealed((r) => (r?.feedId === feed.id ? null : r));
      void refresh();
    },
  });

  const resetLink = async (feed: CalendarFeed) => {
    const ok = await confirm({
      title: 'Reset this link?',
      message:
        'You get a new link and the old one stops working at once, so any calendar subscribed to it must be updated.',
      confirmLabel: 'Reset link',
    });
    if (ok) rotate.mutate(feed);
  };
  const deleteFeed = async (feed: CalendarFeed) => {
    const ok = await confirm({
      title: 'Delete this feed?',
      message: 'The link stops working at once. Calendars subscribed to it will go empty.',
      confirmLabel: 'Delete',
      danger: true,
    });
    if (ok) remove.mutate(feed);
  };

  const error = create.error ?? rotate.error ?? remove.error ?? feeds.error;
  const list = feeds.data ?? [];

  return (
    <>
      <Card className="mb-6">
        <h2 className="mb-2 font-semibold">Calendar feeds</h2>
        <p className="mb-4 text-sm text-muted">
          Subscribe to a project or saved filter from Google Calendar, Apple Calendar, Thunderbird
          or any app that can subscribe to a calendar link. Tasks with a due date appear as events
          and the calendar refreshes by itself.{' '}
          <strong>Anyone with a link can see those tasks' titles and dates</strong> without signing
          in, so treat it like a password. You can reset or delete a link at any time.
        </p>

        {revealed && (
          <div className="mb-4 space-y-2 rounded-lg border border-line bg-surface-alt p-3">
            <p className="text-sm font-medium">Link for “{revealed.name}”</p>
            <input
              readOnly
              aria-label={`Calendar link for ${revealed.name}`}
              value={revealed.href}
              onFocus={(e) => e.currentTarget.select()}
              className="w-full rounded-lg border border-line bg-bg px-3 py-2 font-mono text-xs"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard.writeText(revealed.href).then(() => setCopied(true))
                }
              >
                {copied ? 'Copied' : 'Copy link'}
              </Button>
              <a className="text-sm underline" href={revealed.href.replace(/^https?:/, 'webcal:')}>
                Open in calendar app
              </a>
              <Button variant="ghost" onClick={() => setRevealed(null)}>
                Done
              </Button>
            </div>
            <p className="text-xs text-muted">
              This is the only time the link is shown. If you lose it, reset the link to get a new
              one.
            </p>
          </div>
        )}

        {error && (
          <div className="mb-4">
            <Alert>{errorMessage(error)}</Alert>
          </div>
        )}

        {feeds.isPending ? (
          <p role="status" className="text-sm text-muted">
            Loading…
          </p>
        ) : list.length === 0 ? (
          <p className="mb-2 text-sm text-muted">You have no calendar feeds yet.</p>
        ) : (
          <ul className="mb-2 divide-y divide-line" aria-label="Your calendar feeds">
            {list.map((feed) => (
              <li key={feed.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {feed.targetName ?? 'No longer available'}{' '}
                    <span className="font-normal text-muted">
                      · {feed.kind === 'project' ? 'Project' : 'Saved filter'}
                      {feed.showDescriptions ? ' · with descriptions' : ''}
                    </span>
                  </p>
                  <p className="text-xs text-muted">
                    {feed.targetName === null
                      ? 'The project or filter was deleted or is no longer shared with you, so this link shows nothing. '
                      : ''}
                    Created {when(feed.createdAt)} ·{' '}
                    {feed.lastUsedAt ? `last used ${when(feed.lastUsedAt)}` : 'not used yet'}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    busy={rotate.isPending && rotate.variables?.id === feed.id}
                    onClick={() => void resetLink(feed)}
                    aria-label={`Reset link for ${feed.targetName ?? 'this feed'}`}
                  >
                    Reset link
                  </Button>
                  <Button
                    variant="danger"
                    busy={remove.isPending && remove.variables?.id === feed.id}
                    onClick={() => void deleteFeed(feed)}
                    aria-label={`Delete feed for ${feed.targetName ?? 'this feed'}`}
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mb-6">
        <h2 className="mb-4 font-semibold">New calendar feed</h2>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (chosen) create.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label="Show"
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as 'project' | 'filter');
                setTargetId('');
              }}
              options={[
                { value: 'project', label: 'A project' },
                { value: 'filter', label: 'A saved filter' },
              ]}
            />
            <SelectField
              label={kind === 'project' ? 'Project' : 'Saved filter'}
              value={chosen}
              onChange={(e) => setTargetId(e.target.value)}
              options={targets.length ? targets : [{ value: '', label: 'None yet' }]}
              disabled={targets.length === 0}
              hint={
                kind === 'filter' && targets.length === 0
                  ? 'Create a saved filter first (Filters & Labels).'
                  : undefined
              }
            />
          </div>
          <Checkbox
            label="Include task descriptions"
            hint="Off by default: descriptions are shared with the calendar app and its servers."
            checked={showDescriptions}
            onChange={(e) => setShowDescriptions(e.target.checked)}
          />
          <Button type="submit" busy={create.isPending} disabled={!chosen}>
            Create link
          </Button>
        </form>
      </Card>
    </>
  );
}
