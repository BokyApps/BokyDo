import { describe, expect, it } from 'vitest';
import { announcementsFor, dayName, taskName } from './dnd-announcements.js';

const names: Record<string, string> = {
  a: taskName('Buy milk'),
  b: taskName('Call Sam'),
  col: 'the column “Done”',
};
const say = announcementsFor((id) => names[String(id)] ?? null);
const ev = (active: string, over?: string) =>
  ({ active: { id: active }, over: over ? { id: over } : null }) as never;

describe('drag announcements', () => {
  it('say what moved and where, in words', () => {
    expect(say.onDragStart?.(ev('a'))).toBe('Picked up “Buy milk”.');
    expect(say.onDragOver?.(ev('a', 'b'))).toBe('“Buy milk” is over “Call Sam”.');
    expect(say.onDragOver?.(ev('a', 'col'))).toBe('“Buy milk” is over the column “Done”.');
    expect(say.onDragEnd?.(ev('a', 'b'))).toBe('Dropped “Buy milk” on “Call Sam”.');
    expect(say.onDragCancel?.(ev('a'))).toBe('Cancelled. “Buy milk” was not moved.');
  });

  it('cope with nowhere to drop and with ids they do not know', () => {
    expect(say.onDragOver?.(ev('a'))).toBe('“Buy milk” is not over a place it can go.');
    expect(say.onDragEnd?.(ev('a'))).toBe('“Buy milk” was dropped where it started.');
    expect(say.onDragStart?.(ev('2f042aea-0d04-4190-a732-d0cc66bd9560'))).toBe(
      'Picked up the item.',
    );
  });

  it('never read out an id', () => {
    const uuid = '2f042aea-0d04-4190-a732-d0cc66bd9560';
    for (const text of [
      say.onDragStart?.(ev(uuid)),
      say.onDragOver?.(ev(uuid, uuid)),
      say.onDragEnd?.(ev(uuid, uuid)),
    ])
      expect(String(text)).not.toContain(uuid);
  });

  it('shorten very long titles', () => {
    expect(taskName('x'.repeat(200)).length).toBeLessThan(70);
  });

  it('say a day the way people do', () => {
    expect(dayName('2030-03-06')).toMatch(/Wednesday/);
    expect(dayName('2030-03-06')).toMatch(/6/);
  });
});
