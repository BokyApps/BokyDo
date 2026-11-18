// @vitest-environment node
import { Fragment, Schema, Slice } from '@tiptap/pm/model';
import { describe, expect, it, vi } from 'vitest';
import { createDragCopyController, refuseCutIfCensored, sliceHasCensored } from './clipboard.js';
import { CENSORED_PLACEHOLDER } from './markdown.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    censored: { group: 'inline', inline: true, atom: true, attrs: { token: { default: '' } } },
  },
  marks: {},
});

const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';

function sliceWithCensored(): Slice {
  const censored = schema.nodes.censored!.create({ token: TOKEN });
  const paragraph = schema.nodes.paragraph!.create(null, [
    schema.text('hello '),
    censored,
    schema.text(' world'),
  ]);
  return new Slice(Fragment.from(paragraph), 0, 0);
}

function textOf(slice: Slice): string {
  let text = '';
  slice.content.descendants((node) => {
    if (node.isText) text += node.text;
  });
  return text;
}

describe('MED: internal drag keeps the censored token', () => {
  it('transformCopied passes the slice through untouched while dragging (token preserved)', () => {
    const controller = createDragCopyController();
    controller.markDragStart();
    expect(controller.dragging).toBe(true);
    const result = controller.transformCopied(sliceWithCensored(), schema);
    expect(result).toBe(result); // identity: not rewritten into placeholder text
    let hasToken = false;
    result.content.descendants((node) => {
      if (node.type.name === 'censored' && node.attrs.token === TOKEN) hasToken = true;
      return true;
    });
    expect(hasToken).toBe(true);
    expect(textOf(result)).not.toContain(CENSORED_PLACEHOLDER);
  });

  it('ordinary copy / a drag that ends exports only the █████ placeholder (no token)', () => {
    const controller = createDragCopyController();
    const copy = controller.transformCopied(sliceWithCensored(), schema);
    expect(textOf(copy)).toContain(CENSORED_PLACEHOLDER);
    expect(textOf(copy)).not.toContain(TOKEN);
    // dragend resets the flag; a subsequent copy is censored again.
    controller.markDragStart();
    controller.markDragEnd();
    expect(controller.dragging).toBe(false);
    const after = controller.transformCopied(sliceWithCensored(), schema);
    expect(textOf(after)).not.toContain(TOKEN);
  });
});

describe('MED: cut with a censored node is refused', () => {
  it('sliceHasCensored detects a censored atom', () => {
    expect(sliceHasCensored(sliceWithCensored())).toBe(true);
    const plain = new Slice(
      Fragment.from(schema.nodes.paragraph!.create(null, [schema.text('plain')])),
      0,
      0,
    );
    expect(sliceHasCensored(plain)).toBe(false);
  });

  it('refuseCutIfCensored notifies and returns true (handler prevents default, keeps the node)', () => {
    const notify = vi.fn();
    expect(refuseCutIfCensored(sliceWithCensored(), notify)).toBe(true);
    expect(notify).toHaveBeenCalledOnce();
    // The editor's handler prevents default + returns true, so the atom is never deleted.
  });

  it('a plain-text cut is not refused (ProseMirror handles it normally)', () => {
    const notify = vi.fn();
    const plain = new Slice(
      Fragment.from(schema.nodes.paragraph!.create(null, [schema.text('plain')])),
      0,
      0,
    );
    expect(refuseCutIfCensored(plain, notify)).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });
});
