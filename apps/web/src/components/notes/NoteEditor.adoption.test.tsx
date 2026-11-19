// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- DOM test fixtures are non-null. */
import type { Editor } from '@tiptap/core';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

import { docToMarkdown } from './markdown.js';
import { NoteEditor } from './NoteEditor.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';
const SECRET = 'TOP SECRET';

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
  vi.unstubAllGlobals();
});

/**
 * The page's contract in miniature: it owns the Markdown and hands the editor a fresh
 * `historyResetKey` whenever it adopts a remote body. Adoption is triggered by a button so the
 * test goes through the same props as `NoteDetail` rather than reaching into the editor.
 */
function Harness({
  initial,
  onChange,
}: {
  initial: string;
  onChange?: (markdown: string) => void;
}) {
  const [markdown, setMarkdown] = useState(initial);
  const [historyResetKey, setHistoryResetKey] = useState(0);
  return (
    <>
      <NoteEditor
        markdown={markdown}
        historyResetKey={historyResetKey}
        onChange={(next) => {
          setMarkdown(next);
          onChange?.(next);
        }}
      />
      <button
        type="button"
        data-testid="adopt"
        onClick={() => {
          setMarkdown(`before ${TOKEN} after`);
          setHistoryResetKey((key) => key + 1);
        }}
      >
        adopt remote
      </button>
    </>
  );
}

function tipTapEditor(): Editor {
  const dom = container.querySelector<HTMLElement>('.bk-note-prosemirror');
  if (!dom) throw new Error('the editor did not mount');
  // @tiptap/core attaches the Editor to the ProseMirror view DOM (`dom.editor`).
  const editor = (dom as HTMLElement & { editor?: Editor }).editor;
  if (!editor) throw new Error('TipTap did not attach its editor instance');
  return editor;
}

const markdown = (): string => docToMarkdown(tipTapEditor().getJSON());

describe('HIGH: Undo after adopting a remote body never republishes plaintext', () => {
  it('adopts a censored body, then Undo x10 never brings the old plaintext back', async () => {
    const onChange = vi.fn();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await act(async () =>
      root.render(<Harness initial={`before ${SECRET} after`} onChange={onChange} />),
    );
    expect(markdown()).toContain(SECRET);

    const adopt = container.querySelector<HTMLButtonElement>('button[data-testid="adopt"]');
    if (!adopt) throw new Error('the adoption trigger is missing');
    await act(async () => adopt.click());

    expect(markdown()).toContain(TOKEN);
    expect(markdown()).not.toContain(SECRET);

    // Undo everything that is left. A fresh history means there is nothing left to undo.
    await act(async () => {
      for (let i = 0; i < 10; i++) tipTapEditor().commands.undo();
    });

    expect(markdown()).toContain(TOKEN);
    expect(markdown()).not.toContain(SECRET);
    for (const [emitted] of onChange.mock.calls) expect(String(emitted)).not.toContain(SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('an ordinary source-view edit is still undoable (the reset is not global)', async () => {
    await act(async () => root.render(<Harness initial="first" />));

    const toggle = container.querySelector<HTMLButtonElement>('button[aria-pressed]');
    if (!toggle) throw new Error('the Markdown toggle is missing');
    await act(async () => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const textarea = container.querySelector<HTMLTextAreaElement>('textarea');
    if (!textarea) throw new Error('the Markdown view did not open');
    const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setValue.call(textarea, 'second');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(markdown()).toBe('second');

    await act(async () => {
      tipTapEditor().commands.undo();
    });
    expect(markdown()).toBe('first');
  });
});
