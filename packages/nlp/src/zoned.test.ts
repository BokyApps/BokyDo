import { describe, expect, it } from 'vitest';
import { localNow, zonedInstant } from './calendar.js';

const iso = (ms: number) => new Date(ms).toISOString().slice(0, 16);

describe('zonedInstant', () => {
  it.each([
    ['2026-06-15', '09:00', 'UTC', '2026-06-15T09:00'],
    ['2026-06-15', '09:00', 'Asia/Phnom_Penh', '2026-06-15T02:00'],
    ['2026-06-15', '09:00', 'Asia/Kolkata', '2026-06-15T03:30'],
    ['2026-06-15', '09:00', 'America/New_York', '2026-06-15T13:00'],
    ['2026-01-15', '09:00', 'America/New_York', '2026-01-15T14:00'],
    ['2026-01-01', '00:30', 'Pacific/Kiritimati', '2025-12-31T10:30'],
    ['2026-01-01', '23:30', 'Pacific/Pago_Pago', '2026-01-02T10:30'],
    // Spring forward (02:00 → 03:00): 02:30 doesn't exist and moves on to 03:30 EDT.
    ['2026-03-08', '02:30', 'America/New_York', '2026-03-08T07:30'],
    // Fall back: 01:30 happens twice; the first (EDT) wins.
    ['2026-11-01', '01:30', 'America/New_York', '2026-11-01T05:30'],
    ['2026-10-25', '02:30', 'Europe/Berlin', '2026-10-25T00:30'],
    ['2026-06-15', '09:00', 'Not/AZone', '2026-06-15T09:00'],
  ])('%s %s in %s', (date, time, zone, expected) => {
    expect(iso(zonedInstant(date, time, zone))).toBe(expected);
  });

  it('round-trips with localNow for every quarter hour of a DST year', () => {
    for (const zone of ['Europe/London', 'Australia/Lord_Howe', 'America/Santiago']) {
      for (let ms = Date.UTC(2026, 0, 1); ms < Date.UTC(2027, 0, 1); ms += 15 * 60_000 * 97) {
        const local = localNow(zone, new Date(ms));
        const back = zonedInstant(local.date, local.time, zone);
        // Repeated hours resolve to the first occurrence, never more than an hour early.
        expect(ms - back).toBeGreaterThanOrEqual(0);
        expect(ms - back).toBeLessThanOrEqual(3600_000);
        expect(localNow(zone, new Date(back))).toEqual(local);
      }
    }
  });
});
