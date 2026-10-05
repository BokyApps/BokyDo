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
    },
  },
  test: {
    // DB integration tests share one database; keep files sequential.
    fileParallelism: false,
  },
});
