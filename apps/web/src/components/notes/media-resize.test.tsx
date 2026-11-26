// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any -- node-view props cannot be built without TipTap's runtime types. */
import { act, forwardRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: forwardRef<HTMLElement, any>(({ children, as: _as, ...props }, ref) => (
    <span ref={ref} {...props}>
      {children}
    </span>
  )),
  ReactNodeViewRenderer: () => () => null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

import { EmbedView, NoteImageView } from './nodes.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const UUID = '123e4567-e89b-12d3-a456-426614174000';
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderImage(width: number | null, editable = true) {
  const updateAttributes = vi.fn();
  const props = {
    node: { attrs: { id: UUID, alt: 'photo', width } },
    editor: { isEditable: editable },
    updateAttributes,
  } as any;
  act(() => root.render(<NoteImageView {...props} />));
  return updateAttributes;
}

function handle(): HTMLElement {
  const el = container.querySelector<HTMLElement>('[role="slider"]');
  if (!el) throw new Error('no resize handle');
  return el;
}

function pointer(type: string, clientX: number) {
  const event = new PointerEvent(type, { bubbles: true, clientX, pointerId: 1, button: 0 });
  act(() => {
    handle().dispatchEvent(event);
  });
}

describe('resizing media in a note', () => {
  it('shows a sized image at its width', () => {
    renderImage(260);
    const wrapper = container.querySelector<HTMLElement>('.bk-media-sized');
    expect(wrapper?.style.width).toBe('260px');
    expect(container.querySelector('img')?.getAttribute('src')).toBe(
      `/api/v1/note-files/${UUID}?inline=1`,
    );
  });

  it('saves the width a drag on the corner handle ends at', () => {
    const update = renderImage(null);
    pointer('pointerdown', 100);
    pointer('pointermove', 400);
    expect(container.querySelector<HTMLElement>('.bk-media-sized')?.style.width).toBe('300px');
    pointer('pointerup', 400);
    expect(update).toHaveBeenCalledWith({ width: 300 });
  });

  it('resizes from the keyboard and resets to the natural size', () => {
    const update = renderImage(300);
    act(() => {
      handle().dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(update).toHaveBeenLastCalledWith({ width: 320 });
    act(() => {
      handle().dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    });
    expect(update).toHaveBeenLastCalledWith({ width: null });
  });

  it('does nothing while the note is read-only', () => {
    const update = renderImage(null, false);
    pointer('pointerdown', 100);
    pointer('pointermove', 400);
    pointer('pointerup', 400);
    expect(update).not.toHaveBeenCalled();
  });

  it('gives an embed the same handle and width', () => {
    const updateAttributes = vi.fn();
    const props = {
      node: {
        attrs: { label: 'Talk', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', width: 480 },
      },
      editor: { isEditable: true },
      updateAttributes,
    } as any;
    act(() => root.render(<EmbedView {...props} />));
    expect(container.querySelector<HTMLElement>('.bk-embed-card')?.style.width).toBe('480px');
    pointer('pointerdown', 0);
    pointer('pointermove', 120);
    pointer('pointerup', 120);
    expect(updateAttributes).toHaveBeenCalledWith({ width: 120 });
  });
});
