import type { Readable } from 'node:stream';
import PdfDocument from 'pdfkit';
import type { Block, ListBlock, Run } from './ast.js';
import { validateImage } from './image-info.js';
import type { LoadedImage } from './images.js';
import { TooLargeError, type ExportDeadline } from './limits.js';

/**
 * PDF export on the built-in PDF fonts (Helvetica/Courier), A4 with 2 cm margins. Those fonts
 * are WinAnsi only, so text outside that range is written as `?` (see docs/note-export.md);
 * censored spans are drawn as a solid bar, task checkboxes as drawn boxes and the play marker
 * of an embed as `»`, so no glyph is invented.
 *
 * Images: only the PNG/JPEG classes validated in `image-info.ts` reach this module. An image is
 * parsed once per file and then reused (`PDFKit` takes a prepared image object), and a file that
 * `pdfkit` still refuses falls back to its `[image: name]` text rather than losing the document.
 */

export interface PdfContext {
  images: ReadonlyMap<string, LoadedImage>;
  fileNames: ReadonlyMap<string, string>;
  /** One opened image per note file, so a file placed twice is parsed and embedded once. */
  prepared?: Map<string, PreparedImage>;
}

/**
 * pdfkit's own opened-image object. `@types/pdfkit` describes `image()` as taking a path or
 * bytes only, but at runtime `image()` uses `src` as the image when it has `width` and `height`
 * (`if (src.width && src.height) image = src`), which is how one file is embedded only once.
 */
export interface PreparedImage {
  width: number;
  height: number;
  label: string;
  obj: unknown;
  embed(doc: PdfDoc): void;
}

interface PdfDocRuntime extends PdfDoc {
  openImage(src: Buffer): PreparedImage;
}

export interface PdfRenderOptions {
  /** Tests read the content streams directly, so they turn compression off. */
  compress?: boolean;
  /** Abandon the render between blocks once the export has taken too long. */
  deadline?: ExportDeadline;
  /** Annotations in one PDF, after contiguous link runs are coalesced. */
  maxLinkAnnotations?: number;
}

type PdfDoc = PDFKit.PDFDocument;
type DocConstructor = new (options?: PDFKit.PDFDocumentOptions) => PdfDoc;
const createPdfDocument = PdfDocument as unknown as DocConstructor;

const BODY_SIZE = 11;
const CODE_SIZE = 9;
const HEADING_SIZES = [22, 18, 15.5, 13.5, 12, 11] as const;
const LINK_COLOR = '#1A56DB';
const TEXT_COLOR = '#000000';
const LINE_FACTOR = 1.4;
const TABLE_PAD = 4;
const TABLE_MIN_COLUMN = 24;
const DEFAULT_MAX_LINK_ANNOTATIONS = 20_000;

/**
 * Code points in WinAnsiEncoding (cp1252): ASCII, Latin-1 and the characters cp1252 puts in
 * 0x80–0x9F. Everything else has no glyph in the built-in fonts.
 */
const WIN_ANSI_LATIN = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

function encodable(cp: number): boolean {
  // Linear in the string length; no regex, no backtracking.
  if (cp === 0x09) return true;
  if (cp >= 0x20 && cp <= 0x7e) return true;
  if (cp >= 0xa0 && cp <= 0xff) return true;
  return WIN_ANSI_LATIN.has(cp);
}

/** What the built-in fonts can draw; `▶` becomes `»` and everything else unencodable `?`. */
export function pdfSafe(text: string): string {
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp === 0x25b6) out += '\u00bb';
    else if (cp === 0x09 || cp === 0x0a) out += ' ';
    else if (cp === 0x0d) continue;
    else out += encodable(cp) ? ch : '?';
  }
  return out;
}

function helix(bold: boolean, italic: boolean): string {
  if (bold && italic) return 'Helvetica-BoldOblique';
  if (bold) return 'Helvetica-Bold';
  if (italic) return 'Helvetica-Oblique';
  return 'Helvetica';
}

function courier(bold: boolean, italic: boolean): string {
  if (bold && italic) return 'Courier-BoldOblique';
  if (bold) return 'Courier-Bold';
  if (italic) return 'Courier-Oblique';
  return 'Courier';
}

type TextAtom = {
  kind: 'text';
  text: string;
  font: string;
  size: number;
  width: number;
  href: string | null;
  strike: boolean;
};

type Atom =
  | TextAtom
  | { kind: 'space'; width: number }
  | { kind: 'break' }
  | { kind: 'censor'; width: number; size: number }
  | { kind: 'check'; checked: boolean; width: number };

