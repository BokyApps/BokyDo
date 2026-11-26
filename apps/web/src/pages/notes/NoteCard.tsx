import {
  DndContext,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  rectSortingStrategy,
  sortableKeyboardCoordinates,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { NoteSummary } from '@bokydo/shared';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { useTranslation } from 'react-i18next';
import { StarIcon } from '../../components/icons.js';
import { announcementsFor, taskName } from '../../lib/dnd-announcements.js';
import { localeTag } from '../../lib/locale.js';
import {
  readCardSize,
  readNoteOrder,
  saveCardSize,
  saveNoteOrder,
  type CardSize,
} from '../../lib/note-layout.js';
import { CardDragContext, NoteCardTitlebar, type CardDragHandle } from './NoteCardTitlebar.js';
import { NoteCardEditor } from './NoteDetail.js';
import { NotePreview } from './NotePreview.js';

/**
 * A group of cards on the board (pinned, or the rest). Cards are moved by dragging their title
 * bar, or from the keyboard: focus the title bar, Space to pick the card up, arrows, Space to drop.
 * A card stays in its group: dragging does not pin or unpin it.
 */
export function NoteBoard({
  notes,
  focusId,
  onMove,
}: {
  notes: NoteSummary[];
  focusId: string | null;
  onMove: (activeId: string, overId: string) => void;
}) {
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    // A finger holds the title bar a moment before it drags, so a swipe still scrolls the page.
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const { t } = useTranslation();
  const untitled = t('notes.untitled', { defaultValue: 'Untitled' });
  const announcements = announcementsFor((id) => {
    const note = notes.find((n) => n.id === id);
    return note ? taskName(note.title || untitled) : null;
  });
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (over && active.id !== over.id) onMove(String(active.id), String(over.id));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{ announcements }}
    >
      <SortableContext items={notes.map((note) => note.id)} strategy={rectSortingStrategy}>
        <div className="bk-notes-board">
          {notes.map((note) => (
            <NoteCard key={note.id} note={note} autoFocus={note.id === focusId} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}

type Edge = 'n' | 'e' | 's' | 'w' | 'ne' | 'se' | 'sw' | 'nw';
const EDGES: Edge[] = ['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw'];
/** The smallest card: 12rem by 7rem, matching the CSS minimum. */
const MIN_WIDTH = 192;
const MIN_HEIGHT = 112;
const MAX_SIDE = 4000;
const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * A note on the board, edited in place. Drag its title bar to move it; drag any edge or corner to
 * resize it, and the size is remembered on this device. Its editor is only created once the card
 * is near the screen, so a long list does not load every note at once; until then it shows the
 * list's preview.
 */
export function NoteCard({ note, autoFocus = false }: { note: NoteSummary; autoFocus?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<CardSize | null>(() => readCardSize(note.id));
  const [live, setLive] = useState(() => autoFocus || typeof IntersectionObserver === 'undefined');
  const sortable = useSortable({ id: note.id });
  const { setNodeRef, setActivatorNodeRef, attributes, listeners } = sortable;

  const setRefs = useCallback(
    (element: HTMLDivElement | null) => {
      ref.current = element;
      setNodeRef(element);
    },
    [setNodeRef],
  );
  const drag = useMemo<CardDragHandle>(
    () => ({ setRef: setActivatorNodeRef, attributes, listeners }),
    [setActivatorNodeRef, attributes, listeners],
  );

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

  /**
   * Resizing from an edge or corner. The card sits in a flowing board, so it keeps its place and
   * grows or shrinks: pulling the left edge outwards makes it wider just as the right edge does.
   */
  const startResize = (event: ReactPointerEvent<HTMLDivElement>, edge: Edge) => {
    const card = ref.current;
    if (!card || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Without capture the drag still works while the pointer stays on the page.
    }
    const start = card.getBoundingClientRect();
    const maxWidth = Math.min(card.parentElement?.clientWidth || MAX_SIDE, MAX_SIDE);
    const startX = event.clientX;
    const startY = event.clientY;
    const before = { width: card.style.width, height: card.style.height };
    let next: CardSize = { width: start.width, height: start.height };
    let moved = false;

    const onMove = (e: PointerEvent) => {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      let width = start.width;
      let height = start.height;
      if (edge.includes('e')) width += dx;
      if (edge.includes('w')) width -= dx;
      if (edge.includes('s')) height += dy;
      if (edge.includes('n')) height -= dy;
      next = {
        width: Math.round(clamp(width, MIN_WIDTH, Math.max(maxWidth, MIN_WIDTH))),
        height: Math.round(clamp(height, MIN_HEIGHT, MAX_SIDE)),
      };
      moved = true;
      card.style.width = `${next.width}px`;
      card.style.height = `${next.height}px`;
    };
    const stop = (commit: boolean) => {
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onCancel);
      if (commit && moved) {
        setSize(next);
        saveCardSize(note.id, next);
      } else {
        card.style.width = before.width;
        card.style.height = before.height;
      }
    };
    const onUp = () => stop(true);
    const onCancel = () => stop(false);
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onCancel);
  };

  return (
    <div
      ref={setRefs}
      role="article"
      aria-label={note.title || undefined}
      data-note-id={note.id}
      className={`bk-note-card${sortable.isDragging ? ' bk-note-card-dragging' : ''}`}
      style={{
        ...(size ? { width: size.width, height: size.height } : {}),
        transform: CSS.Translate.toString(sortable.transform),
        transition: sortable.transition,
      }}
    >
      <CardDragContext.Provider value={drag}>
        {live ? (
          <NoteCardEditor
            noteId={note.id}
            autoFocus={autoFocus}
            fallback={<NoteCardPlaceholder note={note} />}
          />
        ) : (
          <NoteCardPlaceholder note={note} />
        )}
      </CardDragContext.Provider>
      {EDGES.map((edge) => (
        <div
          key={edge}
          aria-hidden="true"
          data-edge={edge}
          className={`bk-card-edge bk-card-edge-${edge}`}
          onPointerDown={(e) => startResize(e, edge)}
        />
      ))}
    </div>
  );
}

/** The card before its editor has loaded: title, formatted preview, tags and date. */
function NoteCardPlaceholder({ note }: { note: NoteSummary }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <NoteCardTitlebar
        title={note.title}
        actions={
          note.pinned && (
            <span className="shrink-0 px-1 text-accent">
              <StarIcon filled />
            </span>
          )
        }
      />
      <div className="min-h-0 flex-1 overflow-hidden px-3 pt-1">
        {note.preview?.length ? (
          <NotePreview blocks={note.preview} />
        ) : (
          note.snippet && <p className="whitespace-pre-line text-sm text-muted">{note.snippet}</p>
        )}
      </div>
      <div className="flex flex-wrap items-end justify-between gap-2 px-3 pb-2 pt-1">
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

/**
 * `primary`'s order, with the ids only `secondary` knows slotted in after the id they followed
 * there. Used to lay a remembered arrangement over the cards on screen, and to fold a new
 * arrangement of the visible cards back into the remembered one without losing the rest.
 */
export function mergeOrder(primary: string[], secondary: string[]): string[] {
  const known = new Set(secondary);
  return stableOrder(primary, [...secondary, ...primary.filter((id) => !known.has(id))]);
}

const sameIds = (a: string[], b: string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * The board's order across renders. `resetKey` (tab, search, tag) starts afresh. With `remember`,
 * the order cards were dragged into on this device is applied and `move` saves to it; without
 * (search results) a drag only lasts until the search changes.
 */
export function useNoteOrder(
  notes: NoteSummary[],
  resetKey: string,
  remember: boolean,
): { notes: NoteSummary[]; move: (activeId: string, overId: string) => void } {
  const server = notes.map((note) => note.id);
  const [saved, setSaved] = useState(readNoteOrder);
  const [memo, setMemo] = useState<{ key: string; ids: string[] }>({ key: resetKey, ids: [] });
  const previous = memo.key === resetKey ? memo.ids : [];
  const ids = stableOrder(remember ? mergeOrder(previous, saved) : previous, server);
  if (memo.key !== resetKey || !sameIds(ids, memo.ids)) setMemo({ key: resetKey, ids });

  const move = (activeId: string, overId: string) => {
    const from = ids.indexOf(activeId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) return;
    const next = arrayMove(ids, from, to);
    setMemo({ key: resetKey, ids: next });
    if (remember) {
      const merged = mergeOrder(next, saved);
      setSaved(merged);
      saveNoteOrder(merged);
    }
  };

  const byId = new Map(notes.map((note) => [note.id, note]));
  return {
    notes: ids.flatMap((id) => {
      const note = byId.get(id);
      return note ? [note] : [];
    }),
    move,
  };
}
