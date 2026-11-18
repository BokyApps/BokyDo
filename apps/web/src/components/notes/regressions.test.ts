// @vitest-environment happy-dom
import { Editor, type JSONContent } from '@tiptap/core';
import { undo } from '@tiptap/pm/history';
import { describe, expect, it } from 'vitest';
import { createDragCopyController } from './clipboard.js';
import { formatEmbedLine, parseEmbedLine } from './embed.js';
import {
  CENSORED_PLACEHOLDER,
  blockPreservesSource,
  contentToMarkdown,
  docToMarkdown,
  markdownToDoc,
  normaliseLineEndings,
  planSourceRanges,
} from './markdown.js';
import {
  buildExtensions,
  closeHistoryBeforeSourceApply,
  retainRealDragSlice,
} from './NoteEditor.js';
import { insertHardBreakInCell } from './table.js';

const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';
const URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

/** Remove every bookkeeping attribute so two equivalent documents compare by content. */
function strip(node: JSONContent): JSONContent {
  const copy: JSONContent = { ...node };
  if (copy.attrs) {
    const { src, sep, lead, blockId, prevId, nextId, removeId, ...rest } = copy.attrs as Record<
      string,
      unknown
    >;
    void src;
    void sep;
    void lead;
    void blockId;
    void prevId;
    void nextId;
    void removeId;
    // ProseMirror materialises defaults (null/'' attributes, table spans) that Markdown cannot
    // carry; they are not content, so the comparison ignores them.
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (value === null || value === undefined || value === '') continue;
      if ((key === 'colspan' || key === 'rowspan') && value === 1) continue;
      kept[key] = value;
    }
    copy.attrs = Object.keys(kept).length ? kept : undefined;
    if (!copy.attrs) delete copy.attrs;
  }
  if (copy.content) copy.content = copy.content.map(strip);
  return copy;
}