interface InlineOptions {
  size: number;
  bold: boolean;
  italic: boolean;
}

function atomWidth(atom: Atom): number {
  switch (atom.kind) {
    case 'text':
    case 'space':
    case 'censor':
    case 'check':
      return atom.width;
    default:
      return 0;
  }
}

class PdfRenderer {
  private y: number;
  private colourValue = TEXT_COLOR;
  private readonly spaceWidths = new Map<string, number>();
  private readonly prepared: Map<string, PreparedImage>;
  private linkAnnotations = 0;
  private readonly maxLinkAnnotations: number;

  constructor(
    private readonly doc: PdfDoc,
    private readonly ctx: PdfContext,
    private readonly opts: PdfRenderOptions = {},
  ) {
    this.y = doc.page.margins.top;
    this.prepared = ctx.prepared ?? new Map();
    this.maxLinkAnnotations = opts.maxLinkAnnotations ?? DEFAULT_MAX_LINK_ANNOTATIONS;
  }

  render(title: string, blocks: readonly Block[]): void {
    const cleanTitle = title.replace(/\s+/g, ' ').trim();
    if (cleanTitle)
      this.writeInline(
        [{ kind: 'text', text: cleanTitle }],
        { size: 22, bold: true, italic: false },
        0,
        14,
      );
    this.blocks(blocks, { indent: 0, italic: false, listLevel: 0 });
    this.doc.end();
  }

  private get left(): number {
    return this.doc.page.margins.left;
  }

  private get right(): number {
    return this.doc.page.width - this.doc.page.margins.right;
  }

  private get top(): number {
    return this.doc.page.margins.top;
  }

  private get bottom(): number {
    return this.doc.page.height - this.doc.page.margins.bottom;
  }

  private get width(): number {
    return this.right - this.left;
  }

  private measure(text: string, font: string, size: number): number {
    this.doc.font(font).fontSize(size);
    return this.doc.widthOfString(text);
  }

  private space(font: string, size: number): number {
    const key = `${font}:${size}`;
    const cached = this.spaceWidths.get(key);
    if (cached !== undefined) return cached;
    const width = this.measure(' ', font, size);
    this.spaceWidths.set(key, width);
    return width;
  }

  private colour(value: string): void {
    if (this.colourValue === value) return;
    this.colourValue = value;
    this.doc.fillColor(value);
  }

  private fillRect(x: number, y: number, width: number, height: number, colour: string): void {
    this.doc.rect(x, y, width, height).fill(colour);
    this.colourValue = colour;
    this.colour(TEXT_COLOR);
  }

  private ensure(height: number): void {
    if (this.y + height <= this.bottom) return;
    this.addPage();
  }

  private addPage(): void {
    this.doc.addPage();
    this.y = this.top;
  }

  /** Text runs to atoms: words, spaces, hard breaks, censor bars and task checkboxes. */
  private atomize(runs: readonly Run[], opts: InlineOptions): Atom[] {
    const atoms: Atom[] = [];
    const push = (atom: Atom) => {
      const last = atoms[atoms.length - 1];
      if (atom.kind === 'space' && (!last || last.kind === 'space' || last.kind === 'break'))
        return;
      atoms.push(atom);
    };
    for (const run of runs) {
      if (run.kind === 'break') {
        atoms.push({ kind: 'break' });
        continue;
      }
      if (run.kind === 'image') {
        const name = run.alt || (run.fileId ? this.ctx.fileNames.get(run.fileId) : null) || 'file';
        const font = helix(opts.bold, opts.italic);
        push(this.textAtom(pdfSafe(`[image: ${name}]`), font, opts.size, null, false));
        continue;
      }
      if (run.censor) {
        push({ kind: 'censor', width: opts.size * 2.5, size: opts.size });
        continue;
      }
      const font =
        run.code === true
          ? courier(opts.bold || run.bold === true, opts.italic || run.italic === true)
          : helix(opts.bold || run.bold === true, opts.italic || run.italic === true);
      const href = run.href ?? null;
      // A note-file link has no destination outside the app, so it shows the file's name.
      const text = run.fileId ? (this.ctx.fileNames.get(run.fileId) ?? run.text) : run.text;
      for (const part of pdfSafe(text).split(/(\s+)/)) {
        if (part === '') continue;
        if (/^\s+$/.test(part)) push({ kind: 'space', width: this.space(font, opts.size) });
        else push(this.textAtom(part, font, opts.size, href, run.strike === true));
      }
    }
    return atoms;
  }

