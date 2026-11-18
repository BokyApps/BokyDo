import { describe, expect, it } from 'vitest';
import { extractNoteRefs } from './notes-refs.js';

/** The references alone; `complete` is asserted where it matters. */
function refsOf(body: string) {
  const { complete: _complete, ...refs } = extractNoteRefs(body);
  return refs;
}

const noteA = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const noteB = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c';
const task = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5d';
const file = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5e';
const none = { noteIds: [], taskIds: [], fileIds: [] };

describe('reference extraction', () => {
  it('finds note, task and note-file links, normalising case and duplicates', () => {
    const body = [
      `See [one](bokydo:note/${noteA}) and [two](bokydo:note/${noteB}).`,
      `![image](/api/v1/note-files/${file})`,
      `[file](/api/v1/note-files/${file})`,
      `![inline](/api/v1/note-files/${file}?inline=1)`,
      `[titled](bokydo:note/${noteA} "a title")`,
      `Do [this](bokydo:task/${task}).`,
      `Again [one](bokydo:note/${noteA.toUpperCase()}).`,
    ].join('\n');
    expect(refsOf(body)).toEqual({
      noteIds: [noteA, noteB],
      taskIds: [task],
      fileIds: [file],
    });
  });

  it('only counts real link destinations, never code, plain text or look-alikes', () => {
    const body = [
      `plain ${noteA} and bokydo:note/${noteB} and bokydo:note/${task}x`,
      `[x](https://x/api/v1/note-files/${file}/y)`,
      `[x](https://example.com/?u=bokydo:note/${noteA})`,
      `\`[x](bokydo:note/${noteA})\``,
      '``[x](bokydo:note/' + noteB + ')``',
      '```md',
      `[x](bokydo:note/${noteA})`,
      `[x](bokydo:task/${task})`,
      '```',
      '~~~',
      `[x](/api/v1/note-files/${file})`,
      '~~~',
      `    [x](bokydo:note/${noteA})`,
      `bare ](bokydo:note/${noteA})`,
      `[nested text](bokydo:note/${noteB}?x)`,
    ].join('\n');
    expect(refsOf(body)).toEqual(none);
  });

  it('ignores other schemes, malformed ids and unknown prefixes', () => {
    const body = [
      `[x](bokydo:project/${noteA})`,
      `[x](bokydo:note/not-a-uuid)`,
      `[x](/api/v1/note-file/${file})`,
      `[x](bokydo:note/${noteA.slice(1)})`,
      `[x](/api/v1/note-files/${file}?inline=2)`,
      `[x](/api/v1/note-files/${file}?x=1)`,
      `[x](/api/v1/note-files/${file}/)`,
    ].join(' ');
    expect(refsOf(body)).toEqual(none);
  });

  it('understands escaped brackets in labels and angle-bracket destinations', () => {
    const body = [
      `[Q4\\].pdf](/api/v1/note-files/${file})`,
      `![a\\]b](/api/v1/note-files/${file})`,
      `[note](<bokydo:note/${noteA}>)`,
      `[task](<bokydo:task/${task}>)`,
      `[file](</api/v1/note-files/${file}?inline=1>)`,
    ].join('\n');
    expect(refsOf(body)).toEqual({
      noteIds: [noteA],
      taskIds: [task],
      fileIds: [file],
    });
  });

  it('does not claim an unterminated destination', () => {
    expect(refsOf(`[x](/api/v1/note-files/${file}`)).toEqual(none);
    expect(refsOf(`[x](bokydo:note/${noteA}`)).toEqual(none);
    expect(refsOf(`[x] (/api/v1/note-files/${file})`)).toEqual(none);
  });

  it('resolves reference-style links and images, and nested images inside a link', () => {
    const body = [
      `[full][ref] and [collapsed][] and [shortcut]`,
      `![image][ref]`,
      `[![nested](/api/v1/note-files/${file})](https://example.com)`,
      '',
      `[ref]: bokydo:note/${noteA}`,
      `[collapsed]: /api/v1/note-files/${file}`,
      `[shortcut]: bokydo:task/${task}`,
    ].join('\n');
    expect(refsOf(body)).toEqual({
      noteIds: [noteA],
      taskIds: [task],
      fileIds: [file],
    });
  });

  it('claims what the editor’s serializer writes for chips and images', () => {
    // The exact strings apps/web/src/components/notes/markdown.ts emits: `escapeLabel` escapes
    // brackets and backslashes in the label, `pieceFor` uses the plain note-file URL, and table
    // cells escape pipes.
    const body = [
      '| chips | more |',
      '| --- | --- |',
      `| ![Q4\\].png](/api/v1/note-files/${file}) | [Q4\\].pdf](/api/v1/note-files/${file}) |`,
      '',
      `[A \\[draft\\] note](bokydo:note/${noteA})`,
      `[Finish \\*the\\* report](bokydo:task/${task})`,
      `![screenshot](/api/v1/note-files/${file}?inline=1)`,
    ].join('\n');
    expect(refsOf(body)).toEqual({
      noteIds: [noteA],
      taskIds: [task],
      fileIds: [file],
    });
  });

  it('parses 512 KiB hostile bodies in under 500 ms', { timeout: 20_000 }, () => {
    const half = 256 * 1024;
    const bodies = [
      '['.repeat(2 * half),
      '['.repeat(half) + ']'.repeat(half),
      ']('.repeat(half),
      '[a]('.repeat(half / 2),
      '[a]['.repeat(half / 2) + `\n\n[a]: /x\n`,
      '[![a](b)](c)'.repeat(half / 7),
      '`'.repeat(2 * half),
      '> '.repeat(half),
      '- '.repeat(half),
      '| a | b |\n'.repeat(half / 5),
      'word '.repeat(half / 2.5),
    ];
    for (const body of bodies) {
      const started = performance.now();
      const refs = refsOf(body);
      const elapsed = performance.now() - started;
      expect(elapsed, `${body.slice(0, 12)}… took ${elapsed.toFixed(0)} ms`).toBeLessThan(500);
      expect(refs).toEqual(none);
    }
  });

  it('says when the body went past the parsing budget, so callers keep existing claims', () => {
    const file = '11111111-1111-4111-8111-111111111111';
    expect(extractNoteRefs(`[f](/api/v1/note-files/${file})`).complete).toBe(true);
    const hostile = `\`\`\`\n${'['.repeat(60_000)}\n\`\`\`\n\n[f](/api/v1/note-files/${file})`;
    expect(extractNoteRefs(hostile).complete).toBe(false);
  });
});
