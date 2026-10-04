import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const api = 'http://127.0.0.1:8080';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { conditions: ['bokydo-source'] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': api, '/healthz': api, '/readyz': api },
  },
  build: {
    sourcemap: false,
    // Keep everything as external files so the strict CSP (no inline scripts/styles) holds.
    assetsInlineLimit: 0,
  },
});
