// @vitest-environment happy-dom
import { Editor, getSchema, type JSONContent } from '@tiptap/core';
import { Fragment, Slice } from '@tiptap/pm/model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyUncensored,
  censorSelection,
  markCensoredForRemoval,
  removalTargets,
} from './censor-command.js';
import { createDragCopyController } from './clipboard.js';
import {
  contentToMarkdown,
  docToMarkdown,
  docsEquivalent,
  markdownToDoc,
  resetSerializationStats,
  serializationStats,
  verifyDocMarkdown,
} from './markdown.js';
import { buildExtensions, noteClipboardProps, retainRealDragSlice } from './NoteEditor.js';

const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';
const SECRET = 'SECRET';
const schema = getSchema(buildExtensions());

let mounted: { editor: Editor; el: HTMLDivElement }[] = [];

function makeEditor(
  markdown: string,
  options: Partial<ConstructorParameters<typeof Editor>[0]> = {},
) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const editor = new Editor({
    element: el,
    extensions: buildExtensions(),
    content: markdownToDoc(markdown),
    ...options,
  });
  mounted.push({ editor, el });
  return editor;
}

afterEach(() => {
  for (const { editor, el } of mounted) {
    editor.destroy();
    el.remove();
  }
  mounted = [];
  vi.restoreAllMocks();
});

function textPos(editor: Editor, needle: string): number {
  let found = -1;
  editor.state.doc.descendants((node, pos) => {
    if (found !== -1) return false;
    if (node.isText && node.text?.includes(needle)) {
      found = pos + node.text.indexOf(needle);
      return false;
    }
    return true;
  });
  if (found === -1) throw new Error(`text ${needle} not found`);
  return found;
}

function firstParagraphRange(editor: Editor): { from: number; to: number } {
  let range: { from: number; to: number } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (range) return false;
    if (node.type.name === 'paragraph') {
      range = { from: pos + 1, to: pos + 1 + node.content.size };
      return false;
    }
    return true;
  });
  if (!range) throw new Error('no paragraph');
  return range;
}

function everyAttr(node: JSONContent, visit: (value: unknown) => void): void {
  for (const value of Object.values(node.attrs ?? {})) visit(value);
  for (const mark of node.marks ?? []) {
    for (const value of Object.values(mark.attrs ?? {})) visit(value);
  }
  for (const child of node.content ?? []) everyAttr(child, visit);
}

function docContains(editor: Editor, needle: string): boolean {
  let found = false;
  everyAttr(editor.getJSON(), (value) => {
    if (typeof value === 'string' && value.includes(needle)) found = true;
  });
  return found;
}

interface FakeClipboard {
  files: File[];
  clearData(): void;
  setData(type: string, value: string): void;
  getData(type: string): string;
  store: Map<string, string>;
}

function fakeClipboard(): FakeClipboard {
  const store = new Map<string, string>();
  return {
    files: [],
    clearData: () => store.clear(),
    setData: (type, value) => store.set(type, value),
    getData: (type) => store.get(type) ?? '',
    store,
  };
}

function dragTransfer(data: FakeClipboard) {
  return { ...data, effectAllowed: 'uninitialized' };
}

function dispatchCopy(editor: Editor): FakeClipboard {
  const data = fakeClipboard();
  const event = new Event('copy', { bubbles: true, cancelable: true });
  Object.defineProperties(event, { clipboardData: { value: data } });
  editor.view.dom.dispatchEvent(event);
  return data;
}

async function dispatchDragStart(editor: Editor): Promise<FakeClipboard> {
  const data = fakeClipboard();
  const event = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    dataTransfer: { value: dragTransfer(data) },
    clientX: { value: 0 },
    clientY: { value: 0 },
  });
  editor.view.dom.dispatchEvent(event);
  await Promise.resolve();
  return data;
}

function sliceAttr(html: string): string {
  return /data-pm-slice="([^"]*)"/.exec(html)?.[1] ?? '';
}

// ---------------------------------------------------------------------------------------------
// H1: no plaintext in outbound HTML (data-pm-slice) or any retained attr after a censor
// ---------------------------------------------------------------------------------------------

