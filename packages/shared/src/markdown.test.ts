import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { inlineText, parseInline, parseMarkdown, safeHref, type Inline } from './markdown.js';

const links = (nodes: Inline[]): string[] =>
  nodes.flatMap((n) => (n.t === 'link' ? [n.href, ...links(n.c)] : 'c' in n ? links(n.c) : []));

describe('inline markdown', () => {
  it('parses emphasis, code and links', () => {
    expect(parseInline('**Buy** *milk* ~~eggs~~ `code` [docs](https://example.com)')).toEqual([
      { t: 'strong', c: [{ t: 'text', v: 'Buy' }] },
      { t: 'text', v: ' ' },
      { t: 'em', c: [{ t: 'text', v: 'milk' }] },
      { t: 'text', v: ' ' },
      { t: 'del', c: [{ t: 'text', v: 'eggs' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'code' },
      { t: 'text', v: ' ' },
      { t: 'link', href: 'https://example.com/', c: [{ t: 'text', v: 'docs' }] },
    ]);
  });

  it('autolinks bare URLs without trailing punctuation', () => {
    expect(links(parseInline('See https://example.com/a?b=1.'))).toEqual([
      'https://example.com/a?b=1',
    ]);
  });

  it('leaves snake_case and arithmetic alone', () => {
    expect(inlineText(parseInline('my_var_name and 2*3*4'))).toBe('my_var_name and 2*3*4');
    expect(parseInline('my_var_name').every((n) => n.t === 'text')).toBe(true);
  });

  it.each([
    '[x](javascript:alert(1))',
    '[x](JaVaScRiPt:alert(1))',
    '[x](data:text/html,<script>alert(1)</script>)',
    '[x](vbscript:msgbox)',
    '[x](//evil.example)',
    '[x](/relative)',
    '[x](https://ok.example" onmouseover="alert(1))',
    'javascript:alert(1)',
  ])('never produces a dangerous link: %s', (src) => {
    for (const href of links(parseInline(src))) expect(href).toMatch(/^(https?|mailto):/);
  });

  it('keeps raw HTML as text', () => {
    const nodes = parseInline('<img src=x onerror=alert(1)><script>alert(1)</script>');
    expect(nodes).toEqual([
      { t: 'text', v: '<img src=x onerror=alert(1)><script>alert(1)</script>' },
    ]);
  });

  it('only http(s) and mailto hrefs are safe', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com/');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('ftp://x')).toBeNull();
  });

  it('never loses or invents text, and only emits safe links, for any input', () => {
    fc.assert(
      fc.property(
        fc.string({
          maxLength: 300,
          unit: fc.constantFrom(
            '*',
            '_',
            '~',
            '`',
            '[',
            ']',
            '(',
            ')',
            'a',
            ' ',
            'h',
            't',
            'p',
            's',
            ':',
            '/',
            '\\',
            'j',
          ),
        }),
        (src) => {
          const nodes = parseInline(src);
          for (const href of links(nodes)) expect(href).toMatch(/^(https?|mailto):/);
          expect(inlineText(nodes).length).toBeLessThanOrEqual(src.length);
        },
      ),
      { numRuns: 500 },
    );
  });

  it('stays fast on hostile input (no quadratic blow-up)', () => {
    for (const unit of ['*', '_', '**', '~~', '`', '[', '[a](', '* ', 'a*', 'http://']) {
      const src = unit.repeat(Math.ceil(16_000 / unit.length)).slice(0, 16_000);
      const start = performance.now();
      parseMarkdown(src);
      expect(performance.now() - start, JSON.stringify(unit)).toBeLessThan(200);
    }
  });
});

describe('block markdown', () => {
  it('parses headings, lists, quotes, code blocks and paragraphs', () => {
    const blocks = parseMarkdown(
      '# Plan\n\n- one\n- two\n\n1. first\n2. second\n\n> quoted\n\n```\ncode **not bold**\n```\nline a\nline b',
    );
    expect(blocks.map((b) => b.t)).toEqual(['h', 'ul', 'ol', 'quote', 'pre', 'p']);
    expect(blocks[4]).toEqual({ t: 'pre', v: 'code **not bold**' });
    expect((blocks[5] as { c: Inline[][] }).c).toHaveLength(2);
  });
});

describe('markdown performance (F-025)', () => {
  const clock = (globalThis as unknown as { performance: { now(): number } }).performance;
  const time = (fn: () => void) => {
    const t = clock.now();
    fn();
    return clock.now() - t;
  };

  // 64 KB, 4× the description limit: the old quadratic patterns took seconds here.
  const LS = String.fromCharCode(0x2028);
  it.each([
    ['heading padding', `# ${' '.repeat(64_000)}${LS}`],
    ['bullet padding', `- ${' '.repeat(64_000)}${LS}`],
    ['numbered padding', `1. ${' '.repeat(64_000)}${LS}`],
    ['url punctuation', `http://x${'.'.repeat(64_000)}y`],
    ['many urls', 'http://a.b/... '.repeat(4_000)],
  ])('parses %s in linear time', (_, src) => {
    parseMarkdown(src);
    expect(time(() => parseMarkdown(src))).toBeLessThan(500);
  });

  it('still reads headings and lists', () => {
    expect(parseMarkdown('##   Title  ')[0]).toMatchObject({ t: 'h', level: 2 });
    expect(parseMarkdown('-   item\n- ')[0]).toMatchObject({ t: 'ul' });
    expect(parseMarkdown('#nospace')[0]).toMatchObject({ t: 'p' });
  });
});
