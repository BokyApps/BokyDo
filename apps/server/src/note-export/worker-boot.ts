import { tsImport } from 'tsx/esm/api';

/**
 * Development/test bootstrap for the export worker (`runner.ts` picks this file while the server
 * runs from `src`). Node can strip this file's types itself, but the rest of the graph is
 * TypeScript with NodeNext `.js` import specifiers; `tsImport` loads it through tsx, which maps
 * those to the sibling `.ts` files. A built server never loads this file: it spawns the emitted
 * `worker.js` directly.
 */
await tsImport(new URL('./worker.ts', import.meta.url).href, import.meta.url);
