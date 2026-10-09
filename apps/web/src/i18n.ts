import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from './locales/en.json';

/**
 * i18n plumbing (PLAN §12 W12c, ADR 0023): i18next + react-i18next, English as the base
 * language and every other one loaded on demand. Keys are added by extracting the strings
 * from the screens (`pnpm --filter @bokydo/web i18n:extract`); this file only wires it up.
 *
 * Interpolation is escaped by React itself, so i18next must not escape: with
 * `escapeValue: false` the value goes into the DOM as text. Never pass translated strings
 * through dangerouslySetInnerHTML.
 */

/** Languages with a catalogue. Others fall back to English until one lands. */
export const LANGUAGES = ['en'] as const;
export type Language = (typeof LANGUAGES)[number];

/** The preference's value for following the browser. */
export const AUTO_LANGUAGE = 'auto';

const STORAGE_KEY = 'bokydo.lang';

/** English, loaded at once: the app's default language. The namespace shape is what
 *  `i18next-cli extract` writes. */
const resources = { en: { translation: en.translation } };

let started: Promise<void> | null = null;

/** i18next is initialised once, on first use (the app or a language change). */
function startedOnce(): Promise<void> {
  started ??= Promise.resolve(
    i18next.use(initReactI18next).init({
      resources,
      lng: 'en',
      fallbackLng: 'en',
      defaultNS: 'translation',
      interpolation: { escapeValue: false },
      returnNull: false,
    }),
  ).then(() => undefined);
  return started;
}

/** Start i18next with English. Call once, before the first render. */
export function initI18n(): Promise<void> {
  return startedOnce();
}

/**
 * The base tag of a browser or pinned language ("en-ZA" → "en"), or null when we have no
 * catalogue for it and English should be used.
 */
export function catalogueFor(tag: string): Language | null {
  const [base] = tag.toLowerCase().split('-');
  return (LANGUAGES as readonly string[]).includes(base ?? '') ? (base as Language) : null;
}

/** Resolve the preference against the browser: 'auto' follows navigator.language. */
export function chosenLanguage(preference: string, navigatorLanguages: string[]): string {
  if (preference !== AUTO_LANGUAGE) return preference;
  for (const tag of navigatorLanguages) {
    const found = catalogueFor(tag);
    if (found) return found;
  }
  return 'en';
}

/** Remember the choice on this device, so the first paint already uses it. */
export function rememberLanguage(choice: string): void {
  try {
    if (choice === AUTO_LANGUAGE) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, choice);
  } catch {
    // Private mode or storage disabled: the preference still applies for this session.
  }
}

/** The device's remembered choice, for the first render (before preferences sync). */
export function rememberedLanguage(): string {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && stored !== AUTO_LANGUAGE && catalogueFor(stored)) return stored as Language;
  } catch {
    // Storage unavailable: fall through to the browser's language.
  }
  return AUTO_LANGUAGE;
}

/**
 * Switch language, loading its catalogue on demand. A language is used when we ship it or
 * when its bundle is already registered (tests, or a catalogue added later); otherwise the
 * request falls back to English. `<html lang>` follows so screen readers use the right voice.
 */
export async function setLanguage(tag: string): Promise<string> {
  await startedOnce();
  const [base] = tag.toLowerCase().split('-');
  const code = base ?? 'en';
  // The exact tag wins when its catalogue exists (a regional variant); otherwise the base.
  const resolved = i18next.hasResourceBundle(tag, 'translation') ? tag : code;
  const shipped = (LANGUAGES as readonly string[]).includes(resolved);
  if (!shipped && !i18next.hasResourceBundle(resolved, 'translation')) return 'en';
  if (!i18next.hasResourceBundle(resolved, 'translation')) {
    const bundle = (await import(`./locales/${resolved}.json`)).default;
    i18next.addResourceBundle(resolved, 'translation', bundle, true, true);
  }
  await i18next.changeLanguage(resolved);
  if (typeof document !== 'undefined') document.documentElement.lang = resolved;
  return resolved;
}

export default i18next;
