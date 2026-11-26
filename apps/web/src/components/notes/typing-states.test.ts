// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { markdownToDoc, verifyDocMarkdown } from './markdown.js';
import { buildExtensions } from './NoteEditor.js';

/**
 * Autosave runs on every pause in typing, so the editor is saved in half-typed states that
 * Markdown cannot hold exactly (a trailing space, an empty line after Enter). Each one used to fail
 * the pre-save re-parse check and showed "This note couldn't be saved safely" on ordinary typing.
 */
const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function saved(start: string, act: (e: Editor) => void) {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: buildExtensions(),
    content: markdownToDoc(start),
  });
  editors.push(editor);
  editor.commands.focus('end');
  act(editor);
  return verifyDocMarkdown(editor.getJSON());
}

const link = { type: 'link', attrs: { href: 'https://example.com/' } };

const cases: [string, string, (e: Editor) => void, string][] = [
  ['a trailing space', '', (e) => e.commands.insertContent('Hello '), 'Hello'],
  ['a leading space', '', (e) => e.commands.insertContent(' Hello'), 'Hello'],
  ['an indented first line', '', (e) => e.commands.insertContent('    not code'), 'not code'],
  [
    'a space before a hash',
    '',
    (e) => e.commands.insertContent(' # not a heading'),
    '\\# not a heading',
  ],
  ['Enter at the end', 'Hello', (e) => e.commands.splitBlock(), 'Hello\n\n&nbsp;'],
  [
    'Enter twice, then text',
    'Hello',
    (e) => {
      e.commands.splitBlock();
      e.commands.splitBlock();
      e.commands.insertContent('x');
    },
    'Hello\n\n&nbsp;\n\nx',
  ],
  ['a break at the end', 'Hello', (e) => e.commands.setHardBreak(), 'Hello'],
  [
    'spaces around a break',
    'a ',
    (e) => {
      e.commands.setHardBreak();
      e.commands.insertContent(' b');
    },
    'a\\\nb',
  ],
  [
    'bold ending in a space',
    '',
    (e) => {
      e.commands.toggleBold();
      e.commands.insertContent('bold ');
    },
    '**bold**',
  ],
  [
    'bold ending in a space, then plain text',
    '',
    (e) => {
      e.commands.toggleBold();
      e.commands.insertContent('bold ');
      e.commands.toggleBold();
      e.commands.insertContent('next');
    },
    '**bold** next',
  ],
  [
    'italic starting with a space',
    'a',
    (e) => {
      e.commands.toggleItalic();
      e.commands.insertContent(' it');
    },
    'a *it*',
  ],
  [
    'a heading with a trailing space',
    '',
    (e) => {
      e.commands.toggleHeading({ level: 1 });
      e.commands.insertContent('Title ');
    },
    '# Title',
  ],
  [
    'a list item with a trailing space',
    '',
    (e) => {
      e.commands.toggleBulletList();
      e.commands.insertContent('item ');
    },
    '- item',
  ],
  [
    'a link with a trailing space',
    '',
    (e) => e.commands.insertContent({ type: 'text', text: 'link ', marks: [link] }),
    '[link](https://example.com/)',
  ],
  [
    'bold with a space, then bold italic',
    '',
    (e) => {
      e.commands.toggleBold();
      e.commands.insertContent('bold ');
      e.commands.toggleItalic();
      e.commands.insertContent('both');
    },
    '**bold *both***',
  ],
  ['only spaces', '', (e) => e.commands.insertContent('   '), ''],
];

describe('saving half-typed notes', () => {
  it.each(cases)('saves %s', (_label, start, act, markdown) => {
    const result = saved(start, act);
    expect(result.mismatch).toBe(false);
    expect(result.markdown).toBe(markdown);
  });

  it('keeps blank lines across a reload, and saves an empty note as an empty body', () => {
    const result = saved('Hello', (e) => {
      e.commands.splitBlock();
      e.commands.splitBlock();
      e.commands.splitBlock();
      e.commands.insertContent('World');
    });
    expect(result.mismatch).toBe(false);
    const reloaded = markdownToDoc(result.markdown).content ?? [];
    expect(reloaded.map((block) => block.content?.length ?? 0)).toEqual([1, 0, 0, 1]);
    expect(saved('', () => undefined).markdown).toBe('');
    expect(saved('', (e) => e.commands.splitBlock()).markdown).toBe('');
  });

  it('keeps spaces inside a code span', () => {
    const result = saved('', (e) => {
      e.commands.toggleCode();
      e.commands.insertContent('x ');
    });
    expect(result).toMatchObject({ mismatch: false, markdown: '`x `' });
  });
});
