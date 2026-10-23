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
    // `ws: true` so the live Ramble relay's WebSocket reaches the API in development.
    proxy: { '/api': { target: api, ws: true }, '/healthz': api, '/readyz': api },
  },
  build: {
    sourcemap: false,
    // Keep everything as external files so the strict CSP (no inline scripts/styles) holds.
    assetsInlineLimit: 0,
  },
});