  private textAtom(
    text: string,
    font: string,
    size: number,
    href: string | null,
    strike: boolean,
  ): TextAtom {
    return { kind: 'text', text, font, size, width: this.measure(text, font, size), href, strike };
  }

  /** Greedy word wrapping; a word wider than the line is split by character. */
  private wrap(atoms: readonly Atom[], width: number): Atom[][] {
    const lines: Atom[][] = [];
    let line: Atom[] = [];
    let used = 0;
    const flush = () => {
      while (line.length > 0 && line[line.length - 1]?.kind === 'space') line.pop();
      lines.push(line);
      line = [];
      used = 0;
    };
    for (const atom of atoms) {
      if (atom.kind === 'break') {
        flush();
        continue;
      }
      if (atom.kind === 'space') {
        if (line.length === 0) continue;
        line.push(atom);
        used += atom.width;
        continue;
      }
      if (used + atom.width > width && line.length > 0) flush();
      if (atom.kind === 'text' && atom.width > width && atom.text.length > 1) {
        for (const chunk of this.splitWord(atom, width)) {
          if (used + chunk.width > width && line.length > 0) flush();
          line.push(chunk);
          used += chunk.width;
        }
        continue;
      }
      line.push(atom);
      used += atom.width;
    }
    if (line.length > 0 || lines.length === 0) flush();
    return lines;
  }

  /** Split one over-wide word by character, measuring each character once (linear). */
  private splitWord(atom: TextAtom, width: number): TextAtom[] {
    const chunks: TextAtom[] = [];
    let text = '';
    let used = 0;
    for (const ch of atom.text) {
      const next = this.measure(ch, atom.font, atom.size);
      if (text !== '' && used + next > width) {
        chunks.push({ ...atom, text, width: used });
        text = ch;
        used = next;
      } else {
        text += ch;
        used += next;
      }
    }
    if (text !== '') chunks.push({ ...atom, text, width: used });
    return chunks;
  }

  /**
   * Draw one line of atoms at `x`, `y`. Link annotations are coalesced: a contiguous run of
   * atoms with the same destination (spaces included) becomes one annotation, not one per word.
   */
  private draw(atoms: readonly Atom[], x: number, y: number, lineHeight: number): number {
    let cursor = x;
    let run: { href: string; x: number } | null = null;
    const flushLink = (end: number) => {
      if (!run) return;
      if (this.linkAnnotations >= this.maxLinkAnnotations)
        throw new TooLargeError(
          `PDF would need more than ${this.maxLinkAnnotations} link annotations`,
        );
      this.linkAnnotations++;
      this.doc.link(run.x, y, Math.max(1, end - run.x), lineHeight, run.href);
      run = null;
    };
    for (const atom of atoms) {
      if (atom.kind === 'space') {
        cursor += atom.width;
        continue;
      }
      if (atom.kind === 'break') continue;
      const href = atom.kind === 'text' ? atom.href : null;
      if (run && run.href !== href) flushLink(cursor);
      if (!run && href) run = { href, x: cursor };
      if (atom.kind === 'censor') {
        this.fillRect(cursor, y + atom.size * 0.15, atom.width, atom.size * 0.72, TEXT_COLOR);
        cursor += atom.width;
        continue;
      }
      if (atom.kind === 'check') {
        if (atom.checked) this.fillRect(cursor, y + 2, 8, 8, TEXT_COLOR);
        else {
          this.doc
            .lineWidth(0.7)
            .rect(cursor, y + 2, 8, 8)
            .stroke('#333333');
          this.colour(TEXT_COLOR);
        }
        cursor += atom.width;
        continue;
      }
      this.colour(atom.href ? LINK_COLOR : TEXT_COLOR);
      this.doc.font(atom.font).fontSize(atom.size);
      this.doc.text(atom.text, cursor, y, {
        lineBreak: false,
        ...(atom.href ? { underline: true } : {}),
        ...(atom.strike ? { strike: true } : {}),
      });
      cursor += atom.width;
    }
    flushLink(cursor);
    this.colour(TEXT_COLOR);
    return cursor;
  }

