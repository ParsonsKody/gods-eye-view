import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { resolvePrivateDataRequest } from '../../src/data/privateData.js';

/**
 * Private data seam: serves JSON files from the folder named by
 * `GEV_PRIVATE_DATA_DIR` (set in `.env`) at `/api/private/<name>.json`.
 *
 * The folder is filled outside this repository by whatever the operator
 * has (a production-cost forecast, a market-data subscription); nothing in
 * it is ever read at build time or checked in. With the variable unset
 * every request is an empty 204 and the browser falls back to the bundled
 * demo fixture. Only the whitelisted names in src/data/privateData.js are
 * served, the path is never taken from the client, and requests must come
 * from the loopback interface.
 *
 * @param {{env?: NodeJS.ProcessEnv}} [options]
 * @returns {import('vite').Plugin}
 */
export function privateDataProxy({ env = process.env } = {}) {
  const MAX_BYTES = 64 * 1024 * 1024;
  const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

  const installMiddleware = (server) => {
    server.middlewares.use('/api/private', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        if (!LOOPBACK.has(String(req.socket?.remoteAddress || ''))) {
          sendJson(403, { error: 'private data is served to localhost only' });
          return;
        }
        const dir = env.GEV_PRIVATE_DATA_DIR;
        const decision = resolvePrivateDataRequest({ dir, urlPath: req.url });
        if (decision.status === 204) {
          res.writeHead(204, { 'Cache-Control': 'no-store' });
          res.end();
          return;
        }
        if (decision.status !== 200) {
          sendJson(decision.status, { error: decision.error });
          return;
        }
        const filePath = path.join(path.resolve(String(dir)), `${decision.name}.json`);
        let stat;
        try {
          stat = await fsp.stat(filePath);
        } catch {
          sendJson(404, { error: `${decision.name}.json not found in GEV_PRIVATE_DATA_DIR` });
          return;
        }
        if (!stat.isFile() || stat.size > MAX_BYTES) {
          sendJson(413, { error: `${decision.name}.json is not a file under ${MAX_BYTES} bytes` });
          return;
        }
        const body = await fsp.readFile(filePath);
        if (res.headersSent) return;
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'Last-Modified': stat.mtime.toUTCString(),
        });
        res.end(body);
      } catch (err) {
        console.warn('[private-data] error:', err?.message || err);
        sendJson(500, { error: 'private data error' });
      }
    });
  };
  return {
    name: 'private-data',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
