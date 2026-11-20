// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { createDragCopyController } from './clipboard.js';
import { CENSORED_PLACEHOLDER, docToMarkdown, markdownToDoc } from './markdown.js';
import { buildExtensions, noteClipboardProps } from './NoteEditor.js';

const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';

interface FakeClipboard {
  files: File[];
  clearData(): void;
  setData(type: string, value: string): void;
  getData(type: string): string;
}

function fakeClipboard(): FakeClipboard {
  const store = new Map<string, string>();
  return {
    files: [],
    clearData: () => store.clear(),
    setData: (type, value) => store.set(type, value),
    getData: (type) => store.get(type) ?? '',
  };
}

interface Mounted {
  editor: Editor;
  el: HTMLDivElement;
}

function makeEditor(markdown: string): Mounted {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: buildExtensions(),
    content: markdownToDoc(markdown),
    // The real clipboard props, including the custom DOMSerializer that the review exposed.
    editorProps: noteClipboardProps(createDragCopyController()),
  });
  mounted.push({ editor, el });
  return { editor, el };
}

function clipboardEvent(type: 'cut' | 'copy' | 'paste', data: FakeClipboard): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, { clipboardData: { value: data } });
  return event;
}

let mounted: Mounted[] = [];

afterEach(() => {
  for (const { editor, el } of mounted) {
    editor.destroy();
    el.remove();
  }
  mounted = [];
});

describe('HIGH: cut → paste keeps the text (all DOMSerializer arguments forwarded)', () => {
  it('round-trips hello **world** through text/html and text/plain', () => {
    const { editor: source } = makeEditor('hello **world**');
    source.commands.selectAll();
    const data = fakeClipboard();
    const cut = clipboardEvent('cut', data);
    source.view.dom.dispatchEvent(cut);

    expect(cut.defaultPrevented).toBe(true);
    // Before the fix the recursive serializer dropped ProseMirror's third `target` argument:
    // the paragraph and the bold run serialised to empty HTML.
    expect(data.getData('text/html')).toContain('hello');
    expect(data.getData('text/html')).toContain('<strong>world</strong>');
    expect(data.getData('text/plain')).toContain('hello world');
    expect(source.state.doc.textContent).toBe('');

    const { editor: target } = makeEditor('');
    target.commands.setTextSelection(1);
    const paste = clipboardEvent('paste', data);
    target.view.dom.dispatchEvent(paste);
    expect(paste.defaultPrevented).toBe(true);
    expect(docToMarkdown(target.getJSON())).toBe('hello **world**');
  });

  it('round-trips the plain-text flavour when no HTML is available', () => {
    const { editor: source } = makeEditor('hello **world**');
    source.commands.selectAll();
    const data = fakeClipboard();
    source.view.dom.dispatchEvent(clipboardEvent('cut', data));

    const plainOnly = fakeClipboard();
    plainOnly.setData('text/plain', data.getData('text/plain'));
    const { editor: target } = makeEditor('');
    target.commands.setTextSelection(1);
    target.view.dom.dispatchEvent(clipboardEvent('paste', plainOnly));
    // Plain text cannot carry the bold mark, but no text may be lost.
    expect(target.state.doc.textContent).toBe('hello world');
  });
});

describe('HIGH: copying a censored span still yields only █████', () => {
  it('text/html and text/plain never contain the token', () => {
    const { editor: source } = makeEditor(`before ${TOKEN} after`);
    source.commands.selectAll();
    const data = fakeClipboard();
    source.view.dom.dispatchEvent(clipboardEvent('copy', data));

    const html = data.getData('text/html');
    const text = data.getData('text/plain');
    expect(html).toContain(CENSORED_PLACEHOLDER);
    expect(text).toContain(CENSORED_PLACEHOLDER);
    expect(html).not.toContain(TOKEN);
    expect(text).not.toContain(TOKEN);

    const { editor: target } = makeEditor('');
    target.commands.setTextSelection(1);
    target.view.dom.dispatchEvent(clipboardEvent('paste', data));
    expect(target.state.doc.textContent).toContain(CENSORED_PLACEHOLDER);
    expect(target.state.doc.textContent).not.toContain(TOKEN);
  });
});