  /** Runs at `indent`, wrapped to the text column; used for headings, paragraphs and items. */
  private writeInline(
    runs: readonly Run[],
    opts: InlineOptions,
    indent: number,
    after: number,
    bullet?: { atoms: Atom[]; width: number },
  ): void {
    const markerWidth = bullet?.width ?? 0;
    const lines = this.wrap(
      this.atomize(runs, opts),
      Math.max(40, this.width - indent - markerWidth),
    );
    const lineHeight = Math.round(opts.size * LINE_FACTOR);
    lines.forEach((line, index) => {
      this.ensure(lineHeight);
      if (index === 0 && bullet) this.draw(bullet.atoms, this.left + indent, this.y, lineHeight);
      this.draw(line, this.left + indent + markerWidth, this.y, lineHeight);
      this.y += lineHeight;
    });
    this.y += after;
  }

  private blocks(
    blocks: readonly Block[],
    opts: { indent: number; italic: boolean; listLevel: number },
  ): void {
    for (const block of blocks) this.block(block, opts);
  }

  private block(block: Block, opts: { indent: number; italic: boolean; listLevel: number }): void {
    this.opts.deadline?.check();
    switch (block.type) {
      case 'heading': {
        if (this.y > this.top) this.y += 10;
        const size = HEADING_SIZES[Math.min(6, Math.max(1, block.level)) - 1] ?? BODY_SIZE;
        this.writeInline(block.runs, { size, bold: true, italic: opts.italic }, opts.indent, 8);
        break;
      }
      case 'paragraph':
        this.writeInline(
          block.runs,
          { size: BODY_SIZE, bold: false, italic: opts.italic },
          opts.indent,
          6,
        );
        break;
      case 'quote':
        this.blocks(block.blocks, { ...opts, indent: opts.indent + 18, italic: true });
        break;
      case 'code':
        this.code(block.text, opts.indent);
        break;
      case 'list':
        this.list(block, opts.indent, opts.listLevel, opts.italic);
        break;
      case 'table':
        this.table(block);
        break;
      case 'hr': {
        this.ensure(12);
        this.y += 4;
        this.doc
          .lineWidth(0.7)
          .moveTo(this.left + opts.indent, this.y)
          .lineTo(this.right, this.y)
          .stroke('#C0C0C0');
        this.y += 8;
        break;
      }
      case 'image':
        this.image(block, opts.indent, opts.italic);
        break;
      case 'embed': {
        const runs: Run[] = [
          { kind: 'text', text: '» ' },
          { kind: 'text', text: block.label, href: block.openUrl },
          { kind: 'text', text: ' — ' },
          { kind: 'text', text: block.openUrl, href: block.openUrl },
        ];
        this.writeInline(
          runs,
          { size: BODY_SIZE, bold: false, italic: opts.italic },
          opts.indent,
          6,
        );
        break;
      }
      default:
        break;
    }
  }

  private code(text: string, indent: number): void {
    const lineHeight = Math.round(CODE_SIZE * LINE_FACTOR);
    const width = this.width - indent - 12;
    // One atom per line, so the indentation of code is not collapsed into a single space.
    for (const raw of text.replace(/\n$/, '').split('\n')) {
      const line = pdfSafe(raw);
      const atom = this.textAtom(line === '' ? ' ' : line, 'Courier', CODE_SIZE, null, false);
      const chunks = atom.width > width ? this.splitWord(atom, width) : [atom];
      for (const chunk of chunks) {
        this.ensure(lineHeight);
        this.draw([chunk], this.left + indent + 12, this.y, lineHeight);
        this.y += lineHeight;
      }
    }
    this.y += 6;
  }

  private list(block: ListBlock, indent: number, level: number, italic: boolean): void {
    block.items.forEach((item, index) => {
      let markerAtoms: Atom[];
      let markerWidth: number;
      if (block.ordered) {
        markerAtoms = [
          this.textAtom(`${block.start + index}. `, helix(false, false), BODY_SIZE, null, false),
        ];
        markerWidth = markerAtoms.reduce((sum, atom) => sum + atomWidth(atom), 0);
      } else if (item.checked !== null) {
        markerAtoms = [{ kind: 'check', checked: item.checked, width: 14 }];
        markerWidth = 14;
      } else {
        markerAtoms = [this.textAtom('\u2022 ', helix(false, false), BODY_SIZE, null, false)];
        markerWidth = markerAtoms.reduce((sum, atom) => sum + atomWidth(atom), 0);
      }
      const rest = [...item.blocks];
      const first = rest.shift();
      if (first?.type === 'paragraph') {
        this.writeInline(first.runs, { size: BODY_SIZE, bold: false, italic }, indent, 4, {
          atoms: markerAtoms,
          width: markerWidth,
        });
      } else {
        this.ensure(BODY_SIZE * LINE_FACTOR);
        this.draw(markerAtoms, this.left + indent, this.y, Math.round(BODY_SIZE * LINE_FACTOR));
        this.y += BODY_SIZE * LINE_FACTOR;
        if (first) rest.unshift(first);
      }
      for (const inner of rest)
        this.block(inner, { indent: indent + markerWidth, italic, listLevel: level + 1 });
    });
    this.y += 4;
  }

