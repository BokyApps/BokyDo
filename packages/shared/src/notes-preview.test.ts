import { describe, expect, it } from 'vitest';
import { notePreview } from './notes-preview.js';

const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:c2VjcmV0c2VjcmV0}}';

describe('note card preview', () => {
  it('keeps headings, emphasis, lists, quotes, code and blank lines', () => {
    const body = [
      'This is *a* test.',
      '',
      '# Header',
      '',
      'df**gdgdfg** and ~~gone~~ and `code`',
      '',
      '&nbsp;',
      '',
      '&nbsp;',
      '',
      '> quoted [link](https://example.com/)',
      '',
      '- [x] done',
      '- plain',
      '  1. nested',
    ].join('\n');
    expect(notePreview(body)).toEqual([
      {
        kind: 'paragraph',
        runs: [{ text: 'This is ' }, { text: 'a', italic: true }, { text: ' test.' }],
      },
      { kind: 'h1', runs: [{ text: 'Header' }] },
      {
        kind: 'paragraph',
        runs: [
          { text: 'df' },
          { text: 'gdgdfg', bold: true },
          { text: ' and ' },
          { text: 'gone', strike: true },
          { text: ' and ' },
          { text: 'code', code: true },
        ],
      },
      { kind: 'blank', runs: [] },
      { kind: 'quote', runs: [{ text: 'quoted ' }, { text: 'link', link: true }] },
      { kind: 'task', runs: [{ text: 'done' }], depth: 0, checked: true },
      { kind: 'bullet', runs: [{ text: 'plain' }], depth: 0 },
      { kind: 'ordered', runs: [{ text: 'nested' }], depth: 1, number: 1 },
    ]);
  });

  it('never carries censored text', () => {
    const preview = JSON.stringify(
      notePreview(`before ${TOKEN} after\n\n{{censored:v1:unclosed secret`),
    );
    expect(preview).toContain('█████');
    expect(preview).not.toContain('c2VjcmV0');
    expect(preview).not.toContain('secret');
  });

  it('is bounded for long bodies', () => {
    const preview = notePreview(`${'word '.repeat(200_000)}\n\n${'- item\n'.repeat(5_000)}`);
    const chars = preview.flatMap((b) => b.runs).reduce((n, r) => n + r.text.length, 0);
    expect(chars).toBeLessThanOrEqual(401);
    expect(preview.length).toBeLessThanOrEqual(10);
    expect(preview.at(-1)?.runs.at(-1)?.text.endsWith('…')).toBe(true);
  });

  it('shows tables as rows and embeds as their label', () => {
    expect(
      notePreview('| a | b |\n| --- | --- |\n| 1 | 2 |\n\n::embed[Video](https://youtu.be/x)'),
    ).toEqual([
      { kind: 'paragraph', runs: [{ text: 'a · b' }] },
      { kind: 'paragraph', runs: [{ text: '1 · 2' }] },
      { kind: 'paragraph', runs: [{ text: '▶ ' }, { text: 'Video', link: true }] },
    ]);
  });
});
