import type { NotePreviewBlock, NotePreviewRun } from '@bokydo/shared';

/**
 * The formatted start of a note on its card: headings, emphasis, lists, quotes and code from the
 * server's `preview` (already redacted and bounded). Everything is rendered as text nodes; the
 * preview never contains HTML. Links are styled but not clickable, since the whole card is a link.
 */
export function NotePreview({ blocks }: { blocks: NotePreviewBlock[] }) {
  return (
    <div className="mt-1 max-h-44 overflow-hidden break-words text-sm text-muted">
      {blocks.map((block, i) => (
        <PreviewBlock key={i} block={block} />
      ))}
    </div>
  );
}

function Runs({ runs }: { runs: NotePreviewRun[] }) {
  return (
    <>
      {runs.map((run, i) => {
        const classes = [
          run.bold && 'font-semibold text-fg',
          run.italic && 'italic',
          run.strike && 'line-through',
          run.code && 'rounded bg-surface-alt px-1 font-mono text-xs',
          run.link && 'text-accent underline',
        ].filter(Boolean);
        return classes.length ? (
          <span key={i} className={classes.join(' ')}>
            {run.text}
          </span>
        ) : (
          run.text
        );
      })}
    </>
  );
}

const indent = (depth = 0) => ({ paddingInlineStart: `${depth}rem` });

function PreviewBlock({ block }: { block: NotePreviewBlock }) {
  const runs = <Runs runs={block.runs} />;
  switch (block.kind) {
    case 'h1':
      return <p className="mt-1 text-base font-semibold text-fg first:mt-0">{runs}</p>;
    case 'h2':
      return <p className="mt-1 font-semibold text-fg first:mt-0">{runs}</p>;
    case 'h3':
      return <p className="mt-1 font-medium text-fg first:mt-0">{runs}</p>;
    case 'quote':
      return <p className="whitespace-pre-line border-l-2 border-line pl-2">{runs}</p>;
    case 'bullet':
    case 'ordered':
    case 'task':
      return (
        <p className="flex gap-1.5" style={indent(block.depth)}>
          <span aria-hidden="true" className="shrink-0">
            {block.kind === 'bullet'
              ? '•'
              : block.kind === 'ordered'
                ? `${block.number ?? 1}.`
                : block.checked
                  ? '☑'
                  : '☐'}
          </span>
          <span className={`min-w-0 whitespace-pre-line ${block.checked ? 'line-through' : ''}`}>
            {runs}
          </span>
        </p>
      );
    case 'code':
      return (
        <pre className="my-0.5 overflow-hidden whitespace-pre-wrap rounded bg-surface-alt px-1.5 py-0.5 font-mono text-xs">
          {block.runs.map((run) => run.text).join('')}
        </pre>
      );
    case 'blank':
      return <div aria-hidden="true" className="h-2" />;
    default:
      return <p className="whitespace-pre-line">{runs}</p>;
  }
}
