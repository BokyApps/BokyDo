# Translating BokyDo

The web app's interface is translated through [Weblate](https://weblate.org). English is the
base language: every other catalogue is filled in against it, and anything missing simply
shows its English text (i18next's fallback), so a half-translated language is still usable.

Out of scope for now (deliberate): the quick-add grammar (`packages/nlp`, where "tomorrow"
is syntax), server-sent emails, and the Android app's strings — each becomes its own Weblate
component later.

## Plumbed in, and how it works

- **Stack:** `i18next` + `react-i18next` (both MIT). i18next JSON **v4**.
- **Base catalogue:** `apps/web/src/locales/en.json` — the only file hand-edited.
- **Interpolation:** `escapeValue: false` in `apps/web/src/i18n.ts`. Translated text must
  never go through `dangerouslySetInnerHTML`; use `<Trans>` for markup.
- **Loading:** English is bundled. Everything else is loaded on demand
  (`setLanguage` in `apps/web/src/i18n.ts`), then cached by i18next.
- **Where the language comes from:** the synced `language` preference
  (`auto` = the browser's language) in Settings → General, plus this device's last choice,
  remembered in `localStorage` so the first paint is right before sign-in.
- **Plurals:** use the JSON v4 suffixes — `key_one`, `key_other`.
- **Keys:** dotted by screen, never the English text: `nav.inbox`, `sidebar.noProjects`.
- **`<html lang>`** follows the language in use, for screen readers.

## Weblate component

- **Component mask:** `apps/web/src/locales/*.json`
- **Base file:** `apps/web/src/locales/en.json`
- **File format:** `i18next JSON file v4`
- **Source language:** English (`en`)
- **Repository branch:** create a `weblate` branch that Weblate pushes to; translations land
  as pull requests against `main` and are reviewed like any other change.

## Adding a string (as a developer)

1. Write the screen with the English text straight in `t('screen.key')`.
2. Run `pnpm --filter @bokydo/web i18n:extract`. CI runs the same command and fails if
   `en.json` is out of date, so this step is not optional.
3. Fill in the English value for the new key in `en.json` if the extractor left the key as a
   placeholder, and commit both.

Keys whose text is built at runtime cannot be found by the extractor; keep a comment next to
such a call saying the key must be added to `en.json` by hand. (The sidebar's invitation
count is one: `count.invitation`.)

## Checking a translation

Set Settings → General → Language to a catalogue, or pin one via the browser's languages
with `auto`. A pseudo-locale makes truncation obvious — register it in a test the way
`apps/web/src/i18n.test.ts` does and run that test (`pnpm --filter @bokydo/web test`).
