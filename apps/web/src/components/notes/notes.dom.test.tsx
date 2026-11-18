// @vitest-environment happy-dom
/* eslint-disable @typescript-eslint/no-non-null-assertion -- ProseMirror schema nodes are non-null. */
import { getSchema } from '@tiptap/core';
import { DOMParser as PMDOMParser, DOMSerializer, Fragment, Slice } from '@tiptap/pm/model';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? _key,
  }),
}));

import { applyEmbedIframe, parseEmbedUrl } from './embed.js';
import { censorSlice } from './clipboard.js';
import {
  CENSORED_PLACEHOLDER,
  docToMarkdown,
  markdownToDoc,
  sanitizeClipboardHtml,
} from './markdown.js';
import { buildExtensions } from './NoteEditor.js';
import { RevealOverlay } from './RevealOverlay.js';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
const TOKEN = '{{censored:v1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAA}}';
const schema = getSchema(buildExtensions());
const ANCHOR = { top: 10, left: 20, bottom: 30, right: 60 };

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

  it('strips data-pm-slice metadata and inline table spans', () => {
    const out = sanitizeClipboardHtml(
      '<div data-pm-slice="1 0 []"><table><tr><td rowspan="1000" colspan="1000" style="color:red">x</td></tr></table></div>',
    );
    expect(out).not.toContain('data-pm-slice');
    expect(out).not.toMatch(/rowspan|colspan|style=/i);
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
    const md = docToMarkdown(markdownToDoc(`a ${TOKEN} b`));
    expect(md).toContain(TOKEN);
    expect(md).not.toContain('before');
  });

  it('a crypto-invalid short token is never promoted to an atom', () => {
    const doc = markdownToDoc('a {{censored:v1:a:b:c}} b');
    const types = (doc.content ?? []).flatMap((b) => (b.content ?? []).map((n) => n.type));
    expect(types).not.toContain('censored');
  });
});

