// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- ProseMirror schema/test fixtures are non-null. */
import { Editor, Node, mergeAttributes, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { undo, redo } from '@tiptap/pm/history';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyUncensored,
  censorSelection,
  censorableSelection,
  censorRoundTripSurvives,
  CensoredRemovalTracker,
  commitCensored,
  findRemovalTarget,
  markCensoredForRemoval,
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
    // Mirrors the real node: `removeId` is the transient Remove binding.
    return { token: { default: '' }, removeId: { default: null } };
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes, { 'data-censored': '1' }), '█████'];
  },
  parseHTML() {
    return [{ tag: 'span[data-censored]' }];
  },
});

import { safeTableExtensions } from './table.js';

let mounted: { editor: Editor; el: HTMLDivElement }[] = [];
function makeEditor(content = '<p>hello TOPSECRET world</p>', extra: AnyExtension[] = []) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const onChange: string[] = [];
  const editor = new Editor({
    element: el,
    extensions: [StarterKit, ...safeTableExtensions, Censored, CensoredRemovalTracker, ...extra],
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

describe('HIGH: Remove censor is bound to the atom the user confirmed (P3)', () => {
  /** The position of the first censored atom in the document. */
  function firstCensoredPos(editor: Editor): number {
    let pos = -1;
    editor.state.doc.descendants((node, at) => {
      if (pos === -1 && node.type.name === 'censored') pos = at;
      return pos === -1;
    });
    if (pos === -1) throw new Error('expected a censored node');
    return pos;
  }

  it('replaces the marked atom even after it moved with later transactions', () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 7 + SECRET.length });
    commitCensored(editor, 7, 7 + SECRET.length, TOKEN);
    const removeId = markCensoredForRemoval(editor, firstCensoredPos(editor))!;
    expect(removeId).toMatch(/^rm-/);
    // Move the atom by typing text before it, then remove by the transient id.
    editor.commands.insertContentAt(1, 'leading ');
    expect(findRemovalTarget(editor.state.doc, removeId)).not.toBeNull();
    expect(applyUncensored(editor, removeId, 'revealed')).toBe('ok');
    expect(editor.state.doc.textContent).toContain('revealed');
    expect(editor.state.doc.textContent).not.toContain(SECRET);
  });

  it('aborts if the marked atom was deleted, and never redirects to an identical token', () => {
    const { editor } = makeEditor('<p>x</p>');
    editor.commands.insertContentAt(1, [
      { type: 'censored', attrs: { token: TOKEN } },
      { type: 'text', text: ' gap ' },
      { type: 'censored', attrs: { token: TOKEN } },
    ]);
    const pos = firstCensoredPos(editor);
    const removeId = markCensoredForRemoval(editor, pos)!;
    const size = editor.state.doc.nodeAt(pos)!.nodeSize;
    editor.commands.deleteRange({ from: pos, to: pos + size });
    // Exactly one identical token still exists; the late Remove must NOT apply to it.
    const before = editor.state.doc.textContent;
    expect(applyUncensored(editor, removeId, 'revealed')).toBe('missing');
    expect(editor.state.doc.textContent).toBe(before);
    expect(editor.state.doc.textContent).not.toContain('revealed');
  });

  it('aborts when the removal id is unknown', () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 7 + SECRET.length });
    commitCensored(editor, 7, 7 + SECRET.length, TOKEN);
    expect(applyUncensored(editor, 'rm-does-not-exist', 'revealed')).toBe('missing');
  });

  it('requires an editable editor', () => {
    const { editor } = makeEditor();
    editor.commands.setTextSelection({ from: 7, to: 7 + SECRET.length });
    commitCensored(editor, 7, 7 + SECRET.length, TOKEN);
    const removeId = markCensoredForRemoval(editor, firstCensoredPos(editor))!;
    editor.setEditable(false, false);
    expect(applyUncensored(editor, removeId, 'revealed')).toBe('missing');
  });
});

describe('HIGH: censor only spans that can survive a reload (E3)', () => {
  it('rejects a selection inside a code block before prompting', async () => {
    const { editor } = makeEditor('<pre><code>TOPSECRET</code></pre>');
    const from = 1; // inside the code block's text
    const to = 1 + SECRET.length;
    expect(censorableSelection(editor, from, to)).toBe(false);
    const onCensor = vi.fn(async () => TOKEN);
    expect(await censorSelection(editor, from, to, onCensor)).toBe('unsupported');
    expect(onCensor).not.toHaveBeenCalled();
    expect(editor.state.doc.textContent).toContain(SECRET);
  });

  it('rejects a mixed selection that starts in a paragraph and reaches a code block', () => {
    const { editor } = makeEditor('<p>plain TOPSECRET</p><pre><code>code</code></pre>');
    expect(censorableSelection(editor, 1, 1 + 'plain TOPSECRET code'.length)).toBe(false);
  });

  it('accepts a paragraph, a heading, a list item and a table cell', () => {
    const { editor } = makeEditor(
      '<p>alpha</p><h2>beta</h2><ul><li><p>gamma</p></li></ul><table><tbody><tr><td><p>delta</p></td></tr></tbody></table>',
    );
    const paragraphs: { pos: number; type: string }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'paragraph' || node.type.name === 'heading')
        paragraphs.push({ pos, type: node.type.name });
      return true;
    });
    expect(paragraphs.length).toBeGreaterThanOrEqual(4);
    const failures: unknown[] = [];
    for (const { pos, type } of paragraphs) {
      const text = editor.state.doc.nodeAt(pos)!.textContent;
      if (!text) continue;
      if (!censorableSelection(editor, pos + 1, pos + 1 + text.length))
        failures.push({ type, text });
    }
    expect(failures).toEqual([]);
  });

  it('rejects a selection that includes an inline atom', () => {
    const { editor } = makeEditor('<p>x</p>');
    editor.commands.insertContentAt(1, [
      { type: 'text', text: 'before ' },
      { type: 'censored', attrs: { token: TOKEN } },
      { type: 'text', text: ' after' },
    ]);
    expect(censorableSelection(editor, 1, editor.state.doc.content.size - 1)).toBe(false);
  });

  it('verifies the saved form before committing: a token the writer cannot keep aborts', () => {
    const { editor } = makeEditor('<p>hello</p>');
    const tr = editor.state.tr.replaceWith(
      1,
      6,
      editor.state.schema.nodes.censored!.create({ token: 'not-a-valid-token' }),
    );
    // The writer would emit █████ for an invalid token, so re-parsing finds no atom: abort.
    expect(censorRoundTripSurvives(editor, tr.doc, 'not-a-valid-token')).toBe(false);
    const good = editor.state.tr.replaceWith(
      1,
      6,
      editor.state.schema.nodes.censored!.create({ token: TOKEN }),
    );
    expect(censorRoundTripSurvives(editor, good.doc, TOKEN)).toBe(true);
  });
});
