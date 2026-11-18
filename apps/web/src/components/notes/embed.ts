/**
 * Embed URL handling for the note editor (ADR 0025, "Embeds").
 *
 * This is deliberately a *local* copy of the shared allow-list logic (the shared module lives
 * under packages/shared and is owned by the server agent). Keeping it here means the editor can
 * validate a URL synchronously, before it ever inserts an atom node or creates an iframe, and the
 * rules can be unit-tested in isolation from the REST of the app.
 *
 * Strictness: https only, an exact hostname allow-list (no suffix tricks), no userinfo / port,
 * and IDs bounded by explicit quantifiers. `new URL()` does the heavy lifting so `user@host`,
 * `youtube.com.evil.com` and `evilyoutube.com` can never slip through.
 */

export interface ParsedEmbed {
  provider: 'youtube' | 'drive';
  id: string;
  /** Canonical embed URL; YouTube uses the privacy-enhanced host. */
  embedUrl: string;
  /** Canonical public "open in a new tab" URL. */
  openUrl: string;
}

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const DRIVE_ID = /^[A-Za-z0-9_-]{10,100}$/;
const YOUTUBE_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
const DRIVE_HOST = 'drive.google.com';

function youtube(id: string): ParsedEmbed {
  return {
    provider: 'youtube',
    id,
    embedUrl: `https://www.youtube-nocookie.com/embed/${id}`,
    openUrl: `https://www.youtube.com/watch?v=${id}`,
  };
}

/**
 * Recognise exactly the ADR's allow-listed embeddable URLs. `null` means "not embeddable": the
 * editor then shows the URL as a plain (safe) link, never an iframe.
 */
export function parseEmbedUrl(raw: string): ParsedEmbed | null {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  // reject http:, userinfo (`user@host`), explicit ports, and anything non-https.
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();

  if (host === 'youtu.be') {
    const id = /^\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1];
    return id ? youtube(id) : null;
  }
  if (YOUTUBE_HOSTS.has(host)) {
    if (url.pathname === '/watch') {
      const id = url.searchParams.get('v');
      return id && YOUTUBE_ID.test(id) ? youtube(id) : null;
    }
    const id = /^\/shorts\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1];
    return id ? youtube(id) : null;
  }
  if (host === DRIVE_HOST) {
    const id = /^\/file\/d\/([A-Za-z0-9_-]{10,100})(?:\/|$)/.exec(url.pathname)?.[1];
    if (!id || !DRIVE_ID.test(id)) return null;
    return {
      provider: 'drive',
      id,
      embedUrl: `https://drive.google.com/file/d/${id}/preview`,
      openUrl: `https://drive.google.com/file/d/${id}/view`,
    };
  }
  return null;
}

/**
 * A paragraph consisting solely of `::embed[label](url)`.
 *
 * The label is parsed by the same grammar that writes it (review: a label with `]` used to break
 * the note on save): `\\`, `\[` and `\]` are escapes, and any other backslash is literal. Parsing
 * the RAW paragraph also means an escaped `\::embed[...]` can never come back as an atom.
 */
export const EMBED_PREFIX = '::embed[';

export function parseEmbedLine(raw: string): { label: string; url: string } | null {
  const text = raw.trim();
  if (!text.startsWith(EMBED_PREFIX)) return null;
  let i = EMBED_PREFIX.length;
  let label = '';
  let closed = false;
  for (; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch === '\\') {
      const next = text.charAt(i + 1);
      if (next === '\\' || next === '[' || next === ']' || next === '(' || next === ')') {
        label += next;
        i++;
      } else {
        label += ch;
      }
      continue;
    }
    if (ch === ']') {
      closed = true;
      break;
    }
    label += ch;
  }
  if (!closed || text.charAt(i + 1) !== '(') return null;
  const rest = text.slice(i + 2);
  if (!rest.endsWith(')')) return null;
  const url = rest.slice(0, -1).replace(/\\([\\()])/g, '$1');
  return url.length ? { label, url } : null;
}

/** The canonical Markdown for an embed atom; `label` may contain `\`, `[` or `]`. */
export function formatEmbedLine(label: string, url: string): string {
  const safeLabel = label.replace(/[\r\n]+/g, ' ').replace(/[\\[\]]/g, '\\$&');
  return `${EMBED_PREFIX}${safeLabel}](${url})`;
}

/**
 * The iframe may only be created for the exact canonical URL the user authorised with their click.
 * A node whose URL changed afterwards (undo, paste, an edit elsewhere) gets the card again, never
 * a frame for a URL nobody pressed play on (review: changed embed URL loaded without a click).
 */
export function authorisedEmbed(authorised: string | null, rawUrl: string): ParsedEmbed | null {
  if (!authorised) return null;
  const parsed = parseEmbedUrl(rawUrl);
  return parsed && parsed.embedUrl === authorised ? parsed : null;
}

/**
 * Whether a credentialless iframe can be created. Extracted as a pure decision function so the
 * headless tests can exercise it without a real `HTMLIFrameElement`. Under COEP: require-corp a
 * credentialless iframe is the only way a third-party frame can load; browsers without it fall
 * back to the "open in a new tab" link.
 */
export function supportsCredentialless(proto: object): boolean {
  return 'credentialless' in proto;
}

/** Runtime helper used by the embed view; guarded so it is safe in non-DOM environments. */
export function browserSupportsCredentialless(): boolean {
  return (
    typeof HTMLIFrameElement !== 'undefined' && supportsCredentialless(HTMLIFrameElement.prototype)
  );
}

/**
 * Review fix: a `credentialless` iframe is the only way a third-party frame can load under
 * COEP: require-corp, and it MUST be set before `src` triggers the request. Setting it in a
 * passive effect after React has already rendered `<iframe src=…>` is too late. We build the
 * element imperatively and apply every safety attribute (sandbox, referrerpolicy, allow) BEFORE
 * `src` is applied last. The canonical embed URL is recomputed from the node attribute at click
 * time. The tiny `IframeLike` interface lets a headless test spy on the attribute order.
 */
export interface IframeLike {
  setAttribute(name: string, value: string): void;
}

export function applyEmbedIframe(el: IframeLike, embed: ParsedEmbed, title: string): void {
  const attributes: [string, string][] = [
    ['credentialless', ''],
    ['sandbox', 'allow-scripts allow-same-origin allow-presentation allow-popups'],
    ['referrerpolicy', 'strict-origin-when-cross-origin'],
    ['allow', 'encrypted-media; picture-in-picture; fullscreen'],
    ['loading', 'lazy'],
    ['title', title],
    ['class', 'bk-embed-frame'],
    // src is deliberately LAST: credentialless/sandbox must already be set when loading starts.
    ['src', embed.embedUrl],
  ];
  for (const [name, value] of attributes) el.setAttribute(name, value);
}

export function createEmbedIframe(
  doc: Document,
  embed: ParsedEmbed,
  title: string,
): HTMLIFrameElement {
  const el = doc.createElement('iframe');
  applyEmbedIframe(el, embed, title);
  return el;
}
