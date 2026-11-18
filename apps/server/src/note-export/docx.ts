import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  ImageRun,
  LevelFormat,
  Packer,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  UnderlineType,
  WidthType,
  type FileChild,
  type ILevelsOptions,
  type ParagraphChild,
} from 'docx';
import { PassThrough, type Readable } from 'node:stream';
import type { Block, ListBlock, Run } from './ast.js';
import type { LoadedImage } from './images.js';

/**
 * DOCX export. Word has no concept of "censored", so a span is the placeholder text `█████`,
 * in-app links are their labels, note-file links are their filenames, and only this note's own
 * PNG/JPEG files are embedded (scaled to the page's text width).
 */

export interface DocxContext {
  images: ReadonlyMap<string, LoadedImage>;
  /** Note-file id → filename, for links whose file is not being embedded. */
  fileNames: ReadonlyMap<string, string>;
}

/** A4 in twips, with 2 cm margins; the text column is what images are scaled to. */
const PAGE_WIDTH = 11906;
const PAGE_HEIGHT = 16838;
const MARGIN = 1134;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;

const LINK_COLOR = '1A56DB';
const LINK_UNDERLINE = { type: UnderlineType.SINGLE } as const;
const HEADING_LEVELS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

const ORDERED_LIST = 'note-export-ordered';

/** 1–9 decimal levels with an indent each, so a nested list stays visibly nested. */
const numbering = {
  config: [
    {
      reference: ORDERED_LIST,
      levels: Array.from({ length: 9 }, (_, level): ILevelsOptions => ({
        level,
        format: LevelFormat.DECIMAL,
        text: `%${level + 1}.`,
        alignment: AlignmentType.START,
        style: { paragraph: { indent: { left: 720 + level * 720, hanging: 360 } } },
      })),
    },
  ],
};

function heading(level: number) {
  return HEADING_LEVELS[Math.min(6, Math.max(1, level)) - 1] ?? HeadingLevel.HEADING_1;
}

function scale(image: { width: number; height: number }): { width: number; height: number } {
  // Pixels at 96 dpi, as `docx` expects them. Leave room for a heading and a caption.
  const maxWidth = 630;
  const maxHeight = 820;
  const ratio = Math.min(1, maxWidth / image.width, maxHeight / image.height);
  return {
    width: Math.max(1, Math.round(image.width * ratio)),
    height: Math.max(1, Math.round(image.height * ratio)),
  };
}

function imageRun(image: LoadedImage): ImageRun {
  return new ImageRun({
    type: image.type === 'png' ? 'png' : 'jpg',
    data: image.bytes,
    transformation: scale(image),
    altText: { name: image.filename, description: image.filename, title: image.filename },
  });
}

function missingImage(name: string, italic: boolean): TextRun {
  return new TextRun({ text: `[image: ${name}]`, italics: italic });
}

/** One Markdown run as Word content: formatting kept, safe links become real hyperlinks. */
function runChildren(run: Run, ctx: DocxContext, italic: boolean): ParagraphChild[] {
  if (run.kind === 'break') return [new TextRun({ break: 1 })];
  if (run.kind === 'image') {
    const image = run.fileId ? ctx.images.get(run.fileId) : undefined;
    if (image) return [imageRun(image)];
    const name = run.alt || (run.fileId ? ctx.fileNames.get(run.fileId) : null) || 'file';
    return [missingImage(name, italic)];
  }
  if (run.code) {
    return [
      new TextRun({
        text: run.text,
        font: 'Courier New',
        size: 20,
        bold: run.bold === true,
        italics: run.italic === true || italic,
        strike: run.strike === true,
      }),
    ];
  }
  // A note-file link and a `bokydo:` link have no destination outside the app: plain text.
  // A note-file link is shown by the file's name rather than the label it happened to have.
  const text = (run.fileId ? ctx.fileNames.get(run.fileId) : null) ?? run.text;
  const style = {
    bold: run.bold === true,
    italics: run.italic === true || italic,
    strike: run.strike === true,
  };
  if (!run.href || run.appLink || run.fileId) return [new TextRun({ text, ...style })];
  return [
    new ExternalHyperlink({
      link: run.href,
      children: [new TextRun({ text, ...style, color: LINK_COLOR, underline: LINK_UNDERLINE })],
    }),
  ];
}

