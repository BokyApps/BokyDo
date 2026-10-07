import { parseInline, parseMarkdown, type Block, type Inline } from '@bokydo/shared';
import { Fragment, useMemo, type ReactNode } from 'react';

/**
 * Renders the safe Markdown AST as React elements. There is no HTML path at all, and links are
 * already restricted to http(s)/mailto by the parser.
 */
function renderInline(nodes: Inline[], key = ''): ReactNode[] {
  return nodes.map((n, i) => {
    const k = `${key}${i}`;
    switch (n.t) {
      case 'text':
        return <Fragment key={k}>{n.v}</Fragment>;
      case 'code':
        return (
          <code key={k} className="rounded bg-surface-alt px-1 font-mono text-[0.9em]">
            {n.v}
          </code>
        );
      case 'strong':
        return <strong key={k}>{renderInline(n.c, k)}</strong>;
      case 'em':
        return <em key={k}>{renderInline(n.c, k)}</em>;
      case 'del':
        return <del key={k}>{renderInline(n.c, k)}</del>;
      case 'link':
        return (
          <a
            key={k}
            href={n.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            className="text-accent underline underline-offset-2 hover:decoration-2"
            onClick={(e) => e.stopPropagation()}
          >
            {renderInline(n.c, k)}
          </a>
        );
    }
  });
}

export function InlineMarkdown({ text }: { text: string }) {
  const nodes = useMemo(() => parseInline(text), [text]);
  return <>{renderInline(nodes)}</>;
}

function renderBlock(b: Block, i: number): ReactNode {
  switch (b.t) {
    case 'p':
      return (
        <p key={i}>
          {b.c.map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {renderInline(line, `${i}-${j}-`)}
            </Fragment>
          ))}
        </p>
      );
    case 'h': {
      const cls = ['text-lg font-semibold', 'text-base font-semibold', 'text-sm font-semibold'][
        b.level - 1
      ];
      return (
        <p key={i} role="heading" aria-level={b.level + 2} className={cls}>
          {renderInline(b.c)}
        </p>
      );
    }
    case 'ul':
    case 'ol': {
      const List = b.t;
      return (
        <List key={i} className={`${b.t === 'ul' ? 'list-disc' : 'list-decimal'} pl-5`}>
          {b.items.map((item, j) => (
            <li key={j}>{renderInline(item, `${i}-${j}-`)}</li>
          ))}
        </List>
      );
    }
    case 'quote':
      return (
        <blockquote key={i} className="border-l-2 border-line pl-3 text-muted">
          {b.c.map((line, j) => (
            <Fragment key={j}>
              {j > 0 && <br />}
              {renderInline(line, `${i}-${j}-`)}
            </Fragment>
          ))}
        </blockquote>
      );
    case 'pre':
      return (
        <pre key={i} className="overflow-x-auto rounded-lg bg-surface-alt p-3 font-mono text-xs">
          {b.v}
        </pre>
      );
  }
}

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return (
    <div className={`space-y-2 text-sm break-words ${className}`}>{blocks.map(renderBlock)}</div>
  );
}
