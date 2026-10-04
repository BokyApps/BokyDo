import { ZONE_COUNTRIES } from './timezones-data.js';

/**
 * Time-zone search for people who don't know IANA names: match by city, country, common
 * abbreviation, UTC offset, or the IANA name itself. Values are always canonical IANA names.
 */
export interface ZoneOption {
  id: string;
  city: string;
  country: string;
  countryCode: string;
  /** Minutes east of UTC right now. */
  offsetMinutes: number;
  /** e.g. "UTC+07:00" */
  offsetLabel: string;
  /** Local wall-clock time right now, e.g. "21:40". */
  localTime: string;
}

/** Big cities that share another city's zone. */
const CITY_ALIASES: Record<string, string> = {
  'cape town': 'Africa/Johannesburg',
  pretoria: 'Africa/Johannesburg',
  durban: 'Africa/Johannesburg',
  delhi: 'Asia/Kolkata',
  'new delhi': 'Asia/Kolkata',
  mumbai: 'Asia/Kolkata',
  bengaluru: 'Asia/Kolkata',
  bangalore: 'Asia/Kolkata',
  chennai: 'Asia/Kolkata',
  hyderabad: 'Asia/Kolkata',
  calcutta: 'Asia/Kolkata',
  beijing: 'Asia/Shanghai',
  guangzhou: 'Asia/Shanghai',
  shenzhen: 'Asia/Shanghai',
  hanoi: 'Asia/Ho_Chi_Minh',
  saigon: 'Asia/Ho_Chi_Minh',
  'siem reap': 'Asia/Phnom_Penh',
  osaka: 'Asia/Tokyo',
  kyoto: 'Asia/Tokyo',
  'abu dhabi': 'Asia/Dubai',
  islamabad: 'Asia/Karachi',
  lahore: 'Asia/Karachi',
  jeddah: 'Asia/Riyadh',
  mecca: 'Asia/Riyadh',
  edinburgh: 'Europe/London',
  manchester: 'Europe/London',
  glasgow: 'Europe/London',
  barcelona: 'Europe/Madrid',
  milan: 'Europe/Rome',
  munich: 'Europe/Berlin',
  frankfurt: 'Europe/Berlin',
  hamburg: 'Europe/Berlin',
  geneva: 'Europe/Zurich',
  'st petersburg': 'Europe/Moscow',
  rotterdam: 'Europe/Amsterdam',
  'the hague': 'Europe/Amsterdam',
  kiev: 'Europe/Kyiv',
  'san francisco': 'America/Los_Angeles',
  seattle: 'America/Los_Angeles',
  'san diego': 'America/Los_Angeles',
  'las vegas': 'America/Los_Angeles',
  portland: 'America/Los_Angeles',
  washington: 'America/New_York',
  boston: 'America/New_York',
  miami: 'America/New_York',
  atlanta: 'America/New_York',
  philadelphia: 'America/New_York',
  dallas: 'America/Chicago',
  houston: 'America/Chicago',
  austin: 'America/Chicago',
  minneapolis: 'America/Chicago',
  'salt lake city': 'America/Denver',
  montreal: 'America/Toronto',
  ottawa: 'America/Toronto',
  'rio de janeiro': 'America/Sao_Paulo',
  brasilia: 'America/Sao_Paulo',
  canberra: 'Australia/Sydney',
  wellington: 'Pacific/Auckland',
};

