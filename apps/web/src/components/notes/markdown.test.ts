// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  CENSORED_PLACEHOLDER,
  classifyHref,
  contentToMarkdown,
  docToMarkdown,
  markdownToDoc,
  markdownToInline,
} from './markdown.js';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const rt = (md: string) => docToMarkdown(markdownToDoc(md));
const stable = (md: string) => expect(rt(rt(md))).toBe(rt(md));

describe('markdown round-trip (canonical forms are identical)', () => {
  const cases: [string, string][] = [
    ['headings 1-3', '# H1\n\n## H2\n\n### H3'],
    ['bold / italic / strike', '**bold** and *italic* and ~~strike~~'],
    ['inline code', 'a `code` span'],
    ['code block', '```js\nconst x = 1;\n```'],
    ['blockquote', '> a quote'],
    ['bullet list', '- one\n- two'],
    ['ordered list', '1. one\n2. two'],
    ['task list', '- [ ] todo\n- [x] done'],
    ['nested list', '- one\n  - nested\n    - deeper'],
    ['horizontal rule', '---'],
    ['hard break', 'line one\\\nline two'],
    ['table', '| a | b |\n| --- | --- |\n| c | d |'],
    ['safe http link', `[link](https://example.com/)`],
    ['mailto link', '[mail](mailto:a@b.com)'],
    ['note image', `![alt text](/api/v1/note-files/${UUID})`],
    ['file chip', `[report.pdf](/api/v1/note-files/${UUID})`],
    ['note link', `[a note](bokydo:note/${UUID})`],
    ['task link', `[a task](bokydo:task/${UUID})`],
    ['valid youtube embed', '::embed[My video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)'],
    ['valid drive embed', `::embed[Drive](https://drive.google.com/file/d/1AbCdEfGhIjKlMn/view)`],
    ['censored token', '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB:cccccccccccc}}'],
  ];

  for (const [name, md] of cases) {
    it(`round-trips ${name} exactly`, () => {
      expect(rt(md)).toBe(md);
    });
  }

  it('is idempotent (normalised Markdown re-parses to itself)', () => {
    const samples = [
      '# H1\n\n## H2\n\n### H3',
      '**bold** and *italic* and ~~strike~~',
      '- one\n  - nested\n    - deeper',
      '| a | b |\n| --- | --- |\n| c | d |',
      `[link](https://example.com/)`,
      `![alt](/api/v1/note-files/${UUID})`,
      '::embed[My video](https://www.youtube.com/watch?v=dQw4w9WgXcQ)',
      '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB:cccccccccccc}}',
    ];
    for (const md of samples) stable(md);
  });

  it('clamps heading levels 4-6 to 3 on input', () => {
    expect(rt('#### four\n\n##### five\n\n###### six')).toBe('### four\n\n### five\n\n### six');
  });

  it('normalises link destinations through safeHref', () => {
    expect(rt('[x](https://example.com)')).toBe('[x](https://example.com/)');
  });
});

describe('markdown parsing produces the expected node shapes', () => {
  it('creates a taskList with checked flags', () => {
    const doc = markdownToDoc('- [ ] todo\n- [x] done');
    expect(doc.content?.[0]?.type).toBe('taskList');
    expect(doc.content?.[0]?.content?.[0]?.attrs?.checked).toBe(false);
    expect(doc.content?.[0]?.content?.[1]?.attrs?.checked).toBe(true);
  });

  it('creates a table with header + body rows', () => {
    const doc = markdownToDoc('| a | b |\n| --- | --- |\n| c | d |');
    const table = doc.content?.[0];
    expect(table?.type).toBe('table');
    expect(table?.content?.[0]?.content?.[0]?.type).toBe('tableHeader');
    expect(table?.content?.[1]?.content?.[0]?.type).toBe('tableCell');
  });

  it('creates an embed node only for an allow-listed URL', () => {
    expect(markdownToDoc('::embed[v](https://youtu.be/dQw4w9WgXcQ)').content?.[0]?.type).toBe(
      'embed',
    );
  });

  it('plain-text escapes survive a round-trip', () => {
    const md = 'a & b <tag> #5 * ~ | [bracket] back\\slash';
    expect(rt(rt(md))).toBe(rt(md));
    // The characters are preserved as text; re-serialising and re-parsing is lossless.
    const textOf = (doc: ReturnType<typeof markdownToDoc>) =>
      (doc.content ?? [])
        .flatMap((block) => block.content ?? [])
        .map((n) => n.text ?? '')
        .join('');
    expect(textOf(markdownToDoc(docToMarkdown(markdownToDoc(md))))).toBe(textOf(markdownToDoc(md)));
  });
});

