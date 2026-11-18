import { describe, expect, it } from 'vitest';
import {
  countBlocks,
  documentFileIds,
  parseNoteBody,
  type Block,
  type ListBlock,
  type Run,
} from './ast.js';
import { TooLargeError } from './limits.js';

const NOTE_ID = '11111111-1111-4111-8111-111111111111';
const FILE_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '33333333-3333-4333-8333-333333333333';
const SALT = 'A'.repeat(22);
const IV = 'B'.repeat(16);
const CENSOR = `{{censored:v1:${SALT}:${IV}:c2VjcmV0cGhyYXNl}}`;

function only<T extends Block['type']>(
  blocks: readonly Block[],
  type: T,
): Extract<Block, { type: T }> {
  const block = blocks.find((candidate) => candidate.type === type);
  if (!block) throw new Error(`no ${type} block in ${blocks.map((b) => b.type).join(', ')}`);
  return block as Extract<Block, { type: T }>;
}

function text(runs: readonly Run[]): string {
  return runs
    .map((run) => (run.kind === 'text' ? run.text : run.kind === 'image' ? `[${run.alt}]` : ''))
    .join('');
}

describe('note export AST', () => {
  it('keeps headings at their level, including 3 and deeper', () => {
    const { blocks } = parseNoteBody('# One\n\n### Three\n\n###### Six\n');
    expect(blocks.map((block) => (block.type === 'heading' ? block.level : 0))).toEqual([1, 3, 6]);
    // Nothing renders HTML: a heading is only ever a heading.
    expect(blocks.every((block) => block.type === 'heading')).toBe(true);
  });

  it('flattens bold, italic, strike and inline code into marked text runs', () => {
    const { blocks } = parseNoteBody('A **bold** *italic* ~~gone~~ `code` end.\n');
    const runs = only(blocks, 'paragraph').runs.filter((run) => run.kind === 'text');
    expect(runs.map((run) => run.text)).toEqual([
      'A ',
      'bold',
      ' ',
      'italic',
      ' ',
      'gone',
      ' ',
      'code',
      ' end.',
    ]);
    expect(runs[1]).toMatchObject({ bold: true });
    expect(runs[3]).toMatchObject({ italic: true });
    expect(runs[5]).toMatchObject({ strike: true });
    expect(runs[7]).toMatchObject({ code: true });
  });

  it('turns hard breaks into a break run and soft breaks into spaces', () => {
    const { blocks } = parseNoteBody('one  \ntwo\nthree\n');
    const runs = only(blocks, 'paragraph').runs;
    expect(runs.map((run) => run.kind)).toEqual(['text', 'break', 'text', 'text', 'text']);
    expect(text(runs)).toBe('onetwo three');
  });

  it('keeps fenced code verbatim, with its language', () => {
    const { blocks } = parseNoteBody('```ts\nconst x = 1;\n```\n');
    expect(only(blocks, 'code')).toMatchObject({ text: 'const x = 1;\n', language: 'ts' });
  });

  it('nests quotes, lists and task items', () => {
    const body = [
      '> quoted **text**',
      '>',
      '> - inner',
      '',
      '- bullet',
      '  - [ ] open',
      '    - [x] done',
      '',
      '3. three',
      '4. four',
    ].join('\n');
    const { blocks } = parseNoteBody(body);
    const quote = only(blocks, 'quote');
    expect(quote.blocks[0]?.type).toBe('paragraph');
    expect(quote.blocks[1]?.type).toBe('list');

    const bullets = blocks.filter((block): block is ListBlock => block.type === 'list')[0];
    expect(bullets?.ordered).toBe(false);
    expect(bullets?.items[0]?.checked).toBeNull();
    const nested = bullets?.items[0]?.blocks.find((block) => block.type === 'list') as
      ListBlock | undefined;
    expect(nested?.items[0]?.checked).toBe(false);
    expect(
      text(nested?.items[0]?.blocks[0]?.type === 'paragraph' ? nested.items[0].blocks[0].runs : []),
    ).toBe('open');
    const deeper = nested?.items[0]?.blocks.find((block) => block.type === 'list') as
      ListBlock | undefined;
    expect(deeper?.items[0]?.checked).toBe(true);

    const ordered = blocks.filter((block): block is ListBlock => block.type === 'list')[1];
    expect(ordered?.ordered).toBe(true);
    expect(ordered?.start).toBe(3);
  });

  it('reads tables with their alignments', () => {
    const { blocks } = parseNoteBody('| a | b | c |\n| :-- | :-: | --: |\n| 1 | 2 | 3 |\n');
    const table = only(blocks, 'table');
    expect(table.align).toEqual(['left', 'center', 'right']);
    expect(table.header.map(text)).toEqual(['a', 'b', 'c']);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]?.map(text)).toEqual(['1', '2', '3']);
  });

  it('separates note files from other links and images', () => {
    const body = `![alt text](/api/v1/note-files/${FILE_ID}?inline=1)\n\n[name.pdf](/api/v1/note-files/${FILE_ID})\n\n![remote](https://example.com/x.png)\n`;
    const { blocks } = parseNoteBody(body);
    expect(only(blocks, 'image')).toMatchObject({ fileId: FILE_ID, alt: 'alt text' });
    const link = only(blocks, 'paragraph').runs[0];
    expect(link).toMatchObject({ kind: 'text', fileId: FILE_ID, text: 'name.pdf' });
    const remote = blocks.filter((block) => block.type === 'image')[1];
    expect(remote).toMatchObject({ fileId: null, src: 'https://example.com/x.png' });
    expect(documentFileIds(blocks)).toEqual(new Set([FILE_ID]));
  });

  it('recognises embeds and keeps unsupported providers as links', () => {
    const { blocks } = parseNoteBody(
      `::embed[Watch this](https://youtu.be/dQw4w9WgXcQ)\n\n::embed[Drive](https://drive.google.com/file/d/abcdefghij/view)\n\n::embed[Nope](https://vimeo.com/123)\n`,
    );
    const embeds = blocks.filter((block) => block.type === 'embed');
    expect(
      embeds.map((block) => block.type === 'embed' && [block.label, block.openUrl, block.provider]),
    ).toEqual([
      ['Watch this', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
      ['Drive', 'https://drive.google.com/file/d/abcdefghij/view', 'drive'],
    ]);
    expect(only(blocks, 'paragraph').runs.some((run) => run.kind === 'text' && run.href)).toBe(
      true,
    );
  });

  it('turns bokydo links into app links and drops unsafe schemes', () => {
    const { blocks } = parseNoteBody(
      `[a](bokydo:note/${NOTE_ID}) [b](bokydo:task/${TASK_ID}) [c](javascript:alert(1)) [d](https://example.com)\n`,
    );
    const runs = only(blocks, 'paragraph').runs.filter((run) => run.kind === 'text');
    expect(runs[0]).toMatchObject({ appLink: { kind: 'note', id: NOTE_ID }, text: 'a' });
    expect(runs[2]).toMatchObject({ appLink: { kind: 'task', id: TASK_ID }, text: 'b' });
    // A `javascript:` destination never becomes a link; markdown-it leaves the label as text.
    expect(runs.some((run) => run.href?.startsWith('javascript:'))).toBe(false);
    expect(runs[3]?.text).toContain('[c](javascript:alert(1))');
    expect(runs[4]?.href).toBe('https://example.com/');
  });

  it('shows HTML as text, never as markup', () => {
    const { blocks } = parseNoteBody('before <b onmouseover="x()">bold</b> after\n');
    const runs = only(blocks, 'paragraph').runs;
    expect(text(runs)).toBe('before <b onmouseover="x()">bold</b> after');
  });

  it('replaces censored spans with the placeholder before parsing', () => {
    const { blocks } = parseNoteBody(`before ${CENSOR} after **${CENSOR}**\n`);
    const runs = only(blocks, 'paragraph').runs.filter((run) => run.kind === 'text');
    expect(runs.map((run) => run.text)).toEqual(['before ', '█████', ' after ', '█████']);
    expect(runs[1]?.censor).toBe(true);
    expect(runs[3]?.censor).toBe(true);
    const serialized = JSON.stringify(blocks);
    expect(serialized).not.toContain('censored');
    expect(serialized).not.toContain('c2VjcmV0');
  });

  it('never exposes a malformed censor token either', () => {
    // `redactCensored` is deliberately lenient about hand-edited tokens: an opener that is not a
    // valid token is still replaced, so no ciphertext-shaped text reaches an output.
    const malformed = `{{censored:v1:short:iv:${'c2VjcmV0cGhyYXNl'}}}`;
    const { blocks } = parseNoteBody(`before ${malformed} after\n`);
    const runs = only(blocks, 'paragraph').runs.filter((run) => run.kind === 'text');
    expect(runs.map((run) => run.text)).toEqual(['before ', '█████', ' after']);
    expect(runs[1]?.censor).toBe(true);
    // The ciphertext was in the input this time, so this assertion says something.
    expect(JSON.stringify(blocks)).not.toContain('c2VjcmV0');
    expect(JSON.stringify(blocks)).not.toContain('short');
  });

  it('counts markdown-it tokens and refuses a body over the cap before building blocks', () => {
    const body = '- a\n'.repeat(5_000);
    const parsed = parseNoteBody(body);
    expect(parsed.tokenCount).toBeGreaterThan(10_000);
    expect(parsed.blocks.length).toBeGreaterThan(0);
    expect(() => parseNoteBody(body, { maxTokens: 10_000 })).toThrow(/Markdown tokens/);
    // The cap is checked before the walker, so a body that is over it never becomes blocks.
    expect(() => parseNoteBody(body, { maxTokens: 0 })).toThrow(TooLargeError);
  });

  it('counts blocks recursively, for the export limit', () => {
    const { blocks } = parseNoteBody(`# H\n\n- one\n  - two\n\n> quote\n\n| a |\n| - |\n| 1 |\n`);
    // heading 1, list 1 + item 1 + paragraph 1 + nested list 1 + item 1 + paragraph 1,
    // quote 1 + paragraph 1, table 1 + header row 1 + body row 1.
    expect(countBlocks(blocks)).toBe(12);
  });

  it('parses a hostile body without throwing', () => {
    const body = `${'['.repeat(10_000)}\n\n${'*'.repeat(10_000)}\n\n${'`'.repeat(10_000)}\n`;
    expect(() => parseNoteBody(body)).not.toThrow();
  });
});