function paragraphChildren(
  runs: readonly Run[],
  ctx: DocxContext,
  opts: { italic?: boolean } = {},
): ParagraphChild[] {
  const children: ParagraphChild[] = [];
  for (const run of runs) children.push(...runChildren(run, ctx, opts.italic === true));
  return children;
}

function indentOptions(indent: number | undefined, extra = 0): { indent?: { left: number } } {
  const left = (indent ?? 0) + extra;
  return left > 0 ? { indent: { left } } : {};
}

function alignOf(align: string | null) {
  return align === 'center'
    ? AlignmentType.CENTER
    : align === 'right'
      ? AlignmentType.RIGHT
      : AlignmentType.LEFT;
}

function boldRuns(runs: readonly Run[]): Run[] {
  return runs.map((run) => (run.kind === 'text' ? { ...run, bold: true } : run));
}

/** A block as one paragraph, for table cells (which hold paragraphs, not arbitrary blocks). */
function cellParagraph(block: Block, ctx: DocxContext, bold: boolean, align: string | null) {
  const options = { alignment: alignOf(align) };
  const runs =
    block.type === 'heading' || block.type === 'paragraph'
      ? bold
        ? boldRuns(block.runs)
        : block.runs
      : null;
  if (runs) return new Paragraph({ ...options, children: paragraphChildren(runs, ctx) });
  if (block.type === 'code')
    return new Paragraph({
      ...options,
      children: [new TextRun({ text: block.text, font: 'Courier New', size: 18 })],
    });
  if (block.type === 'image') {
    const image = block.fileId ? ctx.images.get(block.fileId) : undefined;
    if (image) return new Paragraph({ ...options, children: [imageRun(image)] });
    return new Paragraph({ ...options, children: [missingImage(block.alt || 'file', false)] });
  }
  if (block.type === 'embed')
    return new Paragraph({
      ...options,
      children: [
        new ExternalHyperlink({
          link: block.openUrl,
          children: [
            new TextRun({ text: `▶ ${block.label}`, color: LINK_COLOR, underline: LINK_UNDERLINE }),
          ],
        }),
      ],
    });
  if (block.type === 'list')
    return new Paragraph({
      ...options,
      children: block.items.flatMap((item) =>
        item.blocks.flatMap((inner) =>
          inner.type === 'paragraph' ? paragraphChildren(inner.runs, ctx) : [],
        ),
      ),
    });
  return new Paragraph({ ...options });
}

