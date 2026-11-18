// @vitest-environment happy-dom
import { Editor, Node, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { undo, redo } from '@tiptap/pm/history';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyUncensored,
  censorSelection,
  commitCensored,
  findCensoredNode,
} from './censor-command.js';

const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';
const SECRET = 'TOPSECRET';

// A minimal schema (no React node views) so the real censor commands can run headlessly.
const Censored = Node.create({
  name: 'censored',
  group: 'inline',
  inline: true,
  atom: true,
  addAttributes() {
    return { token: { default: '' } };
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-censored': '1' }), '█████'];
  },
  parseHTML() {
    return [{ tag: 'span[data-censored]' }];
  },
});

let mounted: { editor: Editor; el: HTMLDivElement }[] = [];
function makeEditor(content = '<p>hello TOPSECRET world</p>') {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const onChange: string[] = [];
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, Censored],
    content,
    onUpdate: ({ editor }) => onChange.push(editor.state.doc.textContent),
  });
  mounted.push({ editor, el });
  return { editor, onChange };
}

afterEach(() => {
  for (const { editor, el } of mounted) {
    editor.destroy();
    el.remove();
  }
  mounted = [];
});

describe('HIGH: censor → undo/redo never restores plaintext', () => {
  it('censor, then undo/redo many times → plaintext never in doc or onChange', async () => {
    const { editor, onChange } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 7 + SECRET.length });
    expect(await censorSelection(editor, 7, 7 + SECRET.length, async () => TOKEN)).toBe('ok');
    expect(editor.state.doc.textContent).not.toContain(SECRET);

    // Exercise history from both directions repeatedly.
    for (let i = 0; i < 12; i++) {
      undo(editor.state, editor.view.dispatch);
      redo(editor.state, editor.view.dispatch);
      expect(editor.state.doc.textContent).not.toContain(SECRET);
    }
    // onChange only ever saw the censored document (never the plaintext).
    expect(onChange.every((s) => !s.includes(SECRET))).toBe(true);
    expect(onChange.length).toBeGreaterThan(0);
    // The token is present, so the censored atom survived.
    let hasCensored = false;
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'censored' && n.attrs.token === TOKEN) hasCensored = true;
      return true;
    });
    expect(hasCensored).toBe(true);
  });

  it('commitCensored on its own wipes history (no undo step holds plaintext)', () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 7 + SECRET.length });
    commitCensored(editor, 7, 7 + SECRET.length, TOKEN);
    for (let i = 0; i < 6; i++) {
      undo(editor.state, editor.view.dispatch);
      expect(editor.state.doc.textContent).not.toContain(SECRET);
    }
  });
});

describe('HIGH: edit while the password prompt is open aborts', () => {
  it('a stale selection is not replaced; the secret stays intact and editable is restored', async () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 7 + SECRET.length });
    let release!: (token: string) => void;
    const pending = new Promise<string>((r) => (release = r));
    const outcomeP = censorSelection(editor, 7, 7 + SECRET.length, () => pending);
    // The editor is read-only while the prompt is open.
    expect(editor.isEditable).toBe(false);
    // An external edit lands during the prompt → stale offsets must be rejected.
    editor.commands.insertContentAt(0, 'Prefix ');
    release(TOKEN);
    expect(await outcomeP).toBe('aborted');
    expect(editor.state.doc.textContent).toContain(SECRET); // secret not wrongly replaced
    expect(editor.isEditable).toBe(true);
  });

  it('a cancelled prompt restores editable and changes nothing', async () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 7 + SECRET.length });
    expect(await censorSelection(editor, 7, 7 + SECRET.length, async () => null)).toBe('cancelled');
    expect(editor.state.doc.textContent).toContain(SECRET);
    expect(editor.isEditable).toBe(true);
  });
});

describe('HIGH: Remove censor re-finds the exact token in the current doc', () => {
  it('replaces at the current position (not a stale one)', () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 7 + SECRET.length });
    commitCensored(editor, 7, 7 + SECRET.length, TOKEN);
    // Move the atom by typing text before it, then remove by token.
    editor.commands.insertContentAt(1, 'leading ');
    const found = findCensoredNode(editor.state.doc, TOKEN);
    expect(found).not.toBeNull();
    expect(applyUncensored(editor, TOKEN, 'revealed')).toBe(true);
    expect(editor.state.doc.textContent).toContain('revealed');
    expect(editor.state.doc.textContent).not.toContain(SECRET);
  });

  it('aborts if the token changed or is gone (late result at a stale position)', () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 7 + SECRET.length });
    commitCensored(editor, 7, 7 + SECRET.length, TOKEN);
    // Delete the atom; a late Remove for the old token must not insert at a stale position.
    const found = findCensoredNode(editor.state.doc, TOKEN);
    if (!found) throw new Error('expected a censored node');
    editor.commands.deleteRange({ from: found.from, to: found.to });
    const before = editor.state.doc.textContent;
    expect(applyUncensored(editor, TOKEN, 'revealed')).toBe(false);
    expect(editor.state.doc.textContent).toBe(before);
  });

  it('aborts when a different token is requested', () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 7 + SECRET.length });
    commitCensored(editor, 7, 7 + SECRET.length, TOKEN);
    expect(applyUncensored(editor, '{{censored:v1:other}}', 'revealed')).toBe(false);
  });

  it('aborts on duplicate tokens (ambiguous)', () => {
    const { editor } = makeEditor('<p>x</p>');
    editor.commands.insertContentAt(1, [
      { type: 'censored', attrs: { token: TOKEN } },
      { type: 'censored', attrs: { token: TOKEN } },
    ]);
    expect(findCensoredNode(editor.state.doc, TOKEN)).toBeNull();
  });

  it('requires an editable editor', () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 7 + SECRET.length });
    commitCensored(editor, 7, 7 + SECRET.length, TOKEN);
    editor.setEditable(false, false);
    expect(applyUncensored(editor, TOKEN, 'revealed')).toBe(false);
  });
});
