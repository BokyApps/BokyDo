import { default as i18next } from '../i18n.js';

/**
 * The language Intl should use (W12c, ADR 0023): the one the interface is in, so dates and
 * numbers localise with it. Falls back to English before i18next has started (unit tests, and
 * the very first paint), where the browser's own locale is the best guess.
 */
export function localeTag(): string {
  const active = i18next.resolvedLanguage ?? i18next.language;
  return active ?? 'en';
}

/**
 * The browser's languages, best first. Isolated here so the "follow the browser" behaviour is
 * testable, and so `auto` can be resolved the same way on the client and in a unit test.
 */
export function browserLanguages(): string[] {
  if (typeof navigator === 'undefined') return [];
  return [...(navigator.languages ?? [navigator.language])].filter(Boolean);
}