describe('pasted hostile HTML produces only safe nodes/text', () => {
  const hostile =
    `<img data-note-image="1" data-id="${UUID}" src="https://evil.example/x.png">` +
    '<img data-note-image="1" data-id="not-a-uuid" src="javascript:alert(1)">' +
    '<a data-file-chip="1" data-id="not-a-uuid" href="/api/v1/note-files/x">forged.pdf</a>' +
    '<span data-internal-chip="1" data-kind="task" data-id="not-a-uuid" data-label="x">x</span>' +
    '<span data-censored="1" data-token="{{censored:v1:a:b:c}}">█████</span>' +
    '<div data-embed="1" data-url="javascript:alert(1)" data-label="x">x</div>' +
    '<table><tr><td rowspan="1000" colspan="1000">cell</td></tr></table>' +
    '<p>plain <strong>text</strong></p>';

  function parse(html: string) {
    const div = document.createElement('div');
    div.innerHTML = html;
    return PMDOMParser.fromSchema(schema).parse(div);
  }

  it('no forged chips, images, censor atoms or embeds survive the schema', () => {
    const doc = parse(sanitizeClipboardHtml(hostile));
    const types: string[] = [];
    let badSpan = false;
    let text = '';
    doc.descendants((node) => {
      types.push(node.type.name);
      if (node.attrs && (node.attrs.rowspan > 1 || node.attrs.colspan > 1)) badSpan = true;
      if (node.isText) text += node.text;
    });
    expect(types).not.toContain('noteImage');
    expect(types).not.toContain('fileChip');
    expect(types).not.toContain('internalChip');
    expect(types).not.toContain('censored');
    expect(types).not.toContain('embed');
    expect(badSpan).toBe(false);
    expect(text).not.toContain('javascript:');
    expect(text).toContain('plain');
    expect(text).toContain('cell');
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

describe('style-free table DOM (CSP style-src self)', () => {
  it('emits no inline style attributes and no colgroup', () => {
    const doc = schema.nodeFromJSON(markdownToDoc('| a | b |\n| :--- | ---: |\n| c | d |'));
    const html = serializeFragmentToHtml(doc.content);
    expect(html).not.toMatch(/style=/i);
    expect(html).not.toContain('<col');
  });
});

describe('source-preservation attributes never leak into the DOM', () => {
  it('src/sep/lead/hash (which may contain censor tokens) are not rendered as HTML attributes', () => {
    const doc = schema.nodeFromJSON(markdownToDoc(`a ${TOKEN} b`));
    const html = serializeFragmentToHtml(doc.content);
    for (const attr of [' src=', ' sep=', ' lead=', ' hash=', 'data-src', 'data-hash']) {
      expect(html).not.toContain(attr);
    }
    // Only the atom's own data-token (ciphertext) may appear; the verbatim paragraph source
    // (which also contains the token) must never be duplicated into a source-meta attribute.
    const paragraph = html.match(/<p[^>]*>/)?.[0] ?? '';
    expect(paragraph).not.toMatch(/src=|sep=|lead=|hash=/);
  });
});

describe('reveal overlay (CONTRACT CHANGE)', () => {
  let root: Root;
  let container: HTMLDivElement;
  let editorRoot: HTMLDivElement;

  afterEach(() => {
    if (root) act(() => root.unmount());
    container?.remove();
    editorRoot?.remove();
  });

  it('portals plaintext outside the editor root and blocks copy/cut/drag', () => {
    editorRoot = document.createElement('div');
    editorRoot.setAttribute('data-testid', 'editor-root');
    editorRoot.textContent = 'visible note text';
    document.body.appendChild(editorRoot);
    container = document.createElement('div');
    document.body.appendChild(container);

    act(() => {
      root = createRoot(container);
      root.render(<RevealOverlay plaintext="TOP SECRET" anchor={ANCHOR} onClose={() => {}} />);
    });

    // Plaintext must NEVER be inside the editor root DOM.
    expect(editorRoot.textContent).not.toContain('TOP SECRET');
    const overlay = document.querySelector('[data-testid="reveal-overlay"]') as HTMLElement | null;
    expect(overlay).not.toBeNull();
    // It is a direct child of body (createPortal), not a descendant of the editor root.
    expect(overlay!.parentElement).toBe(document.body);
    expect(editorRoot.contains(overlay!)).toBe(false);
    expect(overlay!.textContent).toContain('TOP SECRET');
    expect(overlay!.className).toContain('select-none');
    expect(overlay!.getAttribute('aria-live')).toBe('polite');
    expect(overlay!.getAttribute('contenteditable')).toBe('false');

    const copy = new Event('copy', { bubbles: true, cancelable: true });
    overlay!.dispatchEvent(copy);
    expect(copy.defaultPrevented).toBe(true);
    const drag = new Event('dragstart', { bubbles: true, cancelable: true });
    overlay!.dispatchEvent(drag);
    expect(drag.defaultPrevented).toBe(true);
  });
});

describe('iframe: credentialless before src', () => {
  it('sets credentialless/sandbox/referrerpolicy/allow before src (imperative build)', () => {
    const calls: [string, string][] = [];
    const fake = {
      setAttribute: (name: string, value: string) => {
        calls.push([name, value]);
      },
    };
    const embed = parseEmbedUrl('https://youtu.be/dQw4w9WgXcQ')!;
    applyEmbedIframe(fake, embed, 'Video');
    const order = calls.map((c) => c[0]);
    expect(order.indexOf('credentialless')).toBeGreaterThanOrEqual(0);
    expect(order.indexOf('credentialless')).toBeLessThan(order.indexOf('src'));
    expect(order[order.length - 1]).toBe('src');
    expect(order.indexOf('sandbox')).toBeLessThan(order.indexOf('src'));
    expect(calls.find((c) => c[0] === 'sandbox')![1]).toContain('allow-scripts');
    // src uses the canonical privacy-enhanced embed URL, recomputed at click time.
    expect(calls.find((c) => c[0] === 'src')![1]).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    );
  });
});