  /** Atoms for one table cell, wrapped to its column. */
  private cellLines(runs: readonly Run[], width: number, head: boolean): Atom[][] {
    return this.wrap(
      this.atomize(runs, { size: BODY_SIZE, bold: head, italic: false }),
      Math.max(12, width - TABLE_PAD * 2),
    );
  }

  /**
   * Column widths from the content: each column asks for its natural width, clamped between a
   * minimum (a column of `1`s still needs room for `1`) and 60 % of the text column (one long
   * cell must not squeeze every other column to nothing), then the table is scaled to fill the
   * text column.
   */
  private tableWidths(block: Extract<Block, { type: 'table' }>, columns: number): number[] {
    const maximum = Math.max(TABLE_MIN_COLUMN, this.width * 0.6);
    const natural = Array.from({ length: columns }, () => TABLE_MIN_COLUMN);
    const measureRow = (cells: readonly Run[][], head: boolean) => {
      for (let index = 0; index < columns; index++) {
        const atoms = this.atomize(cells[index] ?? [], {
          size: BODY_SIZE,
          bold: head,
          italic: false,
        });
        const used = atoms.reduce((sum, atom) => sum + atomWidth(atom), 0);
        const width = Math.min(maximum, used + TABLE_PAD * 2);
        natural[index] = Math.max(natural[index] ?? TABLE_MIN_COLUMN, width);
      }
    };
    measureRow(block.header, true);
    for (const row of block.rows) measureRow(row, false);
    const total = natural.reduce((sum, value) => sum + value, 0) || 1;
    const scale = this.width / total;
    const widths = natural.map((value) => Math.max(TABLE_MIN_COLUMN, Math.floor(value * scale)));
    const used = widths.reduce((sum, value) => sum + value, 0);
    // Rounding leaves a pixel or two over; give it to the widest column so the table is square.
    let widest = 0;
    for (let index = 1; index < columns; index++)
      if ((widths[index] ?? 0) > (widths[widest] ?? 0)) widest = index;
    widths[widest] = Math.max(1, (widths[widest] ?? 0) + (this.width - used));
    return widths;
  }

  /** One row segment (a full row, or the part of one that fits) with its box and grid lines. */
  private tableSegment(
    cells: readonly Atom[][][],
    widths: readonly number[],
    from: number,
    count: number,
    head: boolean,
    lineHeight: number,
  ): void {
    const height = count * lineHeight + TABLE_PAD * 2;
    if (head) this.fillRect(this.left, this.y, this.width, height, '#F2F2F2');
    let x = this.left;
    for (let index = 0; index < widths.length; index++) {
      const lines = (cells[index] ?? []).slice(from, from + count);
      lines.forEach((line, offset) =>
        this.draw(line, x + TABLE_PAD, this.y + TABLE_PAD + offset * lineHeight, lineHeight),
      );
      x += widths[index] ?? 0;
    }
    this.doc.lineWidth(0.5).strokeColor('#B0B0B0');
    this.doc.rect(this.left, this.y, this.width, height).stroke();
    let gridX = this.left;
    for (let index = 0; index < widths.length - 1; index++) {
      gridX += widths[index] ?? 0;
      this.doc
        .moveTo(gridX, this.y)
        .lineTo(gridX, this.y + height)
        .stroke();
    }
    this.colourValue = TEXT_COLOR;
    this.y += height;
  }

