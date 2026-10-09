/**
 * i18next-cli extraction (PLAN §12 W12c, ADR 0023): the keys come from the screens, so
 * translations are never hand-numbered. Run `pnpm --filter @bokydo/web i18n:extract`;
 * CI fails when apps/web/src/locales/en.json is not what that produces.
 *
 * Keys are the literal paths used in t() ("sidebar.noProjects"), nested by keySeparator.
 * Values already in en.json are kept, so English stays English; a key that is not a literal
 * (built at runtime) is not extracted, which is why such keys carry a comment where they
 * are used.
 */
export default {
  locales: ['en'],
  extract: {
    input: ['src/**/*.{ts,tsx}'],
    output: 'src/locales/{{language}}.json',
  },
  defaultNamespace: 'translation',
  keySeparator: '.',
  namespaceSeparator: ':',
  pluralSeparator: '_',
  contextSeparator: '_',
  indentation: 2,
  sort: true,
};
