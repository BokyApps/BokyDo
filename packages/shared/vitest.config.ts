import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@bokydo/themes': fileURLToPath(new URL('../themes/src/index.ts', import.meta.url)),
      '@bokydo/nlp': fileURLToPath(new URL('../nlp/src/index.ts', import.meta.url)),
    },
  },
});
