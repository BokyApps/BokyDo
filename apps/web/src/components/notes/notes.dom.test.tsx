// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- ProseMirror schema nodes are non-null. */
import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser, DOMSerializer, Fragment, Slice } from '@tiptap/pm/model';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

import { censorSlice } from './clipboard.js';
import {
  CENSORED_PLACEHOLDER,
  docToMarkdown,
  markdownToDoc,
  sanitizeClipboardHtml,
} from './markdown.js';
import { buildExtensions } from './NoteEditor.js';
import { RevealOverlay } from './nodes.js';

// happy-dom logs a virtual-console error whenever it declines to load an <iframe>; let the
// src-less (about:blank) fixture frames load so the hostile-HTML tests stay quiet. A real
// DOMParser document is inert, so this is purely a headless-environment concern.
const happySettings = (
  window as unknown as {
    happyDOM: { settings: { disableIframePageLoading: boolean; enableIframePageLoading: boolean } };
  }
).happyDOM.settings;
happySettings.disableIframePageLoading = false;
happySettings.enableIframePageLoading = true;

const UUID = '123e4567-e89b-12d3-a456-426614174000';
const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:BBBBBBBBBBBBBBBB:cccccccccccc}}';
const schema = getSchema(buildExtensions());

function serializeFragmentToHtml(fragment: Fragment): string {
  const dom = DOMSerializer.fromSchema(schema).serializeFragment(fragment);
  const wrapper = document.createElement('div');
  wrapper.appendChild(dom);
  return wrapper.innerHTML;
}

describe('sanitizeClipboardHtml (paste, first line of defence)', () => {
  it('removes executable tags, event handlers, inline styles and unsafe hrefs', () => {
    const html =
      '<p onclick="steal()" style="color:red">safe</p>' +
      '<img src=x onerror=alert(1)>' +
      '<iframe></iframe>' +
      '<script>alert(1)</script>' +
      '<a href="javascript:alert(1)">bad</a>' +
      '<a href="https://example.com/">ok</a>';
    const out = sanitizeClipboardHtml(html);
    expect(out).not.toMatch(/onerror|onclick|<iframe|<script|style=|javascript:/i);
    expect(out).toContain('safe');
    expect(out).toContain('ok');
    expect(out).toContain('bad'); // label text is kept, only the href goes
  });

  it('keeps our data-tagged note images (internal copy/paste)', () => {
    const out = sanitizeClipboardHtml(
      `<img data-note-image="1" data-id="${UUID}" src="/api/v1/note-files/${UUID}?inline=1" alt="pic">`,
    );
    expect(out).toContain('data-note-image');
  });

  it('drops bare <img> elements entirely', () => {
    expect(sanitizeClipboardHtml('<img src=x onerror=alert(1)>')).not.toContain('<img');
  });
});

describe('censored node — DOM / clipboard never contains plaintext', () => {
  function censoredParagraph() {
    const censored = schema.nodes.censored!.create({ token: TOKEN });
    return schema.nodes.paragraph!.create(null, [
      schema.text('before '),
      censored,
      schema.text(' after'),
    ]);
  }

  it('renderHTML outputs only the █████ block (no cleartext)', () => {
    const html = serializeFragmentToHtml(censoredParagraph().content);
    expect(html).toContain(CENSORED_PLACEHOLDER);
    expect(html).not.toContain('plaintext');
    // The cleartext does not exist anywhere in the node; only ciphertext may appear as an attr.
    expect(html).not.toMatch(/secret|password|clear/i);
  });

  it('the real clipboard path (transformCopied) yields █████ in text/html, with no token', () => {
    const slice = new Slice(Fragment.from(censoredParagraph()), 0, 0);
    const censored = censorSlice(slice, schema);
    const html = serializeFragmentToHtml(censored.content);
    expect(html).toContain(CENSORED_PLACEHOLDER);
    expect(html).not.toContain(TOKEN);
  });

  it('the Markdown source shows the token, never cleartext', () => {
    // docToMarkdown of a document containing the node yields the exact token.
    const md = docToMarkdown(markdownToDoc(`a ${TOKEN} b`));
    expect(md).toContain(TOKEN);
    expect(md).not.toContain('before');
  });
});

describe('pasted hostile HTML produces nothing executable (ProseMirror schema)', () => {
  const hostile =
    '<img src=x onerror=alert(1)>' +
    '<a href="javascript:alert(1)">bad</a>' +
    '<iframe></iframe>' +
    '<p>plain <strong>text</strong></p>';

  function parse(html: string) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return PMDOMParser.fromSchema(schema).parse(div);
  }

  it('safe parse of sanitised HTML has no image/embed/link/executable nodes', () => {
    const doc = parse(sanitizeClipboardHtml(hostile));
    const types: string[] = [];
    const marks: string[] = [];
    let text = '';
    doc.descendants((node) => {
      types.push(node.type.name);
      for (const m of node.marks) marks.push(m.type.name);
      if (node.isText) text += node.text;
    });
    expect(types).not.toContain('noteImage');
    expect(types).not.toContain('embed');
    expect(marks).not.toContain('link');
    expect(text).not.toContain('onerror');
    expect(text).not.toContain('<iframe');
    expect(text).toContain('plain');
  });

  it('even raw hostile HTML is neutralised by the schema alone (defence in depth)', () => {
    const doc = parse(hostile);
    let hasImage = false;
    let hasBadLink = false;
    doc.descendants((node) => {
      if (node.type.name === 'noteImage') hasImage = true;
      for (const m of node.marks) {
        if (m.type.name === 'link' && /javascript:|data:/i.test(String(m.attrs.href)))
          hasBadLink = true;
      }
    });
    expect(hasImage).toBe(false);
    expect(hasBadLink).toBe(false);
    expect(JSON.stringify(doc.toJSON())).not.toContain('onerror');
  });
});

describe('reveal overlay', () => {
  it('shows cleartext only in a non-selectable, non-editable overlay (outside the document)', () => {
    const html = renderToStaticMarkup(<RevealOverlay plaintext="TOP SECRET" onClose={() => {}} />);
    expect(html).toContain('TOP SECRET');
    expect(html).toContain('select-none');
    expect(html).toMatch(/contenteditable="false"/i);
    expect(html).toContain('data-testid="reveal-overlay"');
    // It is a plain div, never a ProseMirror node type.
    expect(html).not.toContain('data-censored');
  });
});
