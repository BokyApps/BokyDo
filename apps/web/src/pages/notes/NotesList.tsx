import type { NoteState, NoteSummary } from '@bokydo/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Page, ViewHeader } from '../../components/ViewHeader.js';
import { Alert, Button, Card, inputClass } from '../../components/ui.js';
import { StarIcon } from '../../components/icons.js';
import { ApiError } from '../../lib/api.js';
import { localeTag } from '../../lib/locale.js';
import {
  createNote,
  fetchNotePage,
  noteErrorMessage,
  noteTagsQuery,
  notesKeys,
  type NoteListParams,
} from '../../lib/notes.js';
import { useToast } from '../../lib/toasts.js';

const TABS: NoteState[] = ['active', 'archived', 'trashed'];

export function NotesList() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();

  const [tab, setTab] = useState<NoteState>('active');
  const [tag, setTag] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');

  // Debounced -> q, so typing does not fire a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQ(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const params = useMemo<NoteListParams>(() => ({ q, tag, state: tab }), [q, tag, tab]);

  const list = useInfiniteQuery({
    queryKey: notesKeys.list(params),
    queryFn: ({ pageParam }) => fetchNotePage(params, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
  const tags = useQuery(noteTagsQuery);

  const create = useMutation({
    mutationFn: (id: string) => createNote({ id, title: '', body: '', tags: [], pinned: false }),
    onSuccess: async (_res, id) => {
      await client.invalidateQueries({ queryKey: notesKeys.lists() });
      await navigate({ to: '/notes/$noteId', params: { noteId: id } });
    },
    onError: (err, id) => {
      // A retried create with the same id is idempotent: the note already exists, so just open it.
      if (err instanceof ApiError && err.code === 'id_conflict') {
        void navigate({ to: '/notes/$noteId', params: { noteId: id } });
      } else {
        toast({ tone: 'error', message: noteErrorMessage(err) });
      }
    },
  });

  const newNote = () => create.mutate(crypto.randomUUID());

  const notes = list.data?.pages.flatMap((page) => page.notes) ?? [];
  const pinned = notes.filter((n) => n.pinned);
  const others = notes.filter((n) => !n.pinned);

  return (
    <Page wide>
      <ViewHeader
        title={t('notes.title', { defaultValue: 'Notes' })}
        subtitle={t('notes.subtitle', {
          defaultValue: 'Keep thoughts, links and files next to your tasks.',
        })}
        actions={
          <Button onClick={newNote} busy={create.isPending}>
            {t('notes.new', { defaultValue: 'New note' })}
          </Button>
        }
      />

      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div
          className="flex flex-wrap gap-1"
          role="group"
          aria-label={t('notes.tabs.label', { defaultValue: 'Note state' })}
        >
          {TABS.map((value) => {
            const label =
              value === 'active'
                ? t('notes.tabs.active', { defaultValue: 'Active' })
                : value === 'archived'
                  ? t('notes.tabs.archived', { defaultValue: 'Archived' })
                  : t('notes.tabs.trash', { defaultValue: 'Trash' });
            return (
              <button
                key={value}
                type="button"
                aria-pressed={tab === value}
                onClick={() => {
                  setTab(value);
                  setTag(null);
                }}
                className={`rounded-lg px-3 py-1.5 text-sm ${
                  tab === value
                    ? 'bg-accent text-on-accent'
                    : 'text-muted hover:bg-surface-alt hover:text-fg'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <div className="relative sm:w-64">
          <input
            type="search"
            className={`${inputClass} py-1.5`}
            aria-label={t('notes.search', { defaultValue: 'Search notes' })}
            placeholder={t('notes.search', { defaultValue: 'Search notes' })}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
      </div>

      {tags.data && tags.data.tags.length > 0 && (
        <div
          className="mb-4 flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label={t('notes.tags.filter', { defaultValue: 'Filter by tag' })}
        >
          <button
            type="button"
            aria-pressed={tag === null}
            onClick={() => setTag(null)}
            className={`rounded-full border px-2.5 py-0.5 text-xs ${
              tag === null
                ? 'border-accent bg-accent/10 text-fg'
                : 'border-line text-muted hover:bg-surface-alt'
            }`}
          >
            {t('notes.tags.all', { defaultValue: 'All tags' })}
          </button>
          {tags.data.tags.map(({ tag: name, count }) => (
            <button
              key={name}
              type="button"
              aria-pressed={tag === name}
              onClick={() => setTag(tag === name ? null : name)}
              className={`rounded-full border px-2.5 py-0.5 text-xs ${
                tag === name
                  ? 'border-accent bg-accent/10 text-fg'
                  : 'border-line text-muted hover:bg-surface-alt'
              }`}
            >
              #{name} <span className="opacity-60">{count}</span>
            </button>
          ))}
        </div>
      )}

      {list.isError && (
        <Alert>
          {noteErrorMessage(list.error)}{' '}
          <Button variant="secondary" onClick={() => void list.refetch()}>
            {t('common.retry', { defaultValue: 'Try again' })}
          </Button>
        </Alert>
      )}
      {list.isPending && (
        <p className="text-sm text-muted" role="status">
          {t('common.loading', { defaultValue: 'Loading…' })}
        </p>
      )}
      {!list.isPending && notes.length === 0 && (
        <Card className="text-center">
          <p className="font-medium">
            {q || tag
              ? t('notes.empty.filtered', { defaultValue: 'No notes match this search.' })
              : tab === 'trashed'
                ? t('notes.empty.trash', { defaultValue: 'Trash is empty.' })
                : t('notes.empty.title', { defaultValue: 'No notes yet' })}
          </p>
          {!q && !tag && tab === 'active' && (
            <p className="mt-1 text-sm text-muted">
              {t('notes.empty.body', {
                defaultValue: 'Capture an idea, a link, or something to remember.',
              })}
            </p>
          )}
          {!q && !tag && tab === 'active' && (
            <Button className="mt-4" onClick={newNote} busy={create.isPending}>
              {t('notes.newFirst', { defaultValue: 'Create your first note' })}
            </Button>
          )}
        </Card>
      )}

      {pinned.length > 0 && (
        <section aria-label={t('notes.pinned', { defaultValue: 'Pinned' })} className="mb-6">
          <h2 className="mb-2 text-xs font-semibold text-muted">
            {t('notes.pinned', { defaultValue: 'Pinned' })}
          </h2>
          <NoteGrid notes={pinned} />
        </section>
      )}
      {others.length > 0 && (
        <section aria-label={t('notes.other', { defaultValue: 'Notes' })}>
          {pinned.length > 0 && (
            <h2 className="mb-2 text-xs font-semibold text-muted">
              {t('notes.other', { defaultValue: 'Notes' })}
            </h2>
          )}
          <NoteGrid notes={others} />
        </section>
      )}

      {list.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="secondary"
            onClick={() => void list.fetchNextPage()}
            busy={list.isFetchingNextPage}
          >
            {t('notes.loadMore', { defaultValue: 'Load more' })}
          </Button>
        </div>
      )}
    </Page>
  );
}

function NoteGrid({ notes }: { notes: NoteSummary[] }) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {notes.map((note) => (
        <NoteCard key={note.id} note={note} />
      ))}
    </div>
  );
}

function NoteCard({ note }: { note: NoteSummary }) {
  const { t } = useTranslation();
  return (
    <Link
      to="/notes/$noteId"
      params={{ noteId: note.id }}
      className="flex min-h-28 flex-col rounded-xl border border-line bg-surface p-4 shadow-sm transition hover:border-accent hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-words font-semibold">
          {note.title || t('notes.untitled', { defaultValue: 'Untitled' })}
        </h3>
        {note.pinned && (
          <span
            className="shrink-0 text-accent"
            aria-label={t('notes.pinned', { defaultValue: 'Pinned' })}
          >
            <StarIcon filled />
          </span>
        )}
      </div>
      {note.snippet && <p className="mt-1 line-clamp-4 text-sm text-muted">{note.snippet}</p>}
      <div className="mt-auto flex flex-wrap items-end justify-between gap-2 pt-3">
        <div className="flex flex-wrap gap-1">
          {note.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-surface-alt px-2 py-0.5 text-xs text-muted">
              #{tag}
            </span>
          ))}
        </div>
        <time className="text-xs text-muted" dateTime={note.updatedAt}>
          {new Date(note.updatedAt).toLocaleString(localeTag())}
        </time>
      </div>
    </Link>
  );
}