function tableBlock(block: Extract<Block, { type: 'table' }>, ctx: DocxContext): Table {
  const width = Math.max(block.header.length, ...block.rows.map((row) => row.length));
  const columnWidth = Math.max(1, Math.floor(CONTENT_WIDTH / Math.max(1, width)));
  const border = { style: BorderStyle.SINGLE, size: 4, color: 'B0B0B0' };
  const cell = (runs: readonly Run[], head: boolean, align: string | null) =>
    new TableCell({
      width: { size: columnWidth, type: WidthType.DXA },
      ...(head ? { shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' } } : {}),
      children: [
        cellParagraph(
          { type: 'paragraph', runs: head ? boldRuns(runs) : [...runs] },
          ctx,
          false,
          align,
        ),
      ],
    });
  const row = (cells: readonly Run[][], head: boolean) =>
    new TableRow({
      tableHeader: head,
      children: Array.from({ length: width }, (_, index) =>
        cell(cells[index] ?? [], head, block.align[index] ?? null),
      ),
    });
  return new Table({
    rows: [row(block.header, true), ...block.rows.map((cells) => row(cells, false))],
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
  });
}

function listBlock(block: ListBlock, ctx: DocxContext, level: number, indent: number): FileChild[] {
  const depth = Math.min(8, level);
  const items: FileChild[] = [];
  const listProperties = block.ordered
    ? { numbering: { reference: ORDERED_LIST, level: depth } }
    : { bullet: { level: depth } };
  for (const item of block.items) {
    const rest = [...item.blocks];
    const first = rest.shift();
    const marker: ParagraphChild[] =
      item.checked === null ? [] : [new TextRun(item.checked ? '☑ ' : '☐ ')];
    if (first?.type === 'paragraph') {
      items.push(
        new Paragraph({
          ...listProperties,
          children: [...marker, ...paragraphChildren(first.runs, ctx)],
        }),
      );
    } else {
      items.push(new Paragraph({ ...listProperties, children: marker }));
      if (first) rest.unshift(first);
    }
    items.push(...blocksToDocx(rest, ctx, { indent: indent + 720, listLevel: depth + 1 }));
  }
  return items;
}

function blocksToDocx(
  blocks: readonly Block[],
  ctx: DocxContext,
  opts: { indent?: number; listLevel?: number; italic?: boolean } = {},
): FileChild[] {
  const children: FileChild[] = [];
  const indent = opts.indent;
  const italic = opts.italic === true;
  for (const block of blocks) {
    switch (block.type) {
      case 'heading':
        children.push(
          new Paragraph({
            heading: heading(block.level),
            children: paragraphChildren(block.runs, ctx, { italic }),
            spacing: { before: 200, after: 100 },
            ...indentOptions(indent),
          }),
        );
        break;
      case 'paragraph':
        children.push(
          new Paragraph({
            children: paragraphChildren(block.runs, ctx, { italic }),
            spacing: { after: 120 },
            ...indentOptions(indent),
          }),
        );
        break;
      case 'code':
        for (const line of block.text.replace(/\n$/, '').split('\n'))
          children.push(
            new Paragraph({
              children: [
                new TextRun({ text: line === '' ? ' ' : line, font: 'Courier New', size: 18 }),
              ],
              shading: { type: ShadingType.CLEAR, fill: 'F2F2F2', color: 'auto' },
              spacing: { after: 0 },
              ...indentOptions(indent, 240),
            }),
          );
        break;
      case 'quote':
        children.push(
          ...blocksToDocx(block.blocks, ctx, { indent: (indent ?? 0) + 720, italic: true }),
        );
        break;
      case 'list':
        children.push(...listBlock(block, ctx, opts.listLevel ?? 0, indent ?? 0));
        break;
      case 'table':
        children.push(tableBlock(block, ctx));
        break;
      case 'hr':
        children.push(
          new Paragraph({
            text: '',
            border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'C0C0C0', space: 1 } },
            spacing: { before: 120, after: 120 },
          }),
        );
        break;
      case 'image': {
        const image = block.fileId ? ctx.images.get(block.fileId) : undefined;
        children.push(
          new Paragraph({
            children: image
              ? [imageRun(image)]
              : [
                  missingImage(
                    block.alt || (block.fileId ? ctx.fileNames.get(block.fileId) : null) || 'file',
                    italic,
                  ),
                ],
            spacing: { after: 120 },
            ...indentOptions(indent),
          }),
        );
        break;
      }
      case 'embed':
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: '▶ ' }),
              new ExternalHyperlink({
                link: block.openUrl,
                children: [
                  new TextRun({
                    text: block.label,
                    color: LINK_COLOR,
                    underline: LINK_UNDERLINE,
                  }),
                ],
              }),
              new TextRun({ text: ' — ' }),
              new ExternalHyperlink({
                link: block.openUrl,
                children: [
                  new TextRun({
                    text: block.openUrl,
                    color: LINK_COLOR,
                    underline: LINK_UNDERLINE,
                  }),
                ],
              }),
            ],
            spacing: { after: 120 },
            ...indentOptions(indent),
          }),
        );
        break;
      default:
        break;
    }
  }
  return children;
}

/** Build a DOCX document as a readable stream (the packer emits the archive in one buffer). */
export function buildDocx(title: string, blocks: readonly Block[], ctx: DocxContext): Readable {
  const children: FileChild[] = [];
  const cleanTitle = title.replace(/\s+/g, ' ').trim();
  if (cleanTitle)
    children.push(
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(cleanTitle)] }),
    );
  children.push(...blocksToDocx(blocks, ctx));

  const document = new Document({
    title: cleanTitle,
    creator: 'BokyDo',
    numbering,
    sections: [
      {
        properties: {
          page: {
            size: { width: PAGE_WIDTH, height: PAGE_HEIGHT },
            margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
          },
        },
        children: children.length > 0 ? children : [new Paragraph({ text: '' })],
      },
    ],
  });
  // `docx` hands back an old-style event stream; a PassThrough is async-iterable and pipes.
  const out = new PassThrough();
  const packed = Packer.toStream(document) as unknown as Readable;
  packed.on('error', (err: Error) => out.destroy(err));
  packed.pipe(out);
  return out;
}
