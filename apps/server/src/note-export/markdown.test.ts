import MarkdownIt from 'markdown-it';
import { describe, expect, it } from 'vitest';
import { parseNoteBody } from './ast.js';
import { renderBlocks, renderNoteMarkdown } from './markdown.js';

const FILE_ID = '22222222-2222-4222-8222-222222222222';
const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const SALT = 'A'.repeat(22);
const IV = 'B'.repeat(16);
const CENSOR = `{{censored:v1:${SALT}:${IV}:c2VjcmV0cGhyYXNl}}`;

const render = (body: string, title = '') => renderNoteMarkdown(title, parseNoteBody(body));

describe('note export Markdown', () => {
  it('puts a sanitised title first and nothing when the title is blank', () => {
    expect(render('Body\n', 'Quarterly plan')).toBe('# Quarterly plan\n\nBody\n');
    expect(render('Body\n', '  \n')).toBe('Body\n');
    expect(render('Body\n', 'My *note* [1]')).toBe('# My \\*note\\* \\[1\\]\n\nBody\n');
  });

  it('writes headings, paragraphs, quotes, lists, code and rules back out', () => {
    const body = [
      '## Section',
      '',
      'A **bold** line with `code`.',
      '',
      '> quoted',
      '',
      '- one',
      '  - two',
      '',
      '- [ ] open',
      '- [x] done',
      '',
      '3. three',
      '4. four',
      '',
      '```ts',
      'const x = 1;',
      '```',
      '',
      '---',
    ].join('\n');
    const out = render(body);
    expect(out).toContain('## Section');
    expect(out).toContain('A **bold** line with `code`.');
    expect(out).toContain('> quoted');
    expect(out).toContain('- one\n  - two');
    expect(out).toContain('- [ ] open');
    expect(out).toContain('- [x] done');
    expect(out).toContain('3. three');
    expect(out).toContain('```ts\nconst x = 1;\n```');
    expect(out).toContain('---');
  });

  it('writes a GFM table with its alignments', () => {
    const out = render('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n');
    expect(out).toBe('| a | b | c |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n');
  });

  it('escapes text so a Markdown character cannot change the meaning', () => {
    // Source escapes keep these as text; the export must escape them again, or they become
    // a list and a heading on the next parse.
    const out = render('1\\. not a list\n\n\\# not a heading\n\nsnake_case_name and a*b\n');
    expect(out).toContain('1\\. not a list');
    expect(out).toContain('\\# not a heading');
    expect(out).toContain('snake\\_case\\_name and a\\*b');
  });

  it('never writes a censored token, only the placeholder', () => {
    const out = render(`before ${CENSOR} after\n`);
    expect(out).toContain('before █████ after');
    expect(out).not.toContain('censored');
    expect(out).not.toContain(SALT);
  });

  it('drops bokydo links to their labels and opens embeds as links', () => {
    const out = render(
      `[note](${`bokydo:note/${NOTE_ID}`}) and [task](bokydo:task/${NOTE_ID})\n\n::embed[Watch](https://youtu.be/dQw4w9WgXcQ)\n`,
    );
    expect(out).toContain('note and task');
    expect(out).not.toContain('bokydo:');
    expect(out).toContain('[Watch](https://www.youtube.com/watch?v=dQw4w9WgXcQ)');
  });

  it('rewrites note-file links and images to the export folder', () => {
    const urls = new Map([
      [FILE_ID, 'files/22222222-2222-4222-8222-222222222222-report%20final.pdf'],
    ]);
    const body = `![shot](/api/v1/note-files/${FILE_ID}?inline=1)\n\n[report final.pdf](/api/v1/note-files/${FILE_ID})\n`;
    const out = renderNoteMarkdown('', parseNoteBody(body), {
      fileUrls: urls,
      fileNames: new Map([[FILE_ID, 'report final.pdf']]),
    });
    expect(out).toContain('![shot](files/22222222-2222-4222-8222-222222222222-report%20final.pdf)');
    expect(out).toContain(
      '[report final.pdf](files/22222222-2222-4222-8222-222222222222-report%20final.pdf)',
    );
    expect(out).not.toContain('/api/v1/note-files/');
  });

  it('names a note file that is not part of the export instead of linking it', () => {
    const out = render(`[gone.pdf](/api/v1/note-files/${FILE_ID})\n`);
    expect(out).toBe('gone.pdf\n');
    const image = render(`![alt](/api/v1/note-files/${FILE_ID})\n`);
    expect(image).toBe('[image: alt]\n');
  });

  it('keeps safe links, hyperlink-safe characters and no raw HTML', () => {
    const out = render(
      `[https](https://example.com/a?b=1&c=2) [mail](mailto:a@example.com) <script>alert(1)</script>\n`,
    );
    expect(out).toContain('[https](https://example.com/a?b=1&c=2)');
    expect(out).toContain('[mail](mailto:a@example.com)');
    expect(out).toContain('\\<script\\>alert(1)\\</script\\>');
  });

  it('round-trips: the serialised Markdown parses back to the same visible text', () => {
    const body = [
      '## Title',
      '',
      'A **bold** and *italic* line, with `code` and a [link](https://example.com).',
      '',
      '- item one',
      '  - [x] nested done',
      '',
      '| a | b |',
      '| - | - |',
      '| 1 | 2 |',
    ].join('\n');
    const once = render(body, 'Note');
    const twice = render(once);
    expect(twice).toBe(once);
  });

  it('chooses a fence longer than any run in the code, in one pass', () => {
    // The source is a tilde fence; its body holds a run of three backticks and three tildes.
    const out = render('~~~~md\n```\ninner fence\n~~~\n~~~~\n');
    // The info string has no backtick, so the fence is backticks, longer than every run.
    expect(out).toBe('````md\n```\ninner fence\n~~~\n````\n');
  });

  it('picks the other fence character when the info string holds a backtick', () => {
    const out = render('~~~c`x\ncode with ``` and ~~~~\n~~~\n');
    // A backtick fence may not carry a backtick in its info string, so tildes are used — five
    // of them here, longer than the body's run of four.
    expect(out).toBe('~~~~~c`x\ncode with ``` and ~~~~\n~~~~~\n');
  });

  it('never lets code reopen a fence or raw HTML when parsed again with html: true', () => {
    const parser = new MarkdownIt({ html: true });
    const bodies = [
      '````\n```js\n</script><script>alert(1)</script>\n````\n',
      '~~~\n```\n<div onclick="x()">html</div>\n```\n~~~\n',
      '```\n~~~~\n<style>b{}</style>\n```\n',
    ];
    for (const body of bodies) {
      const out = render(body);
      const tokens = parser.parse(out, {});
      const html = tokens.filter(
        (token) => token.type === 'html_block' || token.type === 'html_inline',
      );
      expect(html, out).toEqual([]);
      // The code survives as one code block, not as a closed fence plus text.
      const code = tokens.filter((token) => token.type === 'fence');
      expect(code.length, out).toBe(1);
    }
  });

  it('separates inline code from a code-only link so no delimiter run merges', () => {
    const parser = new MarkdownIt({ html: true });
    // The first span needs a two-backtick fence because its text contains one. Without a
    // separator its closing run touches the link's code span; three backticks cannot close a
    // two-backtick span, so `<i>` would escape as raw HTML on a lenient reparse.
    const body = '``a`b``[`<i>`](http://example.com) and ``<b>``[`<b>`](http://example.com/b)\n';
    const out = render(body);
    expect(out).toContain('[`<i>`](http://example.com/)');
    expect(out).toContain('[`<b>`](http://example.com/b)');
    expect(out).not.toContain('```');
    const tokens = parser.parse(out, {});
    const inline = tokens.flatMap((token) => token.children ?? []);
    const html = [...tokens, ...inline].filter(
      (token) => token.type === 'html_block' || token.type === 'html_inline',
    );
    expect(html, out).toEqual([]);
    const images = inline.filter((token) => token.type === 'image');
    expect(images, out).toEqual([]);
    // Both code spans survive as code, with their literal `<i>`/`<b>` text.
    const code = inline.filter((token) => token.type === 'code_inline');
    expect(code.map((token) => token.content)).toEqual(['a`b', '<i>', '<b>', '<b>']);

    // Two code spans that really are adjacent in the model get a literal space between them,
    // so their backtick runs never touch.
    const adjacent = renderBlocks([
      {
        type: 'paragraph',
        runs: [
          { kind: 'text', text: 'a', code: true },
          { kind: 'text', text: 'b', code: true },
        ],
      },
    ]);
    expect(adjacent).toBe('`a` `b`');
    const adjacentInline = parser.parse(adjacent, {}).flatMap((token) => token.children ?? []);
    expect(adjacentInline.filter((token) => token.type === 'code_inline')).toHaveLength(2);
  });

  it('writes a remote image as a link, never as an image', () => {
    const out = render('![shot](https://example.com/x.png)\n\n![nope](ftp://example.com/x.png)\n');
    expect(out).toContain('[shot](https://example.com/x.png)');
    expect(out).not.toContain('![shot]');
    // A destination the app would never open is not linked at all.
    expect(out).toContain('[image: nope]');
  });

  it('names a file whose bytes are gone as unavailable text', () => {
    const out = renderNoteMarkdown(
      '',
      parseNoteBody(`[gone.pdf](/api/v1/note-files/${FILE_ID})\n`),
      {
        fileNames: new Map([[FILE_ID, 'gone.pdf']]),
        fileUnavailable: new Set([FILE_ID]),
      },
    );
    expect(out).toContain('file unavailable: gone.pdf');
    expect(out).not.toContain('/api/v1/note-files/');
  });
});
