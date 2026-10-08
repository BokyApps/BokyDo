import { describe, expect, it } from 'vitest';
import { parseHeaderLines } from './ai-headers.js';

describe('parseHeaderLines', () => {
  it('sends nothing when the box is empty, so stored headers are left alone', () => {
    expect(parseHeaderLines('')).toBeUndefined();
    expect(parseHeaderLines('   \n\t\n  ')).toBeUndefined();
  });

  it('reads one header per line and trims the parts', () => {
    expect(parseHeaderLines('X-Organisation:  team-name ')).toEqual({
      'X-Organisation': 'team-name',
    });
    expect(parseHeaderLines('  X-A : 1 \n X-B: two  ')).toEqual({ 'X-A': '1', 'X-B': 'two' });
  });

  it('splits on the first colon only, so values may contain colons', () => {
    expect(parseHeaderLines('Authorization: Bearer a:b:c')).toEqual({
      Authorization: 'Bearer a:b:c',
    });
  });

  it('keeps a line with no colon as an empty value instead of dropping it', () => {
    // The server accepts an empty value, and silently dropping the line would hide the typo.
    expect(parseHeaderLines('NoColon')).toEqual({ NoColon: '' });
  });
});
