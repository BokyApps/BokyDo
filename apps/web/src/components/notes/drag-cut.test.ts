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

describe('HIGH: an outbound drag exports only the █████ placeholder (E5)', () => {
  it('transformCopied censors the serialised copy even during an internal drag', () => {
    const controller = createDragCopyController();
    const source = sliceWithCensored();
    controller.markDragStart();
    expect(controller.dragging).toBe(true);
    // ProseMirror keeps the REAL slice in `view.dragging.slice` for an in-editor drop; only the
    // DataTransfer text goes through transformCopied, so this must never carry a token.
    const outbound = controller.transformCopied(source, schema);
    let hasToken = false;
    outbound.content.descendants((node) => {
      if (node.type.name === 'censored' && node.attrs.token === TOKEN) hasToken = true;
      return true;
    });
    expect(hasToken).toBe(false);
    expect(textOf(outbound)).toContain(CENSORED_PLACEHOLDER);
    expect(textOf(outbound)).not.toContain(TOKEN);
    // The in-memory slice is untouched: the editor still holds the real atom.
    let sourceHasToken = false;
    source.content.descendants((node) => {
      if (node.type.name === 'censored' && node.attrs.token === TOKEN) sourceHasToken = true;
      return true;
    });
    expect(sourceHasToken).toBe(true);
  });

  it('ordinary copy / a drag that ended also exports only the placeholder', () => {
    const controller = createDragCopyController();
    const copy = controller.transformCopied(sliceWithCensored(), schema);
    expect(textOf(copy)).toContain(CENSORED_PLACEHOLDER);
    expect(textOf(copy)).not.toContain(TOKEN);
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
