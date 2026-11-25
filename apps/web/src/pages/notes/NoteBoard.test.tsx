// @vitest-environment happy-dom
import type { NoteSummary } from '@bokydo/shared';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCardSize, readNoteOrder } from '../../lib/note-layout.js';
import { mergeOrder, NoteCard, useNoteOrder } from './NoteCard.js';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));
// The card's editor is tested with NoteDetail; here it is the preview it falls back to.
vi.mock('./NoteDetail.js', () => ({
  NoteCardEditor: ({ fallback }: { fallback: unknown }) => fallback,
}));

const note = (id: string, title = id): NoteSummary =>
  ({
    id,
    title,
    snippet: '',
    preview: [],
    tags: [],
    pinned: false,
    updatedAt: '2026-11-25T10:00:00.000Z',
  }) as unknown as NoteSummary;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('mergeOrder', () => {
  it('lays the remembered order over the cards on screen', () => {
    // On screen a, b; remembered c, b, a, d: the screen order wins, c and d stay after what they followed.
    expect(mergeOrder(['a', 'b'], ['c', 'b', 'a', 'd'])).toEqual(['c', 'a', 'd', 'b']);
    expect(mergeOrder(['x'], [])).toEqual(['x']);
    expect(mergeOrder([], ['p', 'q'])).toEqual(['p', 'q']);
  });
});

describe('useNoteOrder', () => {
  let move: (activeId: string, overId: string) => void = () => {};

  function Board({
    notes,
    resetKey,
    remember,
  }: {
    notes: NoteSummary[];
    resetKey: string;
    remember: boolean;
  }) {
    const order = useNoteOrder(notes, resetKey, remember);
    move = order.move;
    return <p>{order.notes.map((n) => n.id).join(',')}</p>;
  }
  const show = (notes: NoteSummary[], remember = true, resetKey = 'k') =>
    act(() => root.render(<Board notes={notes} resetKey={resetKey} remember={remember} />));

  it('keeps a dragged order, remembers it, and applies it on the next visit', () => {
    show([note('a'), note('b'), note('c')]);
    expect(container.textContent).toBe('a,b,c');
    act(() => move('c', 'a'));
    expect(container.textContent).toBe('c,a,b');
    expect(readNoteOrder()).toEqual(['c', 'a', 'b']);

    // The server still lists newest first; the board does not jump back.
    show([note('b'), note('a'), note('c')]);
    expect(container.textContent).toBe('c,a,b');

    // A fresh board (another tab, a reload) starts from the remembered order; a new note goes
    // where the server put it, at the top.
    show([note('n'), note('a'), note('b'), note('c')], true, 'other');
    expect(container.textContent).toBe('n,c,a,b');
  });

  it('places a later page’s remembered notes where they were dragged to', () => {
    localStorage.setItem('bokydo.notes.order', JSON.stringify(['z', 'a', 'b']));
    show([note('a'), note('b')]);
    expect(container.textContent).toBe('a,b');
    show([note('a'), note('b'), note('z')]);
    expect(container.textContent).toBe('z,a,b');
  });

  it('does not apply or save the arrangement in search results', () => {
    localStorage.setItem('bokydo.notes.order', JSON.stringify(['b', 'a']));
    show([note('a'), note('b')], false);
    expect(container.textContent).toBe('a,b');
    act(() => move('b', 'a'));
    expect(container.textContent).toBe('b,a');
    expect(readNoteOrder()).toEqual(['b', 'a']);
    act(() => move('a', 'b'));
    expect(readNoteOrder()).toEqual(['b', 'a']);
  });
});

describe('resizing a card', () => {
  function pointer(type: string, init: PointerEventInit) {
    return new PointerEvent(type, { bubbles: true, button: 0, pointerId: 1, ...init });
  }

  async function renderCard() {
    await act(async () => root.render(<NoteCard note={note('n1', 'Card')} />));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 320,
      height: 288,
    } as DOMRect);
    const card = container.querySelector<HTMLElement>('.bk-note-card');
    if (!card) throw new Error('card not rendered');
    return card;
  }

  function edge(name: string): HTMLElement {
    const el = container.querySelector<HTMLElement>(`[data-edge="${name}"]`);
    if (!el) throw new Error(`no ${name} edge`);
    return el;
  }

  it('has a handle on every edge and corner', async () => {
    await renderCard();
    expect(
      [...container.querySelectorAll('[data-edge]')].map((el) => el.getAttribute('data-edge')),
    ).toEqual(['n', 'e', 's', 'w', 'ne', 'se', 'sw', 'nw']);
  });

  it('pulling the left edge out widens the card, and the size is remembered', async () => {
    const card = await renderCard();
    const handle = edge('w');
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', { clientX: 300, clientY: 100 }));
      handle.dispatchEvent(pointer('pointermove', { clientX: 220, clientY: 100 }));
      handle.dispatchEvent(pointer('pointerup', { clientX: 220, clientY: 100 }));
    });
    expect(card.style.width).toBe('400px');
    expect(card.style.height).toBe('288px');
    expect(readCardSize('n1')).toEqual({ width: 400, height: 288 });
  });

  it('a corner resizes both ways and stops at the smallest card', async () => {
    const card = await renderCard();
    const handle = edge('nw');
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 0 }));
      handle.dispatchEvent(pointer('pointermove', { clientX: 500, clientY: 500 }));
      handle.dispatchEvent(pointer('pointerup', { clientX: 500, clientY: 500 }));
    });
    expect(card.style.width).toBe('192px');
    expect(card.style.height).toBe('112px');
  });

  it('a cancelled drag puts the size back', async () => {
    const card = await renderCard();
    const handle = edge('se');
    await act(async () => {
      handle.dispatchEvent(pointer('pointerdown', { clientX: 0, clientY: 0 }));
      handle.dispatchEvent(pointer('pointermove', { clientX: 60, clientY: 40 }));
    });
    expect(card.style.width).toBe('380px');
    await act(async () => {
      handle.dispatchEvent(pointer('pointercancel', {}));
    });
    expect(card.style.width).toBe('');
    expect(readCardSize('n1')).toBeNull();
  });

  it('the title bar is the drag handle', async () => {
    await renderCard();
    const handle = container.querySelector('.bk-note-card-handle');
    expect(handle?.getAttribute('role')).toBe('button');
    expect(handle?.getAttribute('aria-roledescription')).toBe('sortable');
    expect(handle?.textContent).toBe('Card');
  });
});
