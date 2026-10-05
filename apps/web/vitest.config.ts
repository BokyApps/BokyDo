import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) =>
  fileURLToPath(new URL(`../../packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@bokydo/shared': pkg('shared'),
      '@bokydo/themes': pkg('themes'),
      '@bokydo/sync-client': pkg('sync-client'),
      '@bokydo/nlp': pkg('nlp'),
    },
  },
});
