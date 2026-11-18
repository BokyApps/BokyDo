import { describe, expect, it } from 'vitest';
import { parseNoteBody } from './ast.js';
import { renderNoteMarkdown } from './markdown.js';

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
});
