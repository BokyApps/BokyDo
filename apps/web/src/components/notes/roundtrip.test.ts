// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { contentToMarkdown, docToMarkdown, markdownToDoc } from './markdown.js';
import { buildExtensions, parseForEditor } from './NoteEditor.js';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const VALID = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';

/** Every finding-#4 case plus the surrounding constructs (ADR 0025). */
export const CORPUS: [string, string][] = [
  ['headings 1-6', '# H1\n\n## H2\n\n### H3\n\n#### H4\n\n##### H5\n\n###### H6'],
  ['mixed bold + italic', '**bold** and *italic* and ~~strike~~ and ***both***'],
  ['nested bold/italic', '**bold with *nested italic* inside**'],
  ['inline code + backtick runs', 'a `code` span and `` a `tick` here ``'],
  ['code block', '```js\nconst x = 1;\n```'],
  ['code containing ```', '````\ncode with ``` fence\n````'],
  ['blockquote', '> a quote\n> second line'],
  ['bullet list', '- one\n- two'],
  ['ordered list', '1. one\n2. two'],
  ['task list', '- [ ] todo\n- [x] done'],
  ['nested list', '- one\n  - nested\n    - deeper'],
  ['loose list paragraphs', '- first para\n\n  second para\n\n- second item'],
  ['horizontal rule', '---'],
  ['hard break', 'line one\\\nline two'],
  ['table', '| a | b |\n| --- | --- |\n| c | d |'],
  ['table alignment', '| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |'],
  ['table cell `a\\|b`', '| x | `a\\|b` |\n| --- | --- |\n| 1 | 2 |'],
  ['link title', '[link](https://example.com/ "A Title")'],
  ['mailto link', '[mail](mailto:a@b.com)'],
  ['note image', `![alt text](/api/v1/note-files/${UUID})`],
  ['file chip', `[report.pdf](/api/v1/note-files/${UUID})`],
  ['internal note link', `[a note](bokydo:note/${UUID})`],
  ['valid embed', '::embed[My video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)'],
  ['censored token', `before ${VALID} after`],
  ['soft break', 'soft\nbreak inside a paragraph'],
  [
    'escaped censor syntax',
    '\\{\\{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA\\}\\}',
  ],
  ['literal ::embed stays literal', '\\::embed[x](https://youtu.be/dQw4w9WgXcQ)'],
  ['literal ::embed + formatted link', '\\::embed[**bold**](https://example.com/)'],
  ['plain-text escapes', 'a & b <tag> #5 * ~ | [bracket] back\\slash {brace}'],
];

/** Remove the source-preservation bookkeeping so two equivalent docs can be compared by content. */
function stripSource(node: JSONContent): JSONContent {
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
    copy.attrs = Object.keys(rest).length ? rest : undefined;
    if (!copy.attrs) delete copy.attrs;
  }
  if (copy.content) copy.content = copy.content.map(stripSource);
  return copy;
}

describe('HIGH: valid Markdown opens blank (empty text nodes / embed fallback)', () => {
  const blankCases = [
    'paragraph one\n\n- [ ]\n\nparagraph three',
    '- [ ]\n\n- [x] done',
    '::embed[](https://vimeo.com/123)',
    'before\n\n- [ ]\n\nafter',
  ];
  for (const md of blankCases) {
    it(`loads ${JSON.stringify(md)} into a valid, non-blank doc`, () => {
      const parsed = parseForEditor(md);
      expect(parsed.valid).toBe(true);
      expect((parsed.doc.content ?? []).length).toBeGreaterThan(0);
      const hasEmptyText = (nodes: JSONContent[] | undefined): boolean =>
        (nodes ?? []).some(
          (n) => (n.type === 'text' && (n.text ?? '') === '') || hasEmptyText(n.content),
        );
      expect(hasEmptyText(parsed.doc.content)).toBe(false);
      expect(docToMarkdown(parsed.doc)).toBe(md);
      // An empty-label, non-allow-listed embed falls back to the URL as its link label.
      if (md.startsWith('::embed[]')) {
        const text = (parsed.doc.content ?? [])
          .flatMap((b) => b.content ?? [])
          .map((n) => n.text ?? '')
          .join('');
        expect(text).toContain('https://vimeo.com/123');
      }
    });
  }
});

