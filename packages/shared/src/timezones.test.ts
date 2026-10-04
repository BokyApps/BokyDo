import { describe, expect, it } from 'vitest';
import {
  ABBREVIATIONS,
  canonicalTimeZone,
  CITY_ALIASES,
  describeZone,
  isKnownTimeZone,
  parseOffsetQuery,
  searchTimeZones,
} from './timezones.js';

const ids = (q: string) =>
  searchTimeZones(q, { now: new Date('2026-01-15T12:00:00Z') }).map((z) => z.id);

describe('time-zone search', () => {
  it('finds zones by city, country, and cities that share a zone', () => {
    expect(ids('phnom')[0]).toBe('Asia/Phnom_Penh');
    expect(ids('cambodia')[0]).toBe('Asia/Phnom_Penh');
    expect(ids('cape town')[0]).toBe('Africa/Johannesburg');
    expect(ids('south africa')).toContain('Africa/Johannesburg');
    expect(ids('mumbai')[0]).toBe('Asia/Kolkata');
    expect(ids('san francisco')[0]).toBe('America/Los_Angeles');
    expect(ids('zürich')[0]).toBe('Europe/Zurich');
  });

  it('understands abbreviations and offsets', () => {
    expect(ids('SAST')[0]).toBe('Africa/Johannesburg');
    expect(ids('ict')).toEqual(expect.arrayContaining(['Asia/Phnom_Penh', 'Asia/Bangkok']));
    for (const q of ['+7', 'utc+7', 'GMT+07:00', 'UTC +7'])
      expect(ids(q), q).toContain('Asia/Phnom_Penh');
    expect(ids('+5:30')).toContain('Asia/Kolkata');
    expect(ids('-5')).toContain('America/New_York'); // January: EST
    expect(ids('utc')[0]).toBe('UTC');
  });

  it('accepts the IANA name itself', () => {
    expect(ids('Asia/Phnom_Penh')[0]).toBe('Asia/Phnom_Penh');
  });

  it('describes a zone with its current offset and local time', () => {
    const z = describeZone('Asia/Phnom_Penh', new Date('2026-01-15T12:00:00Z'));
    expect(z).toMatchObject({
      city: 'Phnom Penh',
      country: 'Cambodia',
      offsetLabel: 'UTC+07:00',
      localTime: '19:00',
    });
  });

  it('parses offsets defensively', () => {
    expect(parseOffsetQuery('+7')).toBe(420);
    expect(parseOffsetQuery('−3:30')).toBe(-210);
    expect(parseOffsetQuery('+99')).toBeNull();
    expect(parseOffsetQuery('7')).toBeNull();
  });

  it('maps runtime names to canonical ones', () => {
    expect(canonicalTimeZone('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(canonicalTimeZone('Not/AZone')).toBeNull();
  });

  it('only aliases to real zones', () => {
    for (const z of [...Object.values(CITY_ALIASES), ...Object.values(ABBREVIATIONS).flat()]) {
      expect(isKnownTimeZone(z), z).toBe(true);
    }
  });
});