const hasLinkMark = (md: string): boolean =>
  (markdownToDoc(md).content ?? []).some((block) =>
    (block.content ?? []).some((n) => (n.marks ?? []).some((m) => m.type === 'link')),
  );

const hasImageNode = (md: string): boolean =>
  (markdownToDoc(md).content ?? []).some((block) =>
    (block.content ?? []).some((n) => n.type === 'noteImage'),
  );

describe('unsafe links / images / HTML are neutralised on parse', () => {
  it('drops javascript:, data:, vbscript: links to plain text (no link mark, stays neutralised)', () => {
    for (const src of [
      '[x](javascript:alert(1))',
      '[x](data:text/html,<script>alert(1)</script>)',
      '[x](vbscript:msgbox(1))',
      '[x](relative/path)',
      '[x](ftp://example.com/x)',
    ]) {
      const out = rt(src);
      expect(hasLinkMark(src)).toBe(false);
      // The escaped output re-parses to plain text, never back into a link.
      expect(hasLinkMark(out)).toBe(false);
      expect(out).not.toContain('<a');
    }
  });

  it('renders a non-note-file image as text, not an image node', () => {
    const out = rt('![alt](https://evil.example/x.png)');
    expect(out).not.toContain('<img');
    expect(hasImageNode('![alt](https://evil.example/x.png)')).toBe(false);
  });

  it('renders raw HTML as literal text nodes with html:false (no executable DOM)', () => {
    const src =
      '<img src=x onerror=alert(1)>\n\n<a href="javascript:alert(1)">x</a>\n\n<iframe src=x></iframe>';
    const doc = markdownToDoc(src);
    // Every inline child is a plain text node: no elements, attributes, links or images.
    const inline = (doc.content ?? []).flatMap((block) => block.content ?? []);
    expect(inline.length).toBeGreaterThan(0);
    expect(inline.every((n) => n.type === 'text')).toBe(true);
    expect(inline.every((n) => (n.marks ?? []).length === 0)).toBe(true);
    // Serialised output escapes the angle brackets, so it never becomes markup again.
    const out = docToMarkdown(doc);
    expect(out).toContain('\\<img');
    expect(out).toContain('\\<iframe');
    expect(out).not.toMatch(/(^|[^\\])</); // no unescaped '<' anywhere
  });

  it('classifyHref rejects anything outside the allow-list', () => {
    expect(classifyHref('javascript:alert(1)').kind).toBe('unsafe');
    expect(classifyHref('/api/v1/note-files/not-a-uuid').kind).toBe('unsafe');
    expect(classifyHref('bokydo:note/not-a-uuid').kind).toBe('unsafe');
    expect(classifyHref(`/api/v1/note-files/${UUID}`).kind).toBe('file');
    expect(classifyHref(`bokydo:task/${UUID}`).kind).toBe('task');
    expect(classifyHref('https://example.com').kind).toBe('link');
  });
});

describe('censored spans', () => {
  it('round-trips the exact token and shows the placeholder in text', () => {
    const token = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB:cccccccccccc}}';
    expect(rt(token)).toBe(token);
    const doc = markdownToDoc(`before ${token} after`);
    const censored = doc.content?.[0]?.content?.find((n) => n.type === 'censored');
    expect(censored?.attrs?.token).toBe(token);
    expect(JSON.stringify(censored)).not.toContain('plaintext');
    expect(CENSORED_PLACEHOLDER).toBe('█████');
  });

  it('contentToMarkdown serialises an inline slice to Markdown', () => {
    expect(contentToMarkdown([{ type: 'text', text: 'hello', marks: [{ type: 'bold' }] }])).toBe(
      '**hello**',
    );
    expect(
      contentToMarkdown([{ type: 'paragraph', content: [{ type: 'text', text: 'block' }] }]),
    ).toBe('block');
  });

  it('markdownToInline parses a plaintext span back into inline nodes', () => {
    expect(markdownToInline('**bold**')).toEqual([
      { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
    ]);
  });
});

describe('embed lines that are not allow-listed', () => {
  it('become a plain safe link (not an embed node)', () => {
    const doc = markdownToDoc('::embed[clip](https://vimeo.com/12345)');
    expect(doc.content?.[0]?.type).toBe('paragraph');
    const link = doc.content?.[0]?.content?.[0];
    expect(link?.marks?.some((m) => m.type === 'link')).toBe(true);
    expect(rt('::embed[clip](https://vimeo.com/12345)')).toBe('[clip](https://vimeo.com/12345)');
  });

  it('an unsafe ::embed URL stays plain text (no link, no embed)', () => {
    const out = rt('::embed[bad](javascript:alert(1))');
    expect(markdownToDoc(out).content?.[0]?.type).toBe('paragraph');
    expect(hasLinkMark(out)).toBe(false);
    expect(out).not.toContain('<a');
  });
});