function makeEditor(markdown: string): Editor {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return new Editor({
    element: el,
    extensions: buildExtensions(),
    content: markdownToDoc(markdown),
  });
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe('E1: line endings are normalised before parsing and slicing', () => {
  it('normalises CRLF and lone CR to LF', () => {
    expect(normaliseLineEndings('a\r\nb\rc\n')).toBe('a\nb\nc\n');
  });

  for (const [name, body] of [
    ['CRLF', `alpha\r\n\r\n${TOKEN}\r\n\r\nbeta`],
    ['CR-only', `alpha\r\r${TOKEN}\r\rbeta`],
  ] as const) {
    it(`${name}: keeps the token exactly once and emits LF-only Markdown`, () => {
      const saved = docToMarkdown(markdownToDoc(body));
      expect(saved).toBe(`alpha\n\n${TOKEN}\n\nbeta`);
      expect(saved).not.toContain('\r');
      expect(count(saved, TOKEN)).toBe(1);
      expect(count(saved, 'alpha')).toBe(1);
      expect(count(saved, 'beta')).toBe(1);
      // Never a duplicated block or a placeholder in place of the ciphertext.
      expect(saved).not.toContain('█████');
    });
  }

  it('a CR-only body with a token re-parses to exactly one censored atom', () => {
    const doc = markdownToDoc(`before\r${TOKEN}\rafter`);
    const atoms = (doc.content ?? []).flatMap((block) =>
      (block.content ?? []).filter((node) => node.type === 'censored'),
    );
    expect(atoms).toHaveLength(1);
    expect(atoms[0]?.attrs?.token).toBe(TOKEN);
  });

  it('drops preservation for the whole document when source ranges overlap', () => {
    expect(
      planSourceRanges(
        [
          [0, 1],
          [0, 1],
        ],
        'a\nb',
      ),
    ).toBeNull();
    expect(planSourceRanges([[0, 0]], 'a')).toBeNull();
    expect(planSourceRanges([[5, 6]], 'a')).toBeNull();
    const fine = planSourceRanges(
      [
        [0, 1],
        [2, 3],
      ],
      'a\n\nb',
    );
    expect(fine?.[0]).toEqual({ src: 'a', sep: '\n\n', lead: '' });
    expect(fine?.[1]).toEqual({ src: 'b', sep: '' });
  });
});

describe('E2(a): exact JSON equality decides whether source is reused', () => {
  it('a freshly parsed block matches its own source', () => {
    const doc = markdownToDoc('# Title\n\n| a |\n| --- |\n| b |');
    for (const block of doc.content ?? []) expect(blockPreservesSource(block)).toBe(true);
  });

  it('a meaningful attribute change makes the block changed (not lost behind a hash)', () => {
    const doc = markdownToDoc('## Heading');
    const heading = doc.content![0]!;
    heading.attrs = { ...heading.attrs, level: 3 };
    expect(blockPreservesSource(heading)).toBe(false);
  });

  it('bookkeeping attributes are ignored by the comparison', () => {
    const doc = markdownToDoc('paragraph');
    const block = doc.content![0]!;
    block.attrs = { ...block.attrs, sep: '\n\n\n', lead: '  ', blockId: 'other' };
    expect(blockPreservesSource(block)).toBe(true);
  });

  it('a table cell alignment edit is detected even though the serialiser ignores it', () => {
    const doc = markdownToDoc('| a |\n| --- |\n| b |');
    const table = doc.content![0]!;
    const row = table.content![1]!;
    const cell = row.content![0]!;
    cell.attrs = { ...cell.attrs, align: 'right' };
    expect(blockPreservesSource(table)).toBe(false);
  });
});

describe('E2(b): separators follow the same neighbours (blocks never merge)', () => {
  it('Enter at the end of the first paragraph then typing gives two paragraphs', () => {
    const editor = makeEditor('first');
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    editor.commands.splitBlock();
    editor.commands.insertContent('second');
    expect(docToMarkdown(editor.getJSON())).toBe('first\n\nsecond');
    editor.destroy();
  });

  it('a paragraph appended after a preserved last block is separated', () => {
    const doc = markdownToDoc('a\n\nb');
    doc.content!.push({ type: 'paragraph', content: [{ type: 'text', text: 'c' }] });
    expect(docToMarkdown(doc)).toBe('a\n\nb\n\nc');
  });

  it('a paragraph inserted before the original first block does not reuse its lead', () => {
    const doc = markdownToDoc('\n\nfirst');
    doc.content!.unshift({ type: 'paragraph', content: [{ type: 'text', text: 'zero' }] });
    expect(docToMarkdown(doc)).toBe('zero\n\nfirst');
  });

  it('removing a block between two preserved blocks keeps them apart', () => {
    const doc = markdownToDoc('a\n\nb\n\nc');
    doc.content!.splice(1, 1);
    expect(docToMarkdown(doc)).toBe('a\n\nc');
  });
});

describe('E2: random insert/delete/edit keeps parse(save) equal to the editor JSON', () => {
  const base = [
    '# Title',
    'first paragraph',
    'second *italic* paragraph',
    '- one\n- two',
    '> quote',
    '```js\nconst x = 1;\n```',
    '| a | b |\n| --- | --- |\n| c | d |',
    `before ${TOKEN} after`,
  ];

  it('holds over a seeded sequence of edits', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 0x1234abcd;
    const rand = (n: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    for (let round = 0; round < 30; round++) {
      const doc = markdownToDoc(base.join('\n\n'));
      const edits = 1 + rand(4);
      for (let e = 0; e < edits; e++) {
        const blocks = doc.content!;
        const kind = rand(3);
        if (kind === 0) {
          blocks.splice(rand(blocks.length + 1), 0, {
            type: 'paragraph',
            content: [{ type: 'text', text: `new ${round}-${e}` }],
          });
        } else if (kind === 1 && blocks.length > 1) {
          blocks.splice(rand(blocks.length), 1);
        } else {
          const block = blocks[rand(blocks.length)]!;
          if (block.type === 'paragraph' || block.type === 'heading') {
            block.content = [{ type: 'text', text: `edited ${round}-${e}` }];
          }
        }
      }
      const saved = docToMarkdown(doc);
      expect(strip(markdownToDoc(saved))).toEqual(strip(doc));
    }
  });
});

describe('E2(c): a table cell is exactly one paragraph; Enter inserts a hard break', () => {
  it('parses and re-serialises a <br> inside a cell', () => {
    const md = '| a<br>b | c |\n| --- | --- |\n| d | e |';
    const doc = markdownToDoc(md);
    const header = doc.content![0]!.content![0]!.content![0]!;
    expect(header.content?.[0]?.type).toBe('paragraph');
    expect(header.content?.[0]?.content?.map((n) => n.type)).toEqual(['text', 'hardBreak', 'text']);
    expect(docToMarkdown(doc)).toBe(md);
  });

  it('keeps emphasis open across a cell hard break', () => {
    const md = '| **a<br>b** |\n| --- |\n| c |';
    const cell = markdownToDoc(md).content![0]!.content![0]!.content![0]!;
    const inline = cell.content?.[0]?.content ?? [];
    expect(inline.map((node) => node.type)).toEqual(['text', 'hardBreak', 'text']);
    expect(inline.every((node) => (node.marks ?? []).some((m) => m.type === 'bold'))).toBe(true);
    const canonical = contentToMarkdown(markdownToDoc(md).content ?? null);
    expect(strip(markdownToDoc(canonical))).toEqual(strip(markdownToDoc(md)));
  });

  it('keeps a literal escaped <br> as text', () => {
    const md = '| a\\<br\\>b |\n| --- |\n| c |';
    const cell = markdownToDoc(md).content![0]!.content![0]!.content![0]!;
    expect(cell.content?.[0]?.content?.map((n) => n.type)).toEqual(['text']);
    expect(docToMarkdown(markdownToDoc(md))).toBe(md);
    const canonical = contentToMarkdown(markdownToDoc(md).content ?? null);
    expect(canonical).toContain('\\<br\\>');
  });

  it('Enter inside a cell inserts a hard break, and the saved cell keeps it', () => {
    const editor = makeEditor('| a |\n| --- |\n| b |');
    let cellPos = -1;
    let text = '';
    editor.state.doc.descendants((node, pos) => {
      if (cellPos === -1 && node.type.name === 'tableHeader') {
        cellPos = pos + 2; // inside the cell's paragraph
        text = node.textContent;
      }
      return cellPos === -1;
    });
    expect(cellPos).toBeGreaterThan(0);
    editor.commands.setTextSelection(cellPos + text.length);
    expect(insertHardBreakInCell(editor)).toBe(true);
    const saved = docToMarkdown(editor.getJSON());
    expect(saved).toContain('<br>');
    expect(strip(markdownToDoc(saved))).toEqual(strip(editor.getJSON()));
    editor.destroy();
  });

  it('the Enter key binding itself inserts a hard break in a cell', () => {
    const editor = makeEditor('| a |\n| --- |\n| b |');
    let cellPos = -1;
    let text = '';
    editor.state.doc.descendants((node, pos) => {
      if (cellPos === -1 && node.type.name === 'tableHeader') {
        cellPos = pos + 2;
        text = node.textContent;
      }
      return cellPos === -1;
    });
    editor.commands.setTextSelection(cellPos + text.length);
    editor.view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
    );
    expect(docToMarkdown(editor.getJSON())).toContain('<br>');
    editor.destroy();
  });

  it('the schema rejects a second paragraph inside a cell', () => {
    const editor = makeEditor('| a |\n| --- |\n| b |');
    const json = editor.getJSON() as unknown as JSONContent;
    const cell = json.content![0]!.content![0]!.content![0]!;
    cell.content = [
      { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
    ];
    expect(() => editor.schema.nodeFromJSON(json).check()).toThrow();
    editor.destroy();
  });
});

describe('E4: custom syntax is recognised from raw source with escape parity', () => {
  const atoms = (doc: JSONContent): JSONContent[] =>
    (doc.content ?? []).flatMap((block) =>
      (block.content ?? []).filter((n) => n.type === 'censored'),
    );

  it('an escaped token is literal even when the same unescaped token is in the paragraph', () => {
    const body = `\\${TOKEN} and ${TOKEN}`;
    const doc = markdownToDoc(body);
    expect(atoms(doc)).toHaveLength(1);
    expect(atoms(doc)[0]?.attrs?.token).toBe(TOKEN);
    // The literal occurrence stays text (with the escapes removed by Markdown).
    const text = (doc.content ?? [])
      .flatMap((block) => block.content ?? [])
      .map((n) => n.text ?? '')
      .join('');
    expect(text).toContain(TOKEN);
    // Saving keeps it one atom and one literal, and re-parsing is identical.
    const saved = docToMarkdown(doc);
    expect(count(saved, '{{censored:')).toBe(2);
    expect(atoms(markdownToDoc(saved))).toHaveLength(1);
  });

  it('a double backslash before the token makes it active', () => {
    const doc = markdownToDoc(`\\\\${TOKEN}`);
    expect(atoms(doc)).toHaveLength(1);
    expect(docToMarkdown(doc)).toBe(`\\\\${TOKEN}`);
  });

  it('three backslashes leave it literal again', () => {
    expect(atoms(markdownToDoc(`\\\\\\${TOKEN}`))).toHaveLength(0);
  });

  it('a token inside an inline code span stays literal text', () => {
    const doc = markdownToDoc(`\`${TOKEN}\``);
    expect(atoms(doc)).toHaveLength(0);
    expect(contentToMarkdown(doc.content ?? null)).toContain(TOKEN);
  });

  it('an escaped ::embed line stays a paragraph', () => {
    const doc = markdownToDoc(`\\::embed[x](${URL})`);
    expect(doc.content?.[0]?.type).toBe('paragraph');
    expect(atoms(doc)).toHaveLength(0);
  });
});

describe('E5: hostile embed labels survive the Markdown round trip', () => {
  for (const label of ['a]b', 'a[b', 'a\\b', 'x](https://evil.example)', '']) {
    it(`round-trips ${JSON.stringify(label)} through the editor JSON`, () => {
      const editor = makeEditor('hello');
      editor.commands.insertContent({
        type: 'embed',
        attrs: { label, url: URL },
      });
      const saved = docToMarkdown(editor.getJSON());
      const embed = markdownToDoc(saved).content?.find((block) => block.type === 'embed');
      expect(embed?.attrs?.label).toBe(label);
      expect(embed?.attrs?.url).toBe(URL);
      expect(parseEmbedLine(formatEmbedLine(label, URL))).toEqual({ label, url: URL });
      editor.destroy();
    });
  }
});

describe('E5: dragstart writes only the placeholder into the DataTransfer', () => {
  it('text/html and text/plain never contain the token', async () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const editor: Editor = new Editor({
      element: el,
      extensions: buildExtensions(),
      content: markdownToDoc(`before ${TOKEN} after`),
      editorProps: {
        transformCopied: (slice, view) =>
          createDragCopyController().transformCopied(slice, view.state.schema),
        handleDOMEvents: {
          dragstart: () => {
            retainRealDragSlice(editor);
            return false;
          },
        },
      },
    });
    let atomPos = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'censored') {
        atomPos = pos;
        return false;
      }
      return true;
    });
    expect(atomPos).toBeGreaterThan(0);
    editor.commands.setTextSelection({ from: atomPos, to: atomPos + 1 });

    const store = new Map<string, string>();
    const dataTransfer = {
      files: [] as File[],
      effectAllowed: 'uninitialized',
      clearData: () => store.clear(),
      setData: (type: string, value: string) => store.set(type, value),
      getData: (type: string) => store.get(type) ?? '',
    };
    const event = new Event('dragstart', { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      dataTransfer: { value: dataTransfer },
      clientX: { value: 0 },
      clientY: { value: 0 },
    });
    editor.view.dom.dispatchEvent(event);
    // The in-memory drag slice is restored to the real atom in a microtask (the DataTransfer was
    // already written with the placeholder synchronously).
    await Promise.resolve();

    const html = store.get('text/html') ?? '';
    const text = store.get('text/plain') ?? '';
    expect(html).toContain(CENSORED_PLACEHOLDER);
    expect(html).not.toContain(TOKEN);
    expect(text).not.toContain(TOKEN);
    // The in-editor drag slice still holds the real atom, so an internal drop keeps the token.
    let draggingHasAtom = false;
    editor.view.dragging?.slice.content.descendants((node) => {
      if (node.type.name === 'censored') draggingHasAtom = true;
      return true;
    });
    expect(draggingHasAtom).toBe(true);
    editor.destroy();
  });
});

describe('E7: source-view edits are their own undo step', () => {
  it('closing history before applying keeps the previous typed text out of the undo', () => {
    const editor = makeEditor('start');
    editor.commands.setTextSelection(6);
    editor.commands.insertContent(' typed'); // first history group
    const beforeSourceEdit = editor.state.doc.textContent;
    closeHistoryBeforeSourceApply(editor);
    editor.commands.setContent(markdownToDoc('replacement'), { emitUpdate: false });
    undo(editor.state, editor.view.dispatch);
    expect(editor.state.doc.textContent).toBe(beforeSourceEdit);
    editor.destroy();
  });
});
