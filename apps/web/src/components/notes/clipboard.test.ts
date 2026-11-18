// @vitest-environment node
import { Fragment, Schema, Slice } from '@tiptap/pm/model';
import { describe, expect, it } from 'vitest';
import { censorSlice, clipboardTextSerializer } from './clipboard.js';
import { CENSORED_PLACEHOLDER } from './markdown.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { content: 'inline*', group: 'block' },
    text: { group: 'inline' },
    censored: { group: 'inline', inline: true, atom: true, attrs: { token: { default: '' } } },
    hardBreak: { group: 'inline', inline: true },
  },
  marks: {},
});

const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB:cccccccccccc}}';

function sliceWithCensored(): Slice {
  const censored = schema.nodes.censored!.create({ token: TOKEN });
  const paragraph = schema.nodes.paragraph!.create(null, [
    schema.text('hello '),
    censored,
    schema.text(' world'),
  ]);
  return new Slice(Fragment.from(paragraph), 0, 0);
}

describe('clipboardTextSerializer (text/plain)', () => {
  it('renders the placeholder, never the token or cleartext', () => {
    const text = clipboardTextSerializer(sliceWithCensored());
    expect(text).toContain(CENSORED_PLACEHOLDER);
    expect(text).not.toContain(TOKEN);
    expect(text).toBe(`hello ${CENSORED_PLACEHOLDER} world`);
  });

  it('keeps normal text unaffected', () => {
    const s = new Slice(
      Fragment.from(schema.nodes.paragraph!.create(null, [schema.text('plain')])),
      0,
      0,
    );
    expect(clipboardTextSerializer(s)).toBe('plain');
  });
});

describe('censorSlice (text/html)', () => {
  it('replaces every censored atom with a █████ text node', () => {
    const result = censorSlice(sliceWithCensored(), schema);
    let hasCensored = false;
    let text = '';
    result.content.descendants((node) => {
      if (node.type.name === 'censored') hasCensored = true;
      if (node.isText) text += node.text;
    });
    expect(hasCensored).toBe(false);
    expect(text).toContain(CENSORED_PLACEHOLDER);
    expect(text).not.toContain(TOKEN);
    expect(text).toBe(`hello ${CENSORED_PLACEHOLDER} world`);
  });

  it('does not alter a slice without censored nodes', () => {
    const s = new Slice(
      Fragment.from(schema.nodes.paragraph!.create(null, [schema.text('plain')])),
      0,
      0,
    );
    const result = censorSlice(s, schema);
    expect(clipboardTextSerializer(result)).toBe('plain');
  });
});
