import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
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
      ? projects.map((p) => ({ value: p.id, label: p.isInbox ? t('nav.inbox') : p.name }))
      : savedFilters.map((f) => ({ value: f.id, label: f.name }));
  const chosen = targets.some((t) => t.value === targetId) ? targetId : (targets[0]?.value ?? '');
  const nameOf = (id: string) =>
    targets.find((t) => t.value === id)?.label ?? t('settings.calendar.defaultName');

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
      reveal(res.id, feed.targetName ?? t('settings.calendar.defaultName'), res.url);
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
      title: t('settings.calendar.resetTitle'),
      message: t('settings.calendar.resetMessage'),
      confirmLabel: t('settings.calendar.resetLink'),
    });
    if (ok) rotate.mutate(feed);
  };
  const deleteFeed = async (feed: CalendarFeed) => {
    const ok = await confirm({
      title: t('settings.calendar.deleteTitle'),
      message: t('settings.calendar.deleteMessage'),
      confirmLabel: t('common.delete'),
      danger: true,
    });
    if (ok) remove.mutate(feed);
  };

  const error = create.error ?? rotate.error ?? remove.error ?? feeds.error;
  const list = feeds.data ?? [];

  return (
    <>
      <Card className="mb-6">
        <h2 className="mb-2 font-semibold">{t('settings.calendar.feedsTitle')}</h2>
        <p className="mb-4 text-sm text-muted">{t('settings.calendar.feedsDescription')}</p>

        {revealed && (
          <div className="mb-4 space-y-2 rounded-lg border border-line bg-surface-alt p-3">
            <p className="text-sm font-medium">
              {t('settings.calendar.linkFor', { name: revealed.name })}
            </p>
            <input
              readOnly
              aria-label={t('settings.calendar.linkForAria', { name: revealed.name })}
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
                {copied ? t('settings.calendar.copied') : t('settings.calendar.copyLink')}
              </Button>
              <a className="text-sm underline" href={revealed.href.replace(/^https?:/, 'webcal:')}>
                {t('settings.calendar.openInApp')}
              </a>
              <Button variant="ghost" onClick={() => setRevealed(null)}>
                {t('settings.calendar.done')}
              </Button>
            </div>
            <p className="text-xs text-muted">{t('settings.calendar.onlyShownOnce')}</p>
          </div>
        )}

        {error && (
          <div className="mb-4">
            <Alert>{errorMessage(error)}</Alert>
          </div>
        )}

        {feeds.isPending ? (
          <p role="status" className="text-sm text-muted">
            {t('common.loading')}
          </p>
        ) : list.length === 0 ? (
          <p className="mb-2 text-sm text-muted">{t('settings.calendar.none')}</p>
        ) : (
          <ul className="mb-2 divide-y divide-line" aria-label={t('settings.calendar.yourFeeds')}>
            {list.map((feed) => (
              <li key={feed.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">
                    {feed.targetName ?? t('settings.calendar.targetGone')}{' '}
                    <span className="font-normal text-muted">
                      ·{' '}
                      {feed.kind === 'project'
                        ? t('settings.calendar.project')
                        : t('settings.calendar.filter')}
                      {feed.showDescriptions ? ` · ${t('settings.calendar.withDescriptions')}` : ''}
                    </span>
                  </p>
                  <p className="text-xs text-muted">
                    {feed.targetName === null ? `${t('settings.calendar.targetGoneNote')} ` : ''}
                    {t('settings.calendar.created', {
                      date: when(feed.createdAt),
                      last: feed.lastUsedAt
                        ? t('settings.calendar.lastUsed', { date: when(feed.lastUsedAt) })
                        : t('settings.calendar.notUsedYet'),
                    })}
                  </p>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="secondary"
                    busy={rotate.isPending && rotate.variables?.id === feed.id}
                    onClick={() => void resetLink(feed)}
                    aria-label={t('settings.calendar.resetFor', {
                      name: feed.targetName ?? t('settings.calendar.thisFeed'),
                    })}
                  >
                    {t('settings.calendar.resetLink')}
                  </Button>
                  <Button
                    variant="danger"
                    busy={remove.isPending && remove.variables?.id === feed.id}
                    onClick={() => void deleteFeed(feed)}
                    aria-label={t('settings.calendar.deleteFor', {
                      name: feed.targetName ?? t('settings.calendar.thisFeed'),
                    })}
                  >
                    {t('common.delete')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="mb-6">
        <h2 className="mb-4 font-semibold">{t('settings.calendar.newFeedTitle')}</h2>
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (chosen) create.mutate();
          }}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              label={t('settings.calendar.show')}
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as 'project' | 'filter');
                setTargetId('');
              }}
              options={[
                { value: 'project', label: t('settings.calendar.showProject') },
                { value: 'filter', label: t('settings.calendar.showFilter') },
              ]}
            />
            <SelectField
              label={
                kind === 'project' ? t('settings.calendar.project') : t('settings.calendar.filter')
              }
              value={chosen}
              onChange={(e) => setTargetId(e.target.value)}
              options={
                targets.length ? targets : [{ value: '', label: t('settings.calendar.noneYet') }]
              }
              disabled={targets.length === 0}
              hint={
                kind === 'filter' && targets.length === 0
                  ? t('settings.calendar.noneYetHint')
                  : undefined
              }
            />
          </div>
          <Checkbox
            label={t('settings.calendar.includeDescriptions')}
            hint={t('settings.calendar.includeHint')}
            checked={showDescriptions}
            onChange={(e) => setShowDescriptions(e.target.checked)}
          />
          <Button type="submit" busy={create.isPending} disabled={!chosen}>
            {t('settings.calendar.createLink')}
          </Button>
        </form>
      </Card>
    </>
  );
}
