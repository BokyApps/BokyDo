// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion -- node-view props cannot be built without TipTap's runtime types. */
import type { Editor } from '@tiptap/core';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tiptap/react', () => ({
  NodeViewWrapper: ({ children, as: _as, ...props }: any) => <span {...props}>{children}</span>,
  ReactNodeViewRenderer: () => () => null,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

import { registerCallbacks, type NoteCallbacks } from './callbacks.js';
import { CensoredView, EmbedView } from './nodes.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// A third-party iframe is appended in the embed test; page loading is off, which happy-dom
// otherwise reports as a virtual-console error. The frame's attributes are what we assert on.
(
  window as unknown as { happyDOM: { settings: { handleDisabledFileLoadingAsSuccess: boolean } } }
).happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;

const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';

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

function render(onReveal: NoteCallbacks['onReveal'] = vi.fn()) {
  const editor = { isEditable: true } as unknown as Editor;
  const callbacks: NoteCallbacks = {
    onUploadFile: undefined,
    onOpenInternal: undefined,
    searchNotes: undefined,
    searchTasks: undefined,
    onCensor: undefined,
    onReveal,
    onUncensor: undefined,
    onProtectedCut: undefined,
    onCensorSettled: undefined,
    onRemoveCensorFailed: undefined,
  };
  registerCallbacks(editor, { current: callbacks });
  const props = {
    node: { attrs: { token: TOKEN }, type: { name: 'censored' } },
    editor,
    getPos: () => 1,
    decorations: [],
    innerDecorations: [],
    view: null,
    extension: null,
    HTMLAttributes: {},
    selected: false,
    updateAttributes: () => {},
    deleteNode: () => {},
  };
  act(() => {
    root.render(<CensoredView {...(props as any)} />);
  });
  return { onReveal };
}

const trigger = () => container.querySelector('button.bk-censored-block') as HTMLButtonElement;

describe('E7: the censor trigger is a native button with a real menu', () => {
  it('does not claim role="img" and labels the options', () => {
    render();
    const button = trigger();
    expect(button).not.toBeNull();
    expect(button.tagName).toBe('BUTTON');
    expect(button.getAttribute('type')).toBe('button');
    expect(button.getAttribute('role')).not.toBe('img');
    expect(button.getAttribute('aria-label')).toBe('Censored text, options');
    expect(button.getAttribute('aria-haspopup')).toBe('menu');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('moves focus into the menu and Escape closes it, restoring focus to the trigger', () => {
    render();
    act(() => {
      trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const menu = container.querySelector('[role="menu"]');
    expect(menu).not.toBeNull();
    const first = menu!.querySelector('button');
    expect(document.activeElement).toBe(first);

    act(() => {
      first!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it('Reveal closes the menu and reports the token to the page', () => {
    const { onReveal } = render();
    act(() => {
      trigger().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const reveal = container.querySelector('[role="menu"] button')!;
    act(() => {
      reveal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onReveal).toHaveBeenCalledOnce();
    expect(vi.mocked(onReveal!).mock.calls[0]![0]).toBe(TOKEN);
    expect(container.querySelector('[role="menu"]')).toBeNull();
  });
});

describe('E6: a changed embed URL needs a new click', () => {
  const A = 'https://youtu.be/dQw4w9WgXcQ';
  const B = 'https://youtu.be/aaaaaaaaaaa';

  const embedProps = (url: string) => ({
    node: { attrs: { label: 'Video', url }, type: { name: 'embed' } },
    editor: null,
    getPos: () => 0,
    decorations: [],
    innerDecorations: [],
    view: null,
    extension: null,
    HTMLAttributes: {},
    selected: false,
    updateAttributes: () => {},
    deleteNode: () => {},
  });

  it('creates an iframe only while the URL still matches the authorised one', () => {
    // happy-dom has no `credentialless`; give the prototype the property so the frame path runs.
    Object.defineProperty(HTMLIFrameElement.prototype, 'credentialless', {
      value: false,
      configurable: true,
    });
    // happy-dom logs a virtual-console error when it declines to load the third-party frame; the
    // frame's attributes themselves are covered by embed.test's fake IframeLike.
    act(() => {
      root.render(<EmbedView {...(embedProps(A) as any)} />);
    });
    const play = container.querySelector('.bk-embed-play') as HTMLButtonElement;
    expect(play).not.toBeNull();
    act(() => {
      play.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.querySelector('iframe')).not.toBeNull();

    // The node's URL changes without a click: tear the frame down and show the card again.
    act(() => {
      root.render(<EmbedView {...(embedProps(B) as any)} />);
    });
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('.bk-embed-play')).not.toBeNull();
  });
});