describe('HIGH: unchanged docs serialize byte-identically', () => {
  for (const [name, md] of CORPUS) {
    it(`${name}: docToMarkdown(markdownToDoc(md)) === md`, () => {
      expect(docToMarkdown(markdownToDoc(md))).toBe(md);
    });
  }

  it('still byte-identical after a real TipTap editor round trip (getJSON)', () => {
    for (const [, md] of CORPUS) {
      const el = document.createElement('div');
      document.body.appendChild(el);
      const editor = new Editor({
        element: el,
        extensions: buildExtensions(),
        content: markdownToDoc(md),
      });
      expect(docToMarkdown(editor.getJSON())).toBe(md);
      editor.destroy();
      el.remove();
    }
  });
});

describe('serializer bugs found by the final review', () => {
  it('a literal ! immediately before a link is escaped, not read back as an image', () => {
    const literal = docToMarkdown({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: '![Read](https://example.com/)' }],
        },
      ],
    });
    expect(literal.startsWith('\\!\\[')).toBe(true);
    expect(markdownToDoc(literal).content?.[0]?.content?.[0]?.text).toBe(
      '![Read](https://example.com/)',
    );

    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: '!' },
            {
              type: 'text',
              text: 'Read',
              marks: [{ type: 'link', attrs: { href: 'https://example.com/' } }],
            },
          ],
        },
      ],
    };
    const markdown = docToMarkdown(doc);
    expect(markdown).toBe('\\![Read](https://example.com/)');
    const reparsed = markdownToDoc(markdown);
    const paragraph = reparsed.content?.[0];
    expect(paragraph?.content?.[0]).toMatchObject({ type: 'text', text: '!' });
    expect(paragraph?.content?.[1]).toMatchObject({
      type: 'text',
      text: 'Read',
      marks: [{ type: 'link', attrs: { href: 'https://example.com/' } }],
    });
  });

  it('a fresh serialisation preserves leading and trailing blank lines in a fenced code block', () => {
    const cases = ['```\n\nfoo\n```', '```\nfoo\n\n```', '```\n\nfoo\n\n```', '```\nfoo\n\n\n```'];
    for (const markdown of cases) {
      const parsed = markdownToDoc(markdown);
      // contentToMarkdown has no source preservation: this is the fallback serialisation.
      const fresh = contentToMarkdown(parsed.content ?? null);
      expect(fresh).toBe(markdown);
      expect(stripSource(markdownToDoc(fresh))).toEqual(stripSource(parsed));
    }
  });
});

describe('HIGH: a small edit elsewhere leaves every other block byte-identical', () => {
  it('editing one paragraph does not rewrite the heading or the table around it', () => {
    const heading = '# Title';
    const para = 'A **bold** paragraph.';
    const table = '| a | b |\n| :--- | ---: |\n| c | d |';
    const md = `${heading}\n\n${para}\n\n${table}`;
    const doc = markdownToDoc(md);
    // Simulate a small edit in the middle block only.
    const middle = doc.content![1]!;
    const textNode = middle.content!.find((n) => n.type === 'text' && n.text === 'bold')!;
    textNode.text = 'bolder';
    const out = docToMarkdown(doc);
    expect(out).toContain(heading);
    expect(out).toContain(table); // byte-identical (alignment separators preserved)
    expect(out).toContain('**bolder**');
    expect(out).not.toContain(para);
  });

  it('an edit in one block cannot discard a sibling code/table/embed', () => {
    const blocks = [
      '````\ncode with ``` fence\n````',
      '| x | `a\\|b` |\n| --- | --- |\n| 1 | 2 |',
      '::embed[My video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)',
      'plain paragraph to edit',
    ];
    const md = blocks.join('\n\n');
    const doc = markdownToDoc(md);
    doc.content![3]!.content![0]!.text = 'edited paragraph';
    const out = docToMarkdown(doc);
    expect(out).toContain(blocks[0]!);
    expect(out).toContain(blocks[1]!);
    expect(out).toContain(blocks[2]!);
    expect(out).toContain('edited paragraph');
  });
});

describe('spec: parse → serialize → parse yields equal JSON (serializer equivalence)', () => {
  for (const [name, md] of CORPUS) {
    it(`equivalent JSON for ${name}`, () => {
      const original = stripSource(markdownToDoc(md));
      // contentToMarkdown serializes from content only (no source preservation), so this genuinely
      // exercises the serializer (fences, table pipes, alignment, titles, soft breaks, nesting).
      const canonical = contentToMarkdown(markdownToDoc(md).content ?? null);
      const reparsed = stripSource(markdownToDoc(canonical));
      expect(reparsed).toEqual(original);
    });
  }
});
