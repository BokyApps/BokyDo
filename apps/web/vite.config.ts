import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vite';

const api = 'http://127.0.0.1:8080';

/** Public files that are part of the app shell but aren't emitted by the bundler. */
const STATIC_FILES = [
  '/favicon.svg',
  '/manifest.webmanifest',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-512.png',
];

/**
 * Inject the built, content-hashed asset list and a version hash into the hand-written
 * `public/sw.js`. The worker precaches exactly these files and deletes caches from other
 * versions; emitting `sw.js` here overwrites the placeholder copy Vite copies from `public/`.
 */
function serviceWorker(): Plugin {
  return {
    name: 'bokydo-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const assets: string[] = [];
      const hashInput: string[] = [];
      for (const [fileName, output] of Object.entries(bundle)) {
        if (fileName === 'sw.js') continue;
        assets.push(fileName);
        hashInput.push(fileName, output.type === 'chunk' ? output.code : String(output.source));
      }
      // Fold the non-hashed public files in too, so an icon or the manifest bumps the version.
      for (const file of STATIC_FILES) {
        hashInput.push(file, String(readFileSync(new URL(`./public${file}`, import.meta.url))));
      }
      const version = createHash('sha256').update(hashInput.join('\0')).digest('hex').slice(0, 12);
      const injected = assets
        .filter((file) => file !== 'index.html')
        .map((file) => `  '/${file}',`)
        .join('\n');
      const source = readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8')
        .replace('  /* __BOKYDO_ASSETS__ */', injected)
        .replace("const VERSION = '__BOKYDO_VERSION__';", `const VERSION = '${version}';`)
        .replace("const BUILT = VERSION !== '__BOKYDO_VERSION__';", 'const BUILT = true;');
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), serviceWorker()],
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
