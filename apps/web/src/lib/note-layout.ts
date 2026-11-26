/**
 * Per-device layout choices for notes: each card's size and place on the board, and whether an
 * opened note fills the whole window. They live in localStorage because they describe this screen (a phone and
 * a desktop want different card sizes), not the note, so they are never synced or saved with it.
 */

const SIZES_KEY = 'bokydo.notes.cardSizes';
const FULL_SCREEN_KEY = 'bokydo.notes.fullScreen';
const ORDER_KEY = 'bokydo.notes.order';
/** Old entries for deleted notes are dropped once the map grows past this. */
const MAX_SIZES = 500;
/** The board order remembers at most this many notes; any beyond fall back to newest first. */
const MAX_ORDER = 2000;

export interface CardSize {
  width: number;
  height: number;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readSizes(): Record<string, CardSize> {
  try {
    const raw: unknown = JSON.parse(storage()?.getItem(SIZES_KEY) ?? '{}');
    return raw && typeof raw === 'object' ? (raw as Record<string, CardSize>) : {};
  } catch {
    return {};
  }
}

const validSize = (value: unknown): value is CardSize => {
  if (!value || typeof value !== 'object') return false;
  const { width, height } = value as Partial<CardSize>;
  return (
    typeof width === 'number' &&
    typeof height === 'number' &&
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width >= 120 &&
    height >= 80 &&
    width <= 4000 &&
    height <= 4000
  );
};

/** The size this card was last resized to on this device, or null for the default size. */
export function readCardSize(noteId: string): CardSize | null {
  const size = readSizes()[noteId];
  return validSize(size) ? { width: size.width, height: size.height } : null;
}

export function saveCardSize(noteId: string, size: CardSize): void {
  if (!validSize(size)) return;
  // Insertion order is recency order: this card moves to the end and the oldest entries drop off.
  const entries = Object.entries(readSizes()).filter(([id]) => id !== noteId);
  entries.push([noteId, { width: Math.round(size.width), height: Math.round(size.height) }]);
  const sizes = Object.fromEntries(entries.slice(-MAX_SIZES));
  try {
    storage()?.setItem(SIZES_KEY, JSON.stringify(sizes));
  } catch {
    // A full or blocked storage only loses the remembered size.
  }
}

export function readNoteFullScreen(): boolean {
  return storage()?.getItem(FULL_SCREEN_KEY) === '1';
}

export function saveNoteFullScreen(full: boolean): void {
  try {
    if (full) storage()?.setItem(FULL_SCREEN_KEY, '1');
    else storage()?.removeItem(FULL_SCREEN_KEY);
  } catch {
    // Only the preference is lost.
  }
}

/** The order the cards were dragged into on this device, first card first. */
export function readNoteOrder(): string[] {
  try {
    const raw: unknown = JSON.parse(storage()?.getItem(ORDER_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export function saveNoteOrder(ids: string[]): void {
  try {
    storage()?.setItem(ORDER_KEY, JSON.stringify(ids.slice(0, MAX_ORDER)));
  } catch {
    // Only the arrangement is lost.
  }
}
