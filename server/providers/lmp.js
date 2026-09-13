import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  parseNyisoRealtimeTail,
  normalizeSppFeatures,
} from '../../src/data/lmpFeeds.js';

/**
 * ISO real-time LMP proxy (SPP + NYISO), keyless, with memory + disk cache.
 *
 * Routes:
 *   GET /api/lmp?iso=nyiso → {iso, fetchedAt, stale, ttlMs, interval, nodes, constraints}
 *   GET /api/lmp?iso=spp   → same shape; SPP nodes carry lat/lon, NYISO nodes
 *                            are joined to bundled coordinates client-side.
 *
 * NYISO upstream: mis.nyiso.com daily realtime_gen.csv (about 8 MB by day
 * end). Only the last NYISO_TAIL_BYTES are read via HTTP Range; the parser
 * keeps the last complete interval. Filenames use the Eastern calendar day.
 *
 * SPP upstream: pricecontourmap.spp.org ArcGIS layers 1 to 5 of
 * PCM/RTBM_Features (DC ties, hubs, interfaces, M2M and binding
 * constraints). Coordinates come back in WGS84 via outSR=4326.
 *
 * Both feeds publish every 5 minutes; TTL 60 s keeps the proxy at most one
 * upstream pass per minute per ISO. Single-flight refresh, serve stale on
 * failure, byte-capped reads, hardcoded upstream hosts (nothing from the
 * client reaches the upstream URL except the iso switch).
 *
 * @returns {import('vite').Plugin}
 */
export function lmpProxy() {
  const TTL_MS = 60_000;
  const NYISO_TAIL_BYTES = 262_144;
  const NYISO_MAX_BYTES = 2_097_152;
  const SPP_MAX_BYTES = 2_097_152;
  const SPP_BASE =
    'https://pricecontourmap.spp.org/arcgis/rest/services/PCM/RTBM_Features/MapServer';
  const SPP_LAYERS = [1, 2, 3, 4, 5];
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const ISOS = new Set(['nyiso', 'spp']);

  /** @type {Map<string, {at:number, interval:string|null, nodes:object[], constraints:object[]}>} */
  const mem = new Map();
  const diskChecked = new Set();
  /** @type {Map<string, Promise<object|null>>} */
  const inflight = new Map();

  const cachePath = (iso) => path.join(CACHE_DIR, `lmp-${iso}.json`);

  async function readDiskOnce(iso) {
    if (diskChecked.has(iso)) return;
    diskChecked.add(iso);
    try {
      const parsed = JSON.parse(await fsp.readFile(cachePath(iso), 'utf8'));
      if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.nodes)) {
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
      console.warn('[lmp-proxy] cache write failed:', err?.message || err);
    }
  }

  async function readCapped(res, maxBytes) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > maxBytes)
      throw new Error(`upstream body over ${maxBytes} bytes`);
    return buf.toString('utf8');
  }

  /** YYYYMMDD for the NYISO (Eastern) calendar day, offset by `daysBack`. */
  function nyisoDayStamp(daysBack) {
    const now = new Date(Date.now() - daysBack * 86_400_000);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const get = (type) => parts.find((p) => p.type === type)?.value;
    return `${get('year')}${get('month')}${get('day')}`;
  }

  async function fetchNyisoDay(stamp, tailBytes) {
    const url = `https://mis.nyiso.com/public/csv/realtime/${stamp}realtime_gen.csv`;
    const res = await fetch(url, {
      headers: { Range: `bytes=-${tailBytes}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return null;
    if (!res.ok && res.status !== 206)
      throw new Error(`NYISO HTTP ${res.status}`);
    const text = await readCapped(res, NYISO_MAX_BYTES);
    return parseNyisoRealtimeTail(text, { partialHead: res.status === 206 });
  }

  async function refreshNyiso() {
    for (const daysBack of [0, 1]) {
      const stamp = nyisoDayStamp(daysBack);
      let parsed = await fetchNyisoDay(stamp, NYISO_TAIL_BYTES);
      if (parsed === null && daysBack === 0) continue; // file not posted yet
      if (!parsed) parsed = await fetchNyisoDay(stamp, NYISO_MAX_BYTES - 1);
      if (!parsed) continue;
      return {
        at: Date.now(),
        interval: parsed.interval,
        nodes: parsed.rows.map((r) => ({
          id: `nyiso:${r.id}`,
          ptid: r.id,
          name: r.name,
          kind: 'gen',
          lmp: r.lmp,
          mcc: r.mcc,
          mlc: r.mlc,
        })),
        constraints: [],
      };
    }
    throw new Error('NYISO real-time file unavailable');
  }

  async function refreshSpp() {
    const byLayer = {};
    await Promise.all(
      SPP_LAYERS.map(async (layerId) => {
        const params = new URLSearchParams({
          where: '1=1',
          outFields: '*',
          returnGeometry: 'true',
          outSR: '4326',
          f: 'json',
        });
        const res = await fetch(`${SPP_BASE}/${layerId}/query?${params}`, {
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`SPP layer ${layerId} HTTP ${res.status}`);
        byLayer[layerId] = JSON.parse(await readCapped(res, SPP_MAX_BYTES));
        if (byLayer[layerId]?.error) {
          throw new Error(
            `SPP layer ${layerId}: ${byLayer[layerId].error.message}`,
          );
        }
      }),
    );
    const out = normalizeSppFeatures(byLayer);
    if (!out.nodes.length) throw new Error('SPP returned no priced nodes');
    return { at: Date.now(), ...out };
  }

  function buildPayload(iso, entry, stale) {
    return {
      iso,
      fetchedAt: entry.at,
      stale,
      ttlMs: TTL_MS,
      interval: entry.interval,
      nodes: entry.nodes,
      constraints: entry.constraints,
    };
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/lmp', async (req, res) => {
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
        if (!ISOS.has(iso)) {
          sendJson(400, { error: 'iso must be nyiso or spp' });
          return;
        }
        await readDiskOnce(iso);
        const entry = mem.get(iso) || null;
        if (entry && Date.now() - entry.at < TTL_MS) {
          sendJson(200, buildPayload(iso, entry, false));
          return;
        }
        if (!inflight.has(iso)) {
          const refresh = iso === 'nyiso' ? refreshNyiso : refreshSpp;
          inflight.set(
            iso,
            refresh()
              .then(async (fresh) => {
                mem.set(iso, fresh);
                await writeDisk(iso, fresh);
                return fresh;
              })
              .catch((err) => {
                console.warn(
                  `[lmp-proxy] ${iso} refresh failed (${err?.message || err}); serving cache if any`,
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
        console.warn('[lmp-proxy] error:', err?.message || err);
        sendJson(500, { error: 'lmp proxy error' });
      }
    });
  };
  return {
    name: 'lmp-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
