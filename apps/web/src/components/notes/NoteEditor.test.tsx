// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM test fixtures are non-null. */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const editor = {
    getJSON: () => ({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'bold', marks: [{ type: 'bold' }] }],
        },
      ],
    }),
    commands: { setContent: vi.fn() },
    setEditable: vi.fn(),
    chain: () => ({ focus: () => ({ run: () => true }) }),
    isDestroyed: false,
  };
  return { editor, options: { current: null as unknown } };
});

vi.mock('@tiptap/react', () => ({
  useEditor: (options: unknown) => {
    h.options.current = options;
    return h.editor;
  },
  EditorContent: () => null,
  ReactNodeViewRenderer: () => () => null,
  NodeViewWrapper: ({ children }: { children?: unknown }) => children,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

import { NoteEditor } from './NoteEditor.js';

interface EditorOptions {
  onUpdate?: (event: { editor: typeof h.editor }) => void;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  h.editor.commands.setContent.mockClear();
  h.editor.setEditable.mockClear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.querySelectorAll('[data-testid="reveal-overlay"]').forEach((el) => el.remove());
});

const toggle = () => container.querySelector('button[aria-pressed]') as HTMLButtonElement;
const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement | null;

function setTextareaValue(value: string): void {
  const el = textarea()!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('NoteEditor markdown toggle & view sync', () => {
  it('starts in WYSIWYG (aria-pressed=false) with no textarea', async () => {
    await act(async () => {
      root.render(<NoteEditor markdown="hello **world**" onChange={() => {}} />);
    });
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(textarea()).toBeNull();
  });

  it('toggles to a monospace textarea showing the exact Markdown and back', async () => {
    await act(async () => {
      root.render(<NoteEditor markdown="hello **world**" onChange={() => {}} />);
    });
    await act(async () => {
      toggle().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(textarea()).not.toBeNull();
    expect(textarea()!.value).toBe('hello **world**');
    expect(textarea()!.className).toContain('bk-note-textarea');
    await act(async () => {
      toggle().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(textarea()).toBeNull();
  });

  it('editing the Markdown textarea emits the edited Markdown via onChange', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<NoteEditor markdown="hello" onChange={onChange} />);
    });
    await act(async () => {
      toggle().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      setTextareaValue('# Title\n\nSome *text*');
    });
    expect(onChange).toHaveBeenCalledWith('# Title\n\nSome *text*');
  });

  it('WYSIWYG document changes emit canonical Markdown via onChange', async () => {
    const onChange = vi.fn();
    await act(async () => {
      root.render(<NoteEditor markdown="hello" onChange={onChange} />);
    });
    const options = h.options.current as EditorOptions;
    await act(async () => {
      options.onUpdate?.({ editor: h.editor });
    });
    // getJSON() is the bold paragraph, which serialises back to **bold**.
    expect(onChange).toHaveBeenCalledWith('**bold**');
  });

  it('external Markdown changes sync into the editor (setContent), keeping the two views in step', async () => {
    await act(async () => {
      root.render(<NoteEditor markdown="first" onChange={() => {}} />);
    });
    h.editor.commands.setContent.mockClear();
    await act(async () => {
      root.render(<NoteEditor markdown="# Changed" onChange={() => {}} />);
    });
    expect(h.editor.commands.setContent).toHaveBeenCalled();
    const [content, options] = h.editor.commands.setContent.mock.calls[0]!;
    expect(content.type).toBe('doc');
    expect(options).toEqual({ emitUpdate: false });
  });

  it('respects editable=false (textarea is read-only)', async () => {
    await act(async () => {
      root.render(<NoteEditor markdown="x" onChange={() => {}} editable={false} />);
    });
    await act(async () => {
      toggle().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(textarea()!.readOnly).toBe(true);
    expect(h.editor.setEditable).toHaveBeenCalledWith(false, false);
  });

  it('reveal plaintext is portaled outside the editor root DOM', async () => {
    await act(async () => {
      root.render(
        <NoteEditor
          markdown="hello"
          onChange={() => {}}
          revealState={{
            plaintext: 'TOP SECRET',
            anchor: { top: 0, left: 0, bottom: 0, right: 0 },
          }}
          onCloseReveal={() => {}}
        />,
      );
    });
    const editorRoot = container.querySelector('.bk-note-editor');
    expect(editorRoot).not.toBeNull();
    expect(editorRoot!.textContent).not.toContain('TOP SECRET');
    const overlay = document.querySelector('[data-testid="reveal-overlay"]');
    expect(overlay).not.toBeNull();
    expect(editorRoot!.contains(overlay!)).toBe(false);
    expect(document.body.contains(overlay!)).toBe(true);
    expect(overlay!.textContent).toContain('TOP SECRET');
  });
});
