import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test workspace packages from source; no build step needed.
    alias: {
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