/** Common abbreviations (ambiguous ones list every zone they're used for). */
const ABBREVIATIONS: Record<string, string[]> = {
  SAST: ['Africa/Johannesburg'],
  CAT: ['Africa/Maputo', 'Africa/Harare'],
  EAT: ['Africa/Nairobi'],
  WAT: ['Africa/Lagos'],
  ICT: ['Asia/Bangkok', 'Asia/Phnom_Penh', 'Asia/Ho_Chi_Minh', 'Asia/Vientiane'],
  WIB: ['Asia/Jakarta'],
  SGT: ['Asia/Singapore'],
  HKT: ['Asia/Hong_Kong'],
  JST: ['Asia/Tokyo'],
  KST: ['Asia/Seoul'],
  IST: ['Asia/Kolkata', 'Europe/Dublin', 'Asia/Jerusalem'],
  PKT: ['Asia/Karachi'],
  GST: ['Asia/Dubai'],
  MSK: ['Europe/Moscow'],
  EET: ['Europe/Athens', 'Europe/Helsinki', 'Europe/Kyiv', 'Africa/Cairo', 'Europe/Bucharest'],
  CET: [
    'Europe/Berlin',
    'Europe/Paris',
    'Europe/Madrid',
    'Europe/Rome',
    'Europe/Amsterdam',
    'Europe/Brussels',
    'Europe/Vienna',
    'Europe/Stockholm',
    'Europe/Warsaw',
    'Europe/Prague',
    'Europe/Zurich',
  ],
  WET: ['Europe/Lisbon', 'Atlantic/Canary'],
  GMT: ['Europe/London', 'UTC'],
  BST: ['Europe/London'],
  EST: ['America/New_York', 'America/Toronto'],
  CST: ['America/Chicago', 'America/Mexico_City', 'Asia/Shanghai'],
  MST: ['America/Denver', 'America/Phoenix', 'America/Edmonton'],
  PST: ['America/Los_Angeles', 'America/Vancouver'],
  AKST: ['America/Anchorage'],
  HST: ['Pacific/Honolulu'],
  AEST: ['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane'],
  ACST: ['Australia/Adelaide', 'Australia/Darwin'],
  AWST: ['Australia/Perth'],
  NZST: ['Pacific/Auckland'],
  BRT: ['America/Sao_Paulo'],
  ART: ['America/Argentina/Buenos_Aires'],
  UTC: ['UTC'],
};
// Daylight-saving spellings point at the same zones.
for (const [dst, std] of [
  ['CEST', 'CET'],
  ['EEST', 'EET'],
  ['WEST', 'WET'],
  ['EDT', 'EST'],
  ['CDT', 'CST'],
  ['MDT', 'MST'],
  ['PDT', 'PST'],
  ['AKDT', 'AKST'],
  ['AEDT', 'AEST'],
  ['ACDT', 'ACST'],
  ['NZDT', 'NZST'],
] as const) {
  ABBREVIATIONS[dst] = ABBREVIATIONS[std] ?? [];
}

const ZONES: readonly (readonly [string, string])[] = [['UTC', ''], ...ZONE_COUNTRIES];
export const TIME_ZONE_IDS: readonly string[] = ZONES.map(([id]) => id);
const zoneSet = new Set(TIME_ZONE_IDS);

export function isKnownTimeZone(id: string): boolean {
  return zoneSet.has(id);
}

/** Canonical name for whatever the runtime calls a zone (ICU says "Asia/Calcutta" for Kolkata). */
export function canonicalTimeZone(runtimeId: string): string | null {
  if (zoneSet.has(runtimeId)) return runtimeId;
  for (const id of TIME_ZONE_IDS) {
    try {
      if (new Intl.DateTimeFormat('en', { timeZone: id }).resolvedOptions().timeZone === runtimeId)
        return id;
    } catch {
      // zone unknown to this runtime's ICU: skip
    }
  }
  return null;
}

/** The device's zone, canonicalised (null if it can't be determined). */
export function detectTimeZone(): string | null {
  try {
    return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return null;
  }
}

const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

export function describeZone(id: string, now = new Date(), locale = 'en'): ZoneOption {
  const entry = ZONES.find(([z]) => z === id);
  const countryCode = entry?.[1] ?? '';
  let country = '';
  if (countryCode) {
    try {
      country = new Intl.DisplayNames([locale], { type: 'region' }).of(countryCode) ?? countryCode;
    } catch {
      country = countryCode;
    }
  }
  const city = id === 'UTC' ? 'UTC' : (id.split('/').at(-1) ?? id).replace(/_/g, ' ');
  let offsetLabel = 'UTC+00:00';
  let offsetMinutes = 0;
  let localTime = '';
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: id,
      timeZoneName: 'longOffset',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const tz = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    const m = /GMT([+-−])(\d{2}):(\d{2})/.exec(tz);
    if (m) {
      offsetMinutes = (m[1] === '+' ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3]));
      offsetLabel = `UTC${m[1] === '+' ? '+' : '−'}${m[2]}:${m[3]}`;
    }
    localTime = `${parts.find((p) => p.type === 'hour')?.value}:${parts.find((p) => p.type === 'minute')?.value}`;
  } catch {
    // keep defaults
  }
  return { id, city, country, countryCode, offsetMinutes, offsetLabel, localTime };
}

