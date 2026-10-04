import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test workspace packages from source; no build step needed.
    alias: {
      '@bokydo/shared': fileURLToPath(
        new URL('../../packages/shared/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    // DB integration tests share one database; keep files sequential.
    fileParallelism: false,
  },
});
