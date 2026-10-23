/**
 * i18next-cli extraction (PLAN §12 W12c, ADR 0023): the keys come from the screens, so
 * translations are never hand-numbered. Run `pnpm --filter @bokydo/web i18n:extract`;
 * CI fails when apps/web/src/locales/en.json is not what that produces.
 *
 * Keys are the literal paths used in t() ("sidebar.noProjects"), nested by keySeparator.
 * Values already in en.json are kept, so English stays English; a key that is not a literal
 * (built at runtime) is not extracted. preservePatterns below keeps those dynamic keys
 * from being pruned on each run: each group is a fixed set of values known at compile
 * time (error codes, warning kinds, tab labels, webhook events/statuses).
 * See docs/translating.md.
 */
export default {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'src/locales/{{language}}.json',
    preservePatterns: [
      'admin.backups.restoreError.*',
      'import.warningKind.*',
      'settings.reminders.*',
      'settings.tabs.*',
      'settings.webhooks.events.*',
      'settings.webhooks.status.*',
    ],
  },
  defaultNamespace: 'translation',
  keySeparator: '.',
  namespaceSeparator: ':',
  pluralSeparator: '_',
  contextSeparator: '_',
  indentation: 2,
  sort: true,
};
