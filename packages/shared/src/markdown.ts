/* eslint-disable @typescript-eslint/no-non-null-assertion --
   Index access below is bounds-checked by the surrounding loop/length conditions. */
/**
 * A deliberately small Markdown subset (what Todoist supports) parsed into a plain AST. Clients
 * render the AST as native elements: there is no HTML path, so user text can't inject markup,
 * and only http(s)/mailto links survive. Linear-time scanning keeps hostile input cheap.
 */
export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong' | 'em' | 'del'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] };

export type Block =
  | { t: 'p'; c: Inline[][] } // lines of a paragraph
  | { t: 'h'; level: 1 | 2 | 3; c: Inline[] }
  | { t: 'ul' | 'ol'; items: Inline[][] }
  | { t: 'quote'; c: Inline[][] }
  | { t: 'pre'; v: string };

const MAX_DEPTH = 4;
const DELIMS: [string, 'strong' | 'em' | 'del'][] = [
  ['**', 'strong'],
  ['__', 'strong'],
  ['~~', 'del'],
  ['*', 'em'],
  ['_', 'em'],
];

/** Only absolute http(s) and mailto URLs are links; anything else stays plain text. */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (url.length > 2048 || /[\s<>"'`]/.test(url)) return null;
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:')
      return u.href;
  } catch {
    // not a URL
  }
  return null;
}

const isWord = (ch: string | undefined) => ch !== undefined && /[\p{L}\p{N}]/u.test(ch);

export function parseInline(src: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buf = '';
  const flush = () => {
    if (buf) out.push({ t: 'text', v: buf });
    buf = '';
  };
  // Once a delimiter has no closing match after some position, it never will: remember that.
  const noClose = new Set<string>();
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    if (ch === '\\' && i + 1 < src.length && /[\\`*_~[\]()#>-]/.test(src[i + 1]!)) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === '`' && !noClose.has('`')) {
      const end = src.indexOf('`', i + 1);
      if (end === -1) noClose.add('`');
      else if (end > i + 1) {
        flush();
        out.push({ t: 'code', v: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (depth < MAX_DEPTH) {
      let matched = false;
      for (const [d, t] of DELIMS) {
        if (!src.startsWith(d, i) || noClose.has(d)) continue;
        // `snake_case` and `2*3*4` are not emphasis: single-character delimiters need a word boundary.
        const single = d.length === 1;
        if (single && isWord(src[i - 1])) continue;
        const start = i + d.length;
        if (start >= src.length || /\s/.test(src[start]!)) continue;
        const end = src.indexOf(d, start);
        if (end === -1) {
          noClose.add(d);
          continue;
        }
        if (end === start || /\s/.test(src[end - 1]!)) continue;
        if (single && isWord(src[end + d.length])) continue;
        flush();
        out.push({ t, c: parseInline(src.slice(start, end), depth + 1) });
        i = end + d.length;
        matched = true;
        break;
      }
      if (matched) continue;
    }

    if (ch === '[' && !noClose.has('](')) {
      const close = src.indexOf('](', i + 1);
      if (close === -1) noClose.add('](');
      else {
        const end = src.indexOf(')', close + 2);
        const href = end === -1 ? null : safeHref(src.slice(close + 2, end));
        if (href && depth < MAX_DEPTH) {
          flush();
          out.push({ t: 'link', href, c: parseInline(src.slice(i + 1, close), depth + 1) });
          i = end + 1;
          continue;
        }
      }
    }

    if ((ch === 'h' || ch === 'H') && !isWord(src[i - 1])) {
      const m = /^https?:\/\/[^\s<>"'`]+/i.exec(src.slice(i, i + 2048));
      if (m) {
        const url = m[0].replace(/[.,;:!?)\]]+$/, '');
        const href = safeHref(url);
        if (href) {
          flush();
          out.push({ t: 'link', href, c: [{ t: 'text', v: url }] });
          i += url.length;
          continue;
        }
      }
    }

    buf += ch;
    i++;
  }
  flush();
  return out;
}

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const blocks: Block[] = [];
  let para: Inline[][] = [];
  const endPara = () => {
    if (para.length) blocks.push({ t: 'p', c: para });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      endPara();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith('```'); i++) body.push(lines[i]!);
      blocks.push({ t: 'pre', v: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      endPara();
      blocks.push({ t: 'h', level: heading[1]!.length as 1 | 2 | 3, c: parseInline(heading[2]!) });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d{1,9}[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      endPara();
      const kind = bullet ? 'ul' : 'ol';
      const items: Inline[][] = [];
      for (; i < lines.length; i++) {
        const m = (kind === 'ul' ? /^\s*[-*+]\s+(.*)$/ : /^\s*\d{1,9}[.)]\s+(.*)$/).exec(lines[i]!);
        if (!m) break;
        items.push(parseInline(m[1]!));
      }
      i--;
      blocks.push({ t: kind, items });
      continue;
    }
    if (line.startsWith('>')) {
      endPara();
      const quoted: Inline[][] = [];
      for (; i < lines.length && lines[i]!.startsWith('>'); i++)
        quoted.push(parseInline(lines[i]!.replace(/^>\s?/, '')));
      i--;
      blocks.push({ t: 'quote', c: quoted });
      continue;
    }
    if (line.trim() === '') endPara();
    else para.push(parseInline(line));
  }
  endPara();
  return blocks;
}

/** Plain text of inline nodes (for search, notifications, titles). */
export function inlineText(nodes: Inline[]): string {
  return nodes.map((n) => ('v' in n ? n.v : inlineText(n.c))).join('');
}
