import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));
const shared = (file: string) =>
  fileURLToPath(new URL(`../../packages/shared/src/${file}`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test workspace packages from source; no build step needed.
    alias: {
      // A subpath before the barrel: alias prefixes match, so `@bokydo/shared` would otherwise
      // rewrite `@bokydo/shared/notes-refs` to a path under `index.ts`.
      '@bokydo/shared/notes-refs': shared('notes-refs.ts'),
      '@bokydo/shared': pkg('shared'),
      '@bokydo/themes': pkg('themes'),
      '@bokydo/nlp': pkg('nlp'),
      '@bokydo/filter-query': pkg('filter-query'),
    },
  },
  test: {
    // DB integration tests share one database; keep files sequential.
    fileParallelism: false,
    // …and take a lock for the whole run, so two runs (several agents share this checkout) cannot
    // drop each other's schema. See src/test/global-setup.ts.
    globalSetup: ['./src/test/global-setup.ts'],
  },
});
