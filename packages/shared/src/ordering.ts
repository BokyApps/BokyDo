/* eslint-disable @typescript-eslint/no-non-null-assertion --
   String indexing below is bounds-checked by construction (validated keys, known digit set). */
/**
 * Fractional order keys for drag-and-drop ordering (projects, sections, tasks, labels, filters).
 * Any two keys have a key between them, so a move rewrites one row and concurrent moves from
 * different clients never require renumbering. Keys compare with plain byte order (JS `<`,
 * Postgres `COLLATE "C"`).
 *
 * Format (same scheme as rocicorp/fractional-indexing): an "integer" part whose length is encoded
 * by its first character (a–z: 2–27 chars, A–Z: 27–2 chars) followed by an optional fractional
 * part with no trailing zero. Appending keeps keys short (a0, a1, … az, b00, …).
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const ZERO = DIGITS[0]!;
const SMALLEST_INTEGER = 'A' + ZERO.repeat(26);
export const ORDER_KEY_MAX_LENGTH = 64;

export function generateKeyBetween(a: string | null, b: string | null): string {
  if (a !== null) assertValidOrderKey(a);
  if (b !== null) assertValidOrderKey(b);
  if (a !== null && b !== null && a >= b) throw new Error(`Order keys out of order: ${a} >= ${b}`);

  if (a === null) {
    if (b === null) return 'a' + ZERO;
    const ib = integerPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INTEGER) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const res = decrementInteger(ib);
    if (res === null) throw new Error('Cannot generate a key before the smallest key');
    return res;
  }

  if (b === null) {
    const ia = integerPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInteger(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }

  const ia = integerPart(a);
  const fa = a.slice(ia.length);
  const ib = integerPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = incrementInteger(ia);
  if (i === null) throw new Error('Cannot increment the largest key');
  if (i < b) return i;
  return ia + midpoint(fa, null);
}

/** `n` evenly usable keys between a and b (e.g. for inserting a pasted list of tasks). */
export function generateNKeysBetween(a: string | null, b: string | null, n: number): string[] {
  const keys: string[] = [];
  let prev = a;
  for (let i = 0; i < n; i++) {
    prev = generateKeyBetween(prev, b);
    keys.push(prev);
  }
  return keys;
}

export function isValidOrderKey(key: string): boolean {
  try {
    assertValidOrderKey(key);
    return true;
  } catch {
    return false;
  }
}

function assertValidOrderKey(key: string): void {
  if (key.length === 0 || key.length > ORDER_KEY_MAX_LENGTH)
    throw new Error('Invalid order key length');
  for (const ch of key) if (!DIGITS.includes(ch)) throw new Error('Invalid order key character');
  if (key === SMALLEST_INTEGER) throw new Error('Reserved order key');
  const i = integerPart(key);
  const f = key.slice(i.length);
  if (f.endsWith(ZERO)) throw new Error('Order key has a trailing zero');
}

function integerLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 'a'.charCodeAt(0) + 2;
  if (head >= 'A' && head <= 'Z') return 'Z'.charCodeAt(0) - head.charCodeAt(0) + 2;
  throw new Error('Invalid order key head');
}

function integerPart(key: string): string {
  const len = integerLength(key[0]!);
  if (len > key.length) throw new Error('Invalid order key');
  return key.slice(0, len);
}

/** A string strictly between fractional parts a and b (b === null means "1"). */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error('midpoint: a >= b');
  if (a.endsWith(ZERO) || (b !== null && b.endsWith(ZERO)))
    throw new Error('midpoint: trailing zero');
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a ? DIGITS.indexOf(a[0]!) : 0;
  const digitB = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (digitB - digitA > 1) return DIGITS[Math.round(0.5 * (digitA + digitB))]!;
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return DIGITS[digitA]! + midpoint(a.slice(1), null);
}

function incrementInteger(x: string): string | null {
  const [head, ...digs] = x.split('') as [string, ...string[]];
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) + 1;
    if (d === DIGITS.length) digs[i] = ZERO;
    else {
      digs[i] = DIGITS[d]!;
      carry = false;
    }
  }
  if (!carry) return head + digs.join('');
  if (head === 'Z') return 'a' + ZERO;
  if (head === 'z') return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > 'a') digs.push(ZERO);
  else digs.pop();
  return h + digs.join('');
}

function decrementInteger(x: string): string | null {
  const [head, ...digs] = x.split('') as [string, ...string[]];
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) - 1;
    if (d === -1) digs[i] = DIGITS.at(-1)!;
    else {
      digs[i] = DIGITS[d]!;
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join('');
  if (head === 'a') return 'Z' + DIGITS.at(-1)!;
  if (head === 'A') return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < 'Z') digs.push(DIGITS.at(-1)!);
  else digs.pop();
  return h + digs.join('');
}