describe('H1: censoring clears source meta and outbound copy/drag carries no plaintext', () => {
  const cases: [string, string][] = [
    ['blockquote', `> prefix ${SECRET} suffix`],
    ['list item', `- prefix ${SECRET} suffix`],
    ['table cell', `| prefix ${SECRET} suffix | x |\n| --- | --- |\n| y | z |`],
  ];

  it('transformCopied strips source-meta from the openStart ancestor context', () => {
    const doc = schema.nodeFromJSON(markdownToDoc(`> prefix ${SECRET} suffix`));
    const blockquote = doc.content.firstChild!;
    const slice = new Slice(Fragment.from(blockquote), 2, 2);
    const out = createDragCopyController().transformCopied(slice, schema);
    const attrs: unknown[] = [];
    out.content.descendants((node) => {
      attrs.push(node.attrs);
      for (const mark of node.marks) attrs.push(mark.attrs);
      return true;
    });
    expect(JSON.stringify(attrs)).not.toContain(SECRET);
    // ProseMirror materialises the global attribute as `null`; no retained source remains.
    out.content.descendants((node) => {
      expect(node.attrs.src ?? null).toBeNull();
      expect(node.attrs.blockId ?? null).toBeNull();
      return true;
    });
    expect(out.openStart).toBe(2);
    expect(out.openEnd).toBe(2);
  });

  for (const [name, markdown] of cases) {
    it(`${name}: after censor no attr holds the plaintext, and copy/drag do not leak it`, async () => {
      const controller = createDragCopyController();
      const editor = makeEditor(markdown, {
        editorProps: {
          ...noteClipboardProps(controller),
          handleDOMEvents: {
            dragstart: () => {
              controller.markDragStart();
              retainRealDragSlice(editor, controller);
              return false;
            },
          },
        },
      });
      const from = textPos(editor, SECRET);
      expect(await censorSelection(editor, from, from + SECRET.length, async () => TOKEN)).toBe(
        'ok',
      );
      // H1(b): every ancestor block's retained source was cleared.
      expect(docContains(editor, SECRET)).toBe(false);

      const range = firstParagraphRange(editor);
      editor.commands.setTextSelection(range);

      const copy = dispatchCopy(editor);
      const copyHtml = copy.getData('text/html');
      const copyText = copy.getData('text/plain');
      // The ancestor context is really written, so the check below is not vacuous.
      expect(copyHtml).toContain('data-pm-slice');
      expect(sliceAttr(copyHtml)).not.toContain(SECRET);
      expect(copyHtml).not.toContain(SECRET);
      expect(copyText).not.toContain(SECRET);
      expect(copyText).toContain('█████');

      const drag = await dispatchDragStart(editor);
      expect(sliceAttr(drag.getData('text/html'))).not.toContain(SECRET);
      expect(drag.getData('text/html')).not.toContain(SECRET);
      expect(drag.getData('text/plain')).not.toContain(SECRET);
      // The in-memory drag slice still has the real atom, so an internal move keeps the token.
      let draggingHasAtom = false;
      editor.view.dragging?.slice.content.descendants((node) => {
        if (node.type.name === 'censored') draggingHasAtom = true;
        return true;
      });
      expect(draggingHasAtom).toBe(true);
      // N1: exactly the slice ProseMirror handed to transformCopied is restored, with its
      // openStart/openEnd node-selection metadata, not a new read of the selection.
      expect(controller.originalSlice).not.toBeNull();
      expect(editor.view.dragging?.slice).toBe(controller.originalSlice);
      expect(controller.originalSlice!.openStart).toBeGreaterThan(0);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// H3: Remove is bound to the mapped position, and duplicates are refused
// ---------------------------------------------------------------------------------------------

describe('H3: Remove-censor cannot decrypt a different atom', () => {
  function censoredEditor(options: Partial<ConstructorParameters<typeof Editor>[0]> = {}): {
    editor: Editor;
    pos: number;
  } {
    const editor = makeEditor('x', options);
    editor.commands.insertContentAt(1, [
      { type: 'text', text: 'before ' },
      { type: 'censored', attrs: { token: TOKEN } },
      { type: 'text', text: ' after' },
    ]);
    let pos = -1;
    editor.state.doc.descendants((node, at) => {
      if (pos === -1 && node.type.name === 'censored') pos = at;
      return pos === -1;
    });
    return { editor, pos };
  }

  it('follows the atom through later transactions (mapping, not a fresh scan)', () => {
    const { editor, pos } = censoredEditor();
    const removeId = markCensoredForRemoval(editor, pos)!;
    editor.commands.insertContentAt(1, 'leading ');
    expect(removalTargets(editor.state.doc, removeId)).toHaveLength(1);
    expect(applyUncensored(editor, removeId, 'revealed')).toBe('ok');
    expect(editor.state.doc.textContent).toContain('revealed');
  });

  it('aborts when a drag-copy duplicated the removeId (0 or >1 targets)', () => {
    const { editor, pos } = censoredEditor();
    const removeId = markCensoredForRemoval(editor, pos)!;
    const node = editor.state.doc.nodeAt(pos)!;
    const before = editor.state.doc.toJSON();
    // Simulate a duplicate that somehow kept the transient id (the real paste path strips it).
    editor.view.dispatch(
      editor.state.tr.insert(editor.state.doc.content.size - 1, node.copy(node.content)),
    );
    expect(removalTargets(editor.state.doc, removeId)).toHaveLength(2);
    expect(applyUncensored(editor, removeId, 'revealed')).toBe('duplicate');
    expect(editor.state.doc.toJSON()).not.toEqual(before); // only the duplicate remains
    expect(editor.state.doc.textContent).not.toContain('revealed');
  });

  it('keeps the original authoritative when the duplicate arrives without the id', () => {
    const { editor, pos } = censoredEditor();
    const removeId = markCensoredForRemoval(editor, pos)!;
    const node = editor.state.doc.nodeAt(pos)!;
    // The production paste path strips `removeId`: emulate exactly that.
    const clean = node.type.create(
      Object.fromEntries(Object.entries(node.attrs).filter(([key]) => key !== 'removeId')),
    );
    editor.view.dispatch(
      editor.state.tr.insert(editor.state.doc.content.size - 1, clean.copy(clean.content)),
    );
    expect(removalTargets(editor.state.doc, removeId)).toHaveLength(1);
    expect(applyUncensored(editor, removeId, 'revealed')).toBe('ok');
    // Exactly one atom was replaced; the untagged copy still carries the token.
    let atoms = 0;
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'censored') atoms++;
      return true;
    });
    expect(atoms).toBe(1);
  });

  it('aborts when the tagged atom was deleted even if the token text exists elsewhere', () => {
    const { editor, pos } = censoredEditor();
    const removeId = markCensoredForRemoval(editor, pos)!;
    const node = editor.state.doc.nodeAt(pos)!;
    const tr = editor.state.tr.delete(pos, pos + node.nodeSize);
    tr.insert(tr.doc.content.size - 1, node.type.create({ token: TOKEN }));
    editor.view.dispatch(tr);
    // The tracked position was deleted; the plugin state is cleared even though an identical
    // token exists.
    expect(applyUncensored(editor, removeId, 'revealed')).toBe('missing');
    expect(editor.state.doc.textContent).not.toContain('revealed');
  });

  it('transformPasted strips removeId from an inserted slice (internal drag included)', () => {
    const { editor, pos } = censoredEditor({
      editorProps: noteClipboardProps(createDragCopyController()),
    });
    markCensoredForRemoval(editor, pos);
    editor.commands.setTextSelection({ from: pos, to: pos + 1 });
    const slice = editor.state.selection.content();
    const transformed = editor.view.someProp('transformPasted', (fn) =>
      fn(slice, editor.view, false),
    );
    const out = transformed ?? slice;
    let hasRemoveId = false;
    out.content.descendants((node) => {
      if (node.attrs.removeId != null) hasRemoveId = true;
      return true;
    });
    expect(hasRemoveId).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// H4: preserved boundaries never change structure
// ---------------------------------------------------------------------------------------------

describe('H4: serialized Markdown re-parses to the editor document', () => {
  function materialise(doc: JSONContent): JSONContent {
    return schema.nodeFromJSON(doc).toJSON() as JSONContent;
  }

  function expectRoundTrip(doc: JSONContent): string {
    const verified = verifyDocMarkdown(doc);
    expect(docsEquivalent(markdownToDoc(verified.markdown), doc)).toBe(true);
    return verified.markdown;
  }

  it('a table followed by a paragraph keeps a blank line after an edit', () => {
    const doc = materialise(markdownToDoc('| A |\n|---|\n\n# heading'));
    doc.content![1] = { type: 'paragraph', content: [{ type: 'text', text: 'heading' }] };
    const saved = expectRoundTrip(materialise(doc));
    expect(saved).toContain('| A |\n|---|\n\nheading');
  });

  it('editing one of two adjacent lists does not merge them', () => {
    const doc = materialise(markdownToDoc('- one\n+ two'));
    expect(doc.content).toHaveLength(2);
    const second = doc.content![1]!;
    second.content![0]!.content![0]!.content = [{ type: 'text', text: 'two edited' }];
    const saved = expectRoundTrip(materialise(doc));
    expect(saved).toMatch(/- one\n\n\* two edited/);
  });

  it('fresh serialisation alternates markers for adjacent lists of one family', () => {
    const bullet = materialise(
      markdownToDoc('- a\n+ b\n\n1. one\n1) two\n\n- [ ] todo\n\n* [x] done'),
    );
    // Deliberately strip preservation so the fresh serializer runs.
    for (const block of bullet.content ?? []) delete block.attrs?.src;
    const out = contentToMarkdown(bullet.content ?? null);
    expect(out).toContain('- a');
    expect(out).toContain('* b');
    expect(out).toContain('1. one');
    expect(out).toContain('1) two');
    expect(out).toContain('- [ ] todo');
    expect(out).toContain('* [x] done');
    expect(docsEquivalent(markdownToDoc(out), materialise(bullet))).toBe(true);
  });

  it('a reference definition survives when a neighbouring block is edited', () => {
    const doc = materialise(markdownToDoc('first\n\n[r]: https://example.com\n\n[link][r]'));
    doc.content![0]!.content = [{ type: 'text', text: 'first edited' }];
    const out = expectRoundTrip(materialise(doc));
    expect(out).toContain('[r]: https://example.com');
    expect(
      (markdownToDoc(out).content ?? []).some((block) =>
        (block.content ?? []).some((n) => (n.marks ?? []).some((m) => m.type === 'link')),
      ),
    ).toBe(true);
  });

  it('random edits on a mixed corpus always round-trip', () => {
    const corpus = [
      '# Title',
      'intro paragraph',
      'second *italic* paragraph',
      '- one\n- two',
      '+ three',
      '1. first\n2. second',
      '> quote\n> lazy\ncontinuation',
      'Setext heading\n==============',
      '| a | b |\n| --- | --- |\n| c | d |',
      '```js\nconst x = 1;\n```',
      'Reference [link][r] here.',
      '[r]: https://example.com',
      'Final paragraph.',
    ].join('\n\n');

    let seed = 0x5eed1234;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    resetSerializationStats();
    for (let round = 0; round < 40; round++) {
      let doc = materialise(markdownToDoc(corpus));
      const edits = 1 + rand(4);
      for (let e = 0; e < edits; e++) {
        const blocks = doc.content!;
        const kind = rand(5);
        if (kind === 0) {
          const at = rand(blocks.length);
          const block = blocks[at]!;
          if (block.type === 'heading') {
            blocks[at] = { type: 'paragraph', content: block.content ?? [] };
          } else if (block.type === 'paragraph') {
            blocks[at] = {
              type: 'heading',
              attrs: { level: 1 + rand(3) },
              content: block.content ?? [],
            };
          }
        } else if (kind === 1) {
          const at = rand(blocks.length);
          if (blocks[at]!.type === 'bulletList') {
            blocks[at] = {
              type: 'orderedList',
              attrs: { start: 1 },
              content: blocks[at]!.content ?? [],
            };
          } else if (blocks[at]!.type === 'orderedList') {
            blocks[at] = { type: 'bulletList', content: blocks[at]!.content ?? [] };
          }
        } else if (kind === 2) {
          const tables = blocks
            .map((block, index) => (block.type === 'table' ? index : -1))
            .filter((index) => index >= 0);
          if (tables.length && rand(2) === 0) blocks.splice(tables[rand(tables.length)]!, 1);
          else
            blocks.splice(rand(blocks.length + 1), 0, {
              type: 'table',
              content: [
                {
                  type: 'tableRow',
                  content: [
                    {
                      type: 'tableHeader',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'h' }] }],
                    },
                  ],
                },
                {
                  type: 'tableRow',
                  content: [
                    {
                      type: 'tableCell',
                      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'c' }] }],
                    },
                  ],
                },
              ],
            });
        } else if (kind === 3 && blocks.length > 1) {
          const at = rand(blocks.length - 1);
          const first = blocks[at]!;
          const second = blocks[at + 1]!;
          if (
            (first.type === 'paragraph' || first.type === 'heading') &&
            (second.type === 'paragraph' || second.type === 'heading')
          ) {
            first.content = [
              ...(first.content ?? []),
              { type: 'text', text: ' merged ' },
              ...(second.content ?? []),
            ];
            blocks.splice(at + 1, 1);
          }
        } else {
          blocks.splice(rand(blocks.length + 1), 0, {
            type: 'paragraph',
            content: [{ type: 'text', text: `new ${round}-${e}` }],
          });
        }
        doc = materialise(doc);
      }
      const saved = verifyDocMarkdown(doc);
      if (!docsEquivalent(markdownToDoc(saved.markdown), doc)) {
        throw new Error(
          `round ${round} mismatch:\n--- saved ---\n${saved.markdown}\n--- doc ---\n${JSON.stringify(doc)}`,
        );
      }
    }
    expect(serializationStats.mismatch).toBe(0);
  });

  it('verifies a 512 KiB note in under 500 ms (happy-dom/node)', () => {
    const filler = (words: number) =>
      Array.from({ length: words }, (_, k) => `word${k % 37}`).join(' ');
    const blocks: string[] = [];
    let size = 0;
    for (let i = 0; size < 512 * 1024; i++) {
      const block =
        i % 4 === 0
          ? `Paragraph ${i} ${filler(60)} **bold**, *italic*, a [link](https://example.com/${i}).`
          : i % 4 === 1
            ? Array.from({ length: 4 }, (_, k) => `- item ${i}-${k} ${filler(14)}`).join('\n')
            : i % 4 === 2
              ? `| a${i} | b${i} |\n| --- | --- |\n| ${filler(20)} | d${i} |`
              : `> quote ${i} ${filler(60)}`;
      blocks.push(block);
      size += block.length + 2;
    }
    const markdown = blocks.join('\n\n');
    const doc = markdownToDoc(markdown);
    const first = docToMarkdown(doc); // the keystroke path already produced this
    const started = performance.now();
    const verified = verifyDocMarkdown(doc, first);
    const elapsed = performance.now() - started;
    expect(markdown.length).toBeGreaterThanOrEqual(512 * 1024);
    expect(verified.mismatch).toBe(false);
    expect(elapsed).toBeLessThan(500);
    console.log(
      `512 KiB verify: ${elapsed.toFixed(1)} ms (${markdown.length} bytes, ${doc.content?.length} blocks)`,
    );
  });
});

