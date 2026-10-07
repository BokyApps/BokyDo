import { describe, expect, it } from 'vitest';
import { pageTitle } from './page-title.js';

describe('pageTitle', () => {
  it('puts the page heading before the app name', () => {
    expect(pageTitle('Today')).toBe('Today – BokyDo');
    expect(pageTitle('  Moving   house \n')).toBe('Moving house – BokyDo');
  });

  it('falls back to the app name when there is no usable heading', () => {
    for (const h of [null, undefined, '', '   ', 'BokyDo', 'bokydo'])
      expect(pageTitle(h)).toBe('BokyDo');
  });

  it('keeps titles short', () => {
    const title = pageTitle('x'.repeat(200));
    expect(title.endsWith('… – BokyDo')).toBe(true);
    expect(title.length).toBeLessThan(100);
  });
});
