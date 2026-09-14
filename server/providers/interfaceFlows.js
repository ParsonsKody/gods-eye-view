import path from 'node:path';
import { promises as fsp } from 'node:fs';

import { parseNyisoInterfaceFlows } from '../../src/data/flowFeeds.js';

/**
 * ISO interface-flow proxy (NYISO), keyless, with memory + disk cache.
 *
 * Route:
 *   GET /api/interface-flows?iso=nyiso → {iso, fetchedAt, stale, ttlMs, interval, flows}
 *
 * Upstream: mis.nyiso.com currentExternalLimitsFlows.csv, the latest
 * 5-minute snapshot (about 20 rows). TTL 60 s, single-flight refresh,
 * serve stale on failure, byte-capped read, hardcoded upstream URL.
 *
 * @returns {import('vite').Plugin}
 */
export function interfaceFlowsProxy() {
  const TTL_MS = 60_000;
  const MAX_BYTES = 65_536;
  const UPSTREAM = {
    nyiso:
      'https://mis.nyiso.com/public/csv/ExternalLimitsFlows/currentExternalLimitsFlows.csv',
  };
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');

  /** @type {Map<string, {at:number, interval:string|null, flows:object[]}>} */
  const mem = new Map();
  const diskChecked = new Set();
  /** @type {Map<string, Promise<object|null>>} */
  const inflight = new Map();

  const cachePath = (iso) =>
    path.join(CACHE_DIR, `interface-flows-${iso}.json`);

  async function readDiskOnce(iso) {
    if (diskChecked.has(iso)) return;
    diskChecked.add(iso);
    try {
      const parsed = JSON.parse(await fsp.readFile(cachePath(iso), 'utf8'));
      if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.flows)) {
        mem.set(iso, parsed);
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(iso, entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(cachePath(iso), JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[interface-flows] cache write failed:', err?.message || err);
    }
  }

  async function refresh(iso) {
    const res = await fetch(UPSTREAM[iso], {
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`${iso} HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES)
      throw new Error(`upstream body over ${MAX_BYTES} bytes`);
    const parsed = parseNyisoInterfaceFlows(buf.toString('utf8'));
    if (!parsed.flows.length) throw new Error(`${iso} returned no flows`);
    return { at: Date.now(), interval: parsed.interval, flows: parsed.flows };
  }

  function buildPayload(iso, entry, stale) {
    return {
      iso,
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      interval: entry.interval,
      flows: entry.flows,
    };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/interface-flows', async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        const query = new URL(String(req.url || '/'), 'http://localhost')
          .searchParams;
        const iso = String(query.get('iso') || '').toLowerCase();
        if (!UPSTREAM[iso]) {
          sendJson(400, { error: 'iso must be nyiso' });
          return;
        }
        await readDiskOnce(iso);
        const entry = mem.get(iso) || null;
        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload(iso, entry, false));
          return;
        }
        if (!inflight.has(iso)) {
          inflight.set(
            iso,
            refresh(iso)
              .then(async (fresh) => {
                mem.set(iso, fresh);
                await writeDisk(iso, fresh);
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[interface-flows] ${iso} refresh failed (${err?.message || err}); serving cache if any`,
                );
                return null;
              })
              .finally(() => {
                inflight.delete(iso);
              }),
          );
        }
        const fresh = await inflight.get(iso);
        if (fresh) sendJson(200, buildPayload(iso, fresh, false));
        else if (entry) sendJson(200, buildPayload(iso, entry, true));
        else
          sendJson(502, {
            error: `${iso} fetch failed and no cache available`,
          });
      } catch (err) {
        console.warn('[interface-flows] error:', err?.message || err);
        sendJson(500, { error: 'interface flows proxy error' });
      }
    });
  };
  return {
    name: 'interface-flows-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