// ---------------------------------------------------------------------------------------------
// M1: the censor/hard-break/embed rules live in markdown-it (no sentinel substitution)
// ---------------------------------------------------------------------------------------------

describe('M1: markdown-it inline/block rules parse custom syntax in context', () => {
  function censoredNodes(doc: JSONContent): JSONContent[] {
    const out: JSONContent[] = [];
    const walk = (node: JSONContent) => {
      if (node.type === 'censored') out.push(node);
      for (const child of node.content ?? []) walk(child);
    };
    walk(doc);
    return out;
  }

  it('a token in a link title stays literal attr text', () => {
    const doc = markdownToDoc(`[x](https://example.com/ "${TOKEN}")`);
    expect(censoredNodes(doc)).toHaveLength(0);
    const mark = doc.content![0]!.content![0]!.marks!.find((m) => m.type === 'link')!;
    expect(mark.attrs!.title).toBe(TOKEN);
  });

  it('a token in a link URL stays in the href, never becomes an atom', () => {
    const doc = markdownToDoc(`[x](https://example.com/${TOKEN})`);
    expect(censoredNodes(doc)).toHaveLength(0);
    const mark = doc.content![0]!.content![0]!.marks!.find((m) => m.type === 'link')!;
    expect(String(mark.attrs!.href)).toContain('%7B%7Bcensored');
    expect(docToMarkdown(doc)).toBe(`[x](https://example.com/${TOKEN})`);
  });

  it('a reference link resolves and the following token becomes an atom', () => {
    const doc = markdownToDoc(`[link][r] ${TOKEN}\n\n[r]: https://example.com`);
    const paragraph = doc.content![0]!;
    expect(paragraph.content![0]!.marks!.some((m) => m.type === 'link')).toBe(true);
    expect(censoredNodes(doc)).toHaveLength(1);
  });

  it('escapes and code spans never become atoms', () => {
    expect(
      censoredNodes(
        markdownToDoc(
          `\\{\\{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA\\}\\}`,
        ),
      ),
    ).toHaveLength(0);
    expect(censoredNodes(markdownToDoc(`\`${TOKEN}\``))).toHaveLength(0);
  });

  it('a backtick, Enter and <br> in a cell round-trip as a hard break', () => {
    const md = '| a`x`<br>b | c |\n| --- | --- |\n| d | e |';
    const doc = markdownToDoc(md);
    const inline = doc.content![0]!.content![0]!.content![0]!.content![0]!.content!;
    expect(inline.map((n) => n.type)).toEqual(['text', 'text', 'hardBreak', 'text']);
    expect(docToMarkdown(doc)).toBe(md);
    const canonical = contentToMarkdown(doc.content ?? null);
    expect(docsEquivalent(markdownToDoc(canonical), doc)).toBe(true);
  });

  it('literal <br> outside a table cell stays text', () => {
    const md = 'a<br>b';
    const doc = markdownToDoc(md);
    expect(doc.content![0]!.content!.map((n) => n.type)).toEqual(['text']);
    expect(doc.content![0]!.content![0]!.text).toBe('a<br>b');
  });
});
