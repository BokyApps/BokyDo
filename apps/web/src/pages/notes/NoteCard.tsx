import type { NoteSummary } from '@bokydo/shared';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StarIcon } from '../../components/icons.js';
import { localeTag } from '../../lib/locale.js';
import { readCardSize, saveCardSize } from '../../lib/note-layout.js';
import { NoteCardEditor } from './NoteDetail.js';
import { NotePreview } from './NotePreview.js';

/**
 * A note on the board, edited in place. The card is resizable from its bottom-right corner and
 * remembers its size on this device. Its editor is only created once the card is near the screen,
 * so a long list does not load every note at once; until then it shows the list's preview.
 */
export function NoteCard({ note, autoFocus = false }: { note: NoteSummary; autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [size] = useState(() => readCardSize(note.id));
  const [live, setLive] = useState(() => autoFocus || typeof IntersectionObserver === 'undefined');

  useEffect(() => {
    const element = ref.current;
    if (!element || live) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        setLive(true);
      },
      { rootMargin: '300px' },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [live]);

  // A drag on the resize corner writes the new size into the card's inline style; layout changes
  // (a narrower window) do not, so only a deliberate resize is remembered.
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    let last = `${element.style.width} ${element.style.height}`;
    const observer = new ResizeObserver(() => {
      const current = `${element.style.width} ${element.style.height}`;
      if (current === last) return;
      last = current;
      const width = parseFloat(element.style.width);
      const height = parseFloat(element.style.height);
      if (Number.isFinite(width) && Number.isFinite(height)) {
        saveCardSize(note.id, { width, height });
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [note.id]);

  return (
    <div
      ref={ref}
      role="article"
      aria-label={note.title || undefined}
      data-note-id={note.id}
      className="bk-note-card"
      style={size ? { width: size.width, height: size.height } : undefined}
    >
      {live ? (
        <NoteCardEditor
          noteId={note.id}
          autoFocus={autoFocus}
          fallback={<NoteCardPlaceholder note={note} />}
        />
      ) : (
        <NoteCardPlaceholder note={note} />
      )}
    </div>
  );
}

/** The card before its editor has loaded: title, formatted preview, tags and date. */
function NoteCardPlaceholder({ note }: { note: NoteSummary }) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-0 flex-1 flex-col px-3 pb-2 pt-2">
      <div className="flex items-start justify-between gap-2">
        <h3 className="min-w-0 break-words py-1 font-semibold">
          {note.title || t('notes.untitled', { defaultValue: 'Untitled' })}
        </h3>
        {note.pinned && (
          <span className="shrink-0 pt-1 text-accent">
            <StarIcon filled />
          </span>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {note.preview?.length ? (
          <NotePreview blocks={note.preview} />
        ) : (
          note.snippet && <p className="whitespace-pre-line text-sm text-muted">{note.snippet}</p>
        )}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-2 pt-1">
        <div className="flex flex-wrap gap-1">
          {note.tags.map((tag) => (
            <span key={tag} className="rounded-full bg-surface-alt px-2 py-0.5 text-xs text-muted">
              #{tag}
            </span>
          ))}
        </div>
        <time className="ml-auto text-xs text-muted" dateTime={note.updatedAt}>
          {new Date(note.updatedAt).toLocaleString(localeTag())}
        </time>
      </div>
    </div>
  );
}

/**
 * The board keeps cards where they are while you work: the server lists notes newest first, so
 * without this a card would jump to the top on every autosave. Notes already on the board keep
 * their place; a new one goes where the server put it relative to them (a fresh note at the top,
 * a loaded page at the end). Exported for tests.
 */
export function stableOrder(previous: string[], server: string[]): string[] {
  const present = new Set(server);
  const kept = previous.filter((id) => present.has(id));
  const keptSet = new Set(kept);
  const after = new Map<string | null, string[]>();
  let anchor: string | null = null;
  for (const id of server) {
    if (keptSet.has(id)) {
      anchor = id;
      continue;
    }
    const group = after.get(anchor) ?? [];
    group.push(id);
    after.set(anchor, group);
  }
  const order = [...(after.get(null) ?? [])];
  for (const id of kept) order.push(id, ...(after.get(id) ?? []));
  return order;
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/** `stableOrder` across renders; `resetKey` (tab, search, tag) starts a fresh order. */
export function useStableOrder(notes: NoteSummary[], resetKey: string): NoteSummary[] {
  const server = notes.map((note) => note.id);
  const [memo, setMemo] = useState({ key: resetKey, ids: server });
  const ids = stableOrder(memo.key === resetKey ? memo.ids : [], server);
  if (memo.key !== resetKey || !sameIds(ids, memo.ids)) setMemo({ key: resetKey, ids });
  const byId = new Map(notes.map((note) => [note.id, note]));
  return ids.flatMap((id) => {
    const note = byId.get(id);
    return note ? [note] : [];
  });
}