/** "+7", "utc+7", "GMT+07:00", "-3:30", "UTC−5" → minutes; null if not an offset query. */
export function parseOffsetQuery(q: string): number | null {
  const m = /^(?:utc|gmt)?\s*([+\-−])\s*(\d{1,2})(?::?(\d{2}))?$/i.exec(q.trim());
  if (!m) return null;
  const minutes = Number(m[2]) * 60 + Number(m[3] ?? 0);
  if (minutes > 14 * 60) return null;
  return m[1] === '+' ? minutes : -minutes;
}

/**
 * Ranked search. Every word in the query must match something (city, country, alias, IANA
 * name, abbreviation); an offset query matches zones currently at that offset.
 */
export function searchTimeZones(
  query: string,
  opts: { now?: Date; locale?: string; limit?: number } = {},
): ZoneOption[] {
  const now = opts.now ?? new Date();
  const limit = opts.limit ?? 50;
  const all = ZONES.map(([id]) => describeZone(id, now, opts.locale));
  const q = fold(query);
  if (!q) return all.sort(byOffsetThenName).slice(0, limit);

  const offset = parseOffsetQuery(q);
  if (offset !== null)
    return all
      .filter((z) => z.offsetMinutes === offset)
      .sort(byName)
      .slice(0, limit);
  if (q === 'utc' || q === 'gmt')
    return all
      .filter((z) => z.offsetMinutes === 0)
      .sort((a, b) => (a.id === 'UTC' ? -1 : b.id === 'UTC' ? 1 : byName(a, b)));

  const abbr = ABBREVIATIONS[query.trim().toUpperCase()];
  const aliasesFor = new Map<string, string[]>();
  for (const [alias, zone] of Object.entries(CITY_ALIASES))
    aliasesFor.set(zone, [...(aliasesFor.get(zone) ?? []), alias]);

  // IANA names use underscores for spaces ("Phnom_Penh").
  const words = q.replace(/_/g, ' ').split(/\s+/);
  const scored: { z: ZoneOption; score: number }[] = [];
  for (const z of all) {
    const fields = {
      city: fold(z.city),
      country: fold(z.country),
      id: fold(z.id.replace(/_/g, ' ')),
      aliases: aliasesFor.get(z.id) ?? [],
    };
    let score = 0;
    if (abbr?.includes(z.id)) score += 200;
    let allWords = true;
    for (const w of words) {
      let best = 0;
      if (fields.city === w) best = Math.max(best, 120);
      if (fields.city.startsWith(w)) best = Math.max(best, 100);
      if (fields.aliases.some((a) => a.startsWith(w))) best = Math.max(best, 95);
      if (fields.country.startsWith(w)) best = Math.max(best, 80);
      if (fields.city.includes(w)) best = Math.max(best, 60);
      if (fields.aliases.some((a) => a.includes(w))) best = Math.max(best, 55);
      if (fields.country.includes(w)) best = Math.max(best, 50);
      if (fields.id.includes(w)) best = Math.max(best, 40);
      if (best === 0) allWords = false;
      score += best;
    }
    if (allWords || (abbr?.includes(z.id) && words.length === 1)) scored.push({ z, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || byName(a.z, b.z))
    .slice(0, limit)
    .map((s) => s.z);
}

const byName = (a: ZoneOption, b: ZoneOption) => a.city.localeCompare(b.city);
const byOffsetThenName = (a: ZoneOption, b: ZoneOption) =>
  a.offsetMinutes - b.offsetMinutes || byName(a, b);

export { ABBREVIATIONS, CITY_ALIASES };