  /**
   * A table: wrapped cells in content-sized columns, rows broken across pages (the box is drawn
   * per segment) and the header row repeated at the top of every page the table continues on.
   */
  private table(block: Extract<Block, { type: 'table' }>): void {
    const columns = Math.max(1, block.header.length, ...block.rows.map((row) => row.length));
    const widths = this.tableWidths(block, columns);
    const lineHeight = Math.round(BODY_SIZE * LINE_FACTOR);
    const prepare = (cells: readonly Run[][], head: boolean) =>
      Array.from({ length: columns }, (_, index) =>
        this.cellLines(cells[index] ?? [], widths[index] ?? this.width, head),
      );
    const header = prepare(block.header, true);
    const headerLines = Math.max(1, ...header.map((cell) => cell.length));
    const repeatHeader = () => {
      // A header taller than a page cannot be repeated without looping; skip it there.
      if (headerLines * lineHeight + TABLE_PAD * 2 > this.bottom - this.top) return;
      this.tableSegment(header, widths, 0, headerLines, true, lineHeight);
    };
    this.ensure(headerLines * lineHeight + TABLE_PAD * 2);
    this.tableSegment(header, widths, 0, headerLines, true, lineHeight);
    for (const row of block.rows) {
      const cells = prepare(row, false);
      const total = Math.max(1, ...cells.map((cell) => cell.length));
      let from = 0;
      let fresh = false;
      while (from < total) {
        let room = Math.floor((this.bottom - this.y - TABLE_PAD * 2) / lineHeight);
        if (room < 1) {
          if (fresh)
            room = 1; // a page too short for one line: draw it rather than loop
          else {
            this.addPage();
            repeatHeader();
            fresh = true;
            continue;
          }
        }
        const take = Math.min(total - from, room);
        this.tableSegment(cells, widths, from, take, false, lineHeight);
        from += take;
        fresh = false;
        if (from < total) {
          this.addPage();
          repeatHeader();
          fresh = true;
        }
      }
      this.opts.deadline?.check();
    }
    this.y += 8;
  }

  /** The file's prepared PDF image, opened once per file so repeated placements reuse it. */
  private preparedImage(image: LoadedImage): PreparedImage | null {
    const cached = this.prepared.get(image.id);
    if (cached) return cached;
    // Last line of defence: pdfkit MUST NOT see a PNG of the alpha/indexed-transparency/
    // interlaced class that png-js inflates inside a zlib callback. The loader already filtered,
    // but a caller need not have.
    if (!validateImage(image.bytes, 'pdf')) return null;
    // `openImage` is pdfkit's own parser entry point; the validated class never inflates here.
    const opened = (this.doc as PdfDocRuntime).openImage(image.bytes);
    this.prepared.set(image.id, opened);
    return opened;
  }

  private imageText(alt: string, fileId: string | null, indent: number, italic: boolean): void {
    const name = alt || (fileId ? this.ctx.fileNames.get(fileId) : null) || 'file';
    this.writeInline(
      [{ kind: 'text', text: `[image: ${name}]` }],
      { size: BODY_SIZE, bold: false, italic },
      indent,
      6,
    );
  }

  private image(block: Extract<Block, { type: 'image' }>, indent: number, italic: boolean): void {
    const image = block.fileId ? this.ctx.images.get(block.fileId) : undefined;
    if (!image) {
      this.imageText(block.alt, block.fileId, indent, italic);
      return;
    }
    const maxWidth = Math.max(40, this.width - indent);
    const maxHeight = this.bottom - this.top - 30;
    const ratio = Math.min(1, maxWidth / image.width, maxHeight / image.height);
    const width = Math.max(1, image.width * ratio);
    const height = Math.max(1, image.height * ratio);
    this.ensure(height + 12);
    const prepared = this.preparedImage(image);
    if (!prepared) {
      this.imageText(block.alt, block.fileId, indent, italic);
      return;
    }
    try {
      this.doc.image(
        prepared as unknown as Buffer,
        this.left + indent + (maxWidth - width) / 2,
        this.y,
        { width, height },
      );
      this.y += height + 12;
    } catch {
      // pdfkit refused the bytes. A picture is not worth losing the export over, so the reader
      // gets the name instead.
      this.imageText(block.alt, block.fileId, indent, italic);
    }
  }
}

/** Render a note as a PDF stream. Images must already be loaded and validated. */
export function buildPdf(
  title: string,
  blocks: readonly Block[],
  ctx: PdfContext,
  opts: PdfRenderOptions = {},
): Readable {
  const doc = new createPdfDocument({
    size: 'A4',
    margins: { top: 56.7, bottom: 56.7, left: 56.7, right: 56.7 },
    compress: opts.compress ?? true,
    info: { Title: title, Author: 'BokyDo', Creator: 'BokyDo' },
  });
  // A pdfkit error must never be an unhandled 'error' event on a stream nothing is reading yet;
  // the route listens too and destroys the response.
  doc.on('error', () => undefined);
  try {
    new PdfRenderer(doc, ctx, opts).render(title, blocks);
  } catch (err) {
    doc.destroy();
    throw err;
  }
  return doc as unknown as Readable;
}
