// @vitest-environment happy-dom
import { Editor } from '@tiptap/core';
import { afterEach, describe, expect, it } from 'vitest';
import { docToMarkdown, markdownToDoc, verifyDocMarkdown } from './markdown.js';
import { buildExtensions } from './NoteEditor.js';

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const IMAGE = `![photo](/api/v1/note-files/${UUID})`;
const EMBED = '::embed[Talk](https://www.youtube.com/watch?v=dQw4w9WgXcQ)';

const editors: Editor[] = [];
afterEach(() => {
  for (const editor of editors.splice(0)) editor.destroy();
});

function open(markdown: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({
    element,
    extensions: buildExtensions(),
    content: markdownToDoc(markdown),
  });
  editors.push(editor);
  return editor;
}

/** Set the width of the first node of `type`, the way the resize handle does. */
function resize(editor: Editor, type: string, width: number | null): void {
  let pos = -1;
  editor.state.doc.descendants((node, at) => {
    if (pos < 0 && node.type.name === type) pos = at;
  });
  editor.view.dispatch(editor.state.tr.setNodeAttribute(pos, 'width', width));
}

describe('resizing images and embeds', () => {
  it('reads an Obsidian-style width from the alt text or label', () => {
    const doc = markdownToDoc(
      `![photo|300](/api/v1/note-files/${UUID})\n\n${EMBED.replace('Talk', 'Talk|480')}`,
    );
    expect(doc.content?.[0]?.content?.[0]?.attrs).toMatchObject({ alt: 'photo', width: 300 });
    expect(doc.content?.[1]?.attrs).toMatchObject({ label: 'Talk', width: 480 });
  });

  it('leaves a pipe that is not a plausible width in the text', () => {
    const doc = markdownToDoc(
      `![a|b](/api/v1/note-files/${UUID}) ![x|5](/api/v1/note-files/${UUID})`,
    );
    const [first, , second] = doc.content?.[0]?.content ?? [];
    expect(first?.attrs).toMatchObject({ alt: 'a|b' });
    expect(first?.attrs?.width).toBeUndefined();
    expect(second?.attrs).toMatchObject({ alt: 'x|5' });
  });

  it('saves a resized image and embed, and a reset back to the natural size', () => {
    const editor = open(`${IMAGE}\n\n${EMBED}`);
    resize(editor, 'noteImage', 260);
    resize(editor, 'embed', 512);
    const sized = verifyDocMarkdown(editor.getJSON());
    expect(sized.mismatch).toBe(false);
    expect(sized.markdown).toBe(
      `![photo|260](/api/v1/note-files/${UUID})\n\n::embed[Talk|512](https://www.youtube.com/watch?v=dQw4w9WgXcQ)`,
    );
    resize(editor, 'noteImage', null);
    resize(editor, 'embed', null);
    expect(docToMarkdown(editor.getJSON())).toBe(`${IMAGE}\n\n${EMBED}`);
  });
});
