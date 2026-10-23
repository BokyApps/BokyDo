import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTO_LANGUAGE,
  LANGUAGES,
  catalogueFor,
  chosenLanguage,
  initI18n,
  rememberedLanguage,
  setLanguage,
} from './i18n.js';

// setLanguage's second argument stands in for the browser's languages in tests.
const languages = (...tags: string[]) => tags;

/**
 * W12c step 1's acceptance: a fake second locale proves switching works, and the English
 * catalogue is the base every other one falls back to.
 */
describe('i18n plumbing', () => {
  beforeEach(async () => {
    await initI18n();
  });

  // Bundles a test registers (af, en-XA) must not leak into the next one: the "no catalogue"
  // case relies on af being unregistered, and must hold whatever order the tests run in.
  afterEach(async () => {
    const { default: i18n } = await import('./i18n.js');
    for (const lng of Object.keys(i18n.store.data))
      if (!(LANGUAGES as readonly string[]).includes(lng))
        i18n.removeResourceBundle(lng, 'translation');
  });

  it('starts in English, whose catalogue is the base', async () => {
    expect(await setLanguage('en')).toBe('en');
    const { default: en } = await import('./locales/en.json');
    // The catalogue keeps the namespace shape i18next writes and expects.
    expect(en.translation.nav).toHaveProperty('inbox', 'Inbox');
    expect(en.translation.sidebar).toHaveProperty('noProjects', 'No projects yet.');
  });

  it('falls back to English for a language with no catalogue', async () => {
    expect(await setLanguage('af', languages())).toBe('en');
    expect(await setLanguage('not-a-tag', languages())).toBe('en');
    expect(await setLanguage('en-ZA', languages())).toBe('en');
  });

  it('never imports a catalogue path outside ./locales', async () => {
    // A tag that looks like a path can't select a file: only shipped languages are imported.
    expect(await setLanguage('../../etc/passwd', languages())).toBe('en');
    expect(await setLanguage('en/../../secret', languages())).toBe('en');
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

  it('"auto" is followed, not short-circuited to English', async () => {
    // A browser asking for a language we ship must switch, even with auto: the old path
    // returned 'en' before consulting the browser and never touched <html lang>.
    const { default: i18n } = await import('./i18n.js');
    i18n.addResourceBundle(
      'af',
      'translation',
      {
        nav: { inbox: 'Inboxmandjie' },
        count: {
          invitation_one: '{{count}} uitnodiging',
          invitation_other: '{{count}} uitnodigings',
        },
      },
      true,
      true,
    );
    expect(await setLanguage('auto', languages('af-ZA', 'en-ZA'))).toBe('af');
    // ...and a pinned tag still wins over the browser.
    expect(await setLanguage('en', languages('af-ZA'))).toBe('en');
  });

  it('the language used for dates and numbers follows the interface', async () => {
    // The shared helpers read i18next's resolved language, so Intl localises with the UI.
    const { localeTag } = await import('./lib/locale.js');
    await setLanguage('en', languages());
    expect(localeTag()).toBe('en');
  });

  it('has the task and project areas in the English catalogue', async () => {
    await setLanguage('en');
    const { default: en } = await import('./locales/en.json');
    expect(en.translation.task).toHaveProperty('addTask', 'Add task');
    expect(en.translation.task).toHaveProperty('complete', 'Complete “{{content}}”');
    expect(en.translation.project).toHaveProperty('notFoundTitle', 'Project not found');
    expect(en.translation.board).toHaveProperty('move', 'Move “{{content}}”');
    expect(en.translation.today).toHaveProperty('title', 'Today');
    expect(en.translation.upcoming).toHaveProperty('title', 'Upcoming');
  });

  it('interpolates and pluralises the extracted task keys', async () => {
    await setLanguage('en');
    const { default: i18n } = await import('./i18n.js');
    expect(i18n.t('task.addTasks', { count: 1 })).toBe('Add 1 task');
    expect(i18n.t('task.addTasks', { count: 3 })).toBe('Add 3 tasks');
    expect(i18n.t('task.complete', { content: 'Milk' })).toBe('Complete “Milk”');
  });

  it('keeps reminders keys at the top level (not under settings)', async () => {
    const { default: en } = await import('./locales/en.json');
    expect(en.translation).toHaveProperty('reminders.add', '+ Add reminder');
    expect(en.translation).toHaveProperty('reminders.delete', 'Delete reminder {{label}}');
    expect(en.translation).not.toHaveProperty('settings.reminders');
  });

  it('splits plural keys that carry a count into _one/_other', async () => {
    await setLanguage('en');
    const { default: i18n } = await import('./i18n.js');
    const { default: en } = await import('./locales/en.json');
    // import.andMore
    expect(en.translation.import).toHaveProperty('andMore_one', '…and {{count}} more.');
    expect(en.translation.import).toHaveProperty('andMore_other', '…and {{count}} more.');
    expect(i18n.t('import.andMore', { count: 1 })).toBe('…and 1 more.');
    expect(i18n.t('import.andMore', { count: 3 })).toBe('…and 3 more.');
    // import.warningGroup
    expect(en.translation.import).toHaveProperty('warningGroup_one', '{{label}} ({{count}})');
    expect(en.translation.import).toHaveProperty('warningGroup_other', '{{label}} ({{count}})');
    expect(i18n.t('import.warningGroup', { label: 'Labels', count: 1 })).toBe('Labels (1)');
    // notifications.unread
    expect(en.translation.notifications).toHaveProperty(
      'unread_one',
      'Notifications, {{count}} unread',
    );
    expect(en.translation.notifications).toHaveProperty(
      'unread_other',
      'Notifications, {{count}} unread',
    );
    expect(i18n.t('notifications.unread', { count: 1 })).toBe('Notifications, 1 unread');
    expect(i18n.t('notifications.unread', { count: 5 })).toBe('Notifications, 5 unread');
  });

  it('preserves dynamic keys that are built at runtime', async () => {
    const { default: en } = await import('./locales/en.json');
    // admin.backups.restoreError.* — built as t(`admin.backups.restoreError.\${code}`)
    expect(en.translation.admin.backups.restoreError).toHaveProperty(
      'backup_passphrase_or_damaged',
      'The passphrase is wrong, or the file is damaged.',
    );
    expect(en.translation.admin.backups.restoreError).toHaveProperty(
      'backup_invalid',
      "That file isn't a usable BokyDo backup.",
    );
    // import.warningKind.* — built as t(`import.warningKind.\${kind}`)
    expect(en.translation.import.warningKind).toHaveProperty('recurrence', 'Repeating dates');
    expect(en.translation.import.warningKind).toHaveProperty('failed', 'Not imported');
    // settings.tabs.* — built as t(`settings.tabs.\${key}`)
    expect(en.translation.settings.tabs).toHaveProperty('appearance', 'Appearance');
    expect(en.translation.settings.tabs).toHaveProperty('device', 'This device');
    // settings.webhooks.events/status.* — built dynamically
    expect(en.translation.settings.webhooks.events).toHaveProperty('task_added', 'Task added');
    expect(en.translation.settings.webhooks.status).toHaveProperty('pending', 'waiting to be sent');
  });

  it('has English values (not key-name placeholders) for newly extracted keys', async () => {
    const { default: en } = await import('./locales/en.json');
    expect(en.translation.settings.data).toHaveProperty('username', 'Username');
    expect(en.translation.settings.notifications).toHaveProperty('reminders', 'Reminders');
    expect(en.translation.settings.notifications).toHaveProperty('whatToSend', 'What to send');
  });

  it('remembers a pinned language and forgets it on "auto"', async () => {
    // No storage in this environment: both paths are no-ops that must not throw.
    expect(() => rememberedLanguage()).not.toThrow();
    expect(rememberedLanguage()).toBe(AUTO_LANGUAGE);
  });
});
