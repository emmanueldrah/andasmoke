/**
 * Runs the same local API the desktop app uses, as a standalone process.
 * Used by `npm run dev` for browser development: Vite proxies /api here.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const require = createRequire(import.meta.url);

process.env.ANDA_DATA_DIR = process.env.ANDA_DATA_DIR || path.join(root, '.data');

const { startLocalServer } = require(path.join(root, 'electron/local-server.cjs'));
const { handlers } = require(path.join(root, 'electron/api-routes.cjs'));

const port = Number(process.env.ANDA_API_PORT || 4310);
const { origin } = await startLocalServer({
  distDir: path.join(root, 'dist'),
  handlers,
  host: '127.0.0.1',
  port,
});
console.log(`[api] listening on ${origin}`);
console.log(`[api] database at ${path.join(process.env.ANDA_DATA_DIR, 'anda-smoke-hub.sqlite')}`);
