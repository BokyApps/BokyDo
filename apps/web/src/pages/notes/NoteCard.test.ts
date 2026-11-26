// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { readCardSize, saveCardSize } from '../../lib/note-layout.js';
import { stableOrder } from './NoteCard.js';

describe('stableOrder', () => {
  it('keeps cards in place when an edited note moves to the top of the server list', () => {
    expect(stableOrder(['a', 'b', 'c'], ['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('puts a new note where the server put it relative to the cards already shown', () => {
    // Pinned p1, p2 come first; the new note n is the newest unpinned one.
    expect(stableOrder(['p1', 'p2', 'a', 'b'], ['p1', 'p2', 'n', 'a', 'b'])).toEqual([
      'p1',
      'p2',
      'n',
      'a',
      'b',
    ]);
    expect(stableOrder(['a', 'b'], ['n', 'a', 'b'])).toEqual(['n', 'a', 'b']);
  });

  it('appends a loaded page and drops notes that left the list', () => {
    expect(stableOrder(['a', 'b'], ['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c', 'd']);
    expect(stableOrder(['a', 'b', 'c'], ['c', 'a'])).toEqual(['a', 'c']);
    expect(stableOrder([], ['x', 'y'])).toEqual(['x', 'y']);
  });
});

describe('card sizes', () => {
  afterEach(() => localStorage.clear());

  it('remembers a size per note and ignores nonsense', () => {
    expect(readCardSize('n1')).toBeNull();
    saveCardSize('n1', { width: 400.4, height: 300 });
    expect(readCardSize('n1')).toEqual({ width: 400, height: 300 });
    saveCardSize('n2', { width: 5, height: 300 });
    expect(readCardSize('n2')).toBeNull();
    localStorage.setItem('bokydo.notes.cardSizes', '{"n3":{"width":"wide","height":1}}');
    expect(readCardSize('n3')).toBeNull();
    localStorage.setItem('bokydo.notes.cardSizes', 'not json');
    expect(readCardSize('n1')).toBeNull();
  });
});
