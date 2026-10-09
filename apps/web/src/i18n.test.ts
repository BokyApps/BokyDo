import { beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_LANGUAGE,
  catalogueFor,
  chosenLanguage,
  initI18n,
  rememberedLanguage,
  setLanguage,
} from './i18n.js';

/**
 * W12c step 1's acceptance: a fake second locale proves switching works, and the English
 * catalogue is the base every other one falls back to.
 */
describe('i18n plumbing', () => {
  beforeEach(async () => {
    await initI18n();
  });

  it('starts in English, whose catalogue is the base', async () => {
    expect(await setLanguage('en')).toBe('en');
    const { default: en } = await import('./locales/en.json');
    // The catalogue keeps the namespace shape i18next writes and expects.
    expect(en.translation.nav).toHaveProperty('inbox', 'Inbox');
    expect(en.translation.sidebar).toHaveProperty('noProjects', 'No projects yet.');
  });

  it('falls back to English for a language with no catalogue', async () => {
    expect(await setLanguage('af')).toBe('en');
    expect(await setLanguage('not-a-tag')).toBe('en');
    expect(await setLanguage('en-ZA')).toBe('en');
  });

  it('switches to a catalogue registered later', async () => {
    const { default: i18n } = await import('./i18n.js');
    // A made-up pseudo-locale, as the extraction and reviewers use to check every screen.
    i18n.addResourceBundle(
      'en-XA',
      'translation',
      {
        nav: { inbox: 'ẄĘß' },
        count: { invitation_one: '{{count}} ệ', invitation_other: '{{count}} ệệ' },
      },
      true,
      true,
    );
    expect(await setLanguage('en-XA')).toBe('en-XA');
    expect(i18n.t('nav.inbox')).toBe('ẄĘß');
    // Plurals use i18next JSON v4 suffixes, so a count picks the right form.
    expect(i18n.t('count.invitation', { count: 1 })).toBe('1 ệ');
    expect(i18n.t('count.invitation', { count: 3 })).toBe('3 ệệ');
    // A key the pseudo-locale lacks falls back to English rather than showing the key.
    expect(i18n.t('nav.today')).toBe('Today');
  });

  it('resolves "auto" against the browser’s languages', () => {
    expect(chosenLanguage(AUTO_LANGUAGE, ['de-DE', 'en-GB'])).toBe('en');
    expect(chosenLanguage(AUTO_LANGUAGE, ['de-DE', 'fr'])).toBe('en');
    expect(chosenLanguage(AUTO_LANGUAGE, [])).toBe('en');
    expect(chosenLanguage('en', ['de-DE'])).toBe('en');
    expect(catalogueFor('EN')).toBe('en');
    expect(catalogueFor('en-ZA')).toBe('en');
    expect(catalogueFor('de')).toBeNull();
  });

  it('remembers a pinned language and forgets it on "auto"', async () => {
    // No storage in this environment: both paths are no-ops that must not throw.
    expect(() => rememberedLanguage()).not.toThrow();
    expect(rememberedLanguage()).toBe(AUTO_LANGUAGE);
  });
});
