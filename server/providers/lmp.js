import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  parseNyisoRealtimeTail,
  parseNyisoLimitingConstraints,
  parseNyisoDayFile,
  normalizeSppFeatures,
  normalizeNyisoRow,
} from '../../src/data/lmpFeeds.js';

/**
 * ISO real-time LMP proxy (SPP + NYISO), keyless, with memory + disk cache.
 *
 * Routes:
 *   GET /api/lmp?iso=nyiso → {iso, fetchedAt, stale, ttlMs, interval, nodes, constraints}
 *   GET /api/lmp?iso=spp   → same shape; SPP nodes carry lat/lon, NYISO nodes
 *                            are joined to bundled coordinates client-side.
 *   GET /api/lmp?iso=nyiso&date=YYYYMMDD
 *                          → {iso, kind:'da', date, fetchedAt, stale, ttlMs,
 *                             hours:[epoch ms], nodes:[{id, ptid, name,
 *                             lmp:[], mcc:[], mlc:[], mec:[]}]}: the whole
 *                            day-ahead generator LBMP file for that Eastern
 *                            day (damlbmp_gen, about 1 MB, 24 columns; the
 *                            next day's file is posted around 11:00 ET).
 *                            Dates outside the last ten days or past
 *                            tomorrow are rejected. SPP publishes its
 *                            day-ahead archive behind a portal token, so
 *                            `iso=spp&date=` answers 404 and history for SPP
 *                            comes from the private data seam.
 *
 * NYISO upstream: mis.nyiso.com daily realtime_gen.csv (about 8 MB by day
 * end). Only the last NYISO_TAIL_BYTES are read via HTTP Range; the parser
 * keeps the last complete interval. Filenames use the Eastern calendar day.
 * NYISO constraints come from currentLimitingConstraints.csv (tiny, no
 * coordinates); a failure there leaves `constraints` empty, never the nodes.
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
  const NYISO_CONSTRAINTS_URL =
    'https://mis.nyiso.com/public/csv/LimitingConstraints/currentLimitingConstraints.csv';
  const NYISO_CONSTRAINTS_MAX_BYTES = 262_144;
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

  async function fetchNyisoConstraints() {
    try {
      const res = await fetch(NYISO_CONSTRAINTS_URL, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parseNyisoLimitingConstraints(
        await readCapped(res, NYISO_CONSTRAINTS_MAX_BYTES),
      );
    } catch (err) {
      console.warn(
        `[lmp-proxy] NYISO constraints unavailable (${err?.message || err})`,
      );
      return [];
    }
  }

  async function refreshNyiso() {
    const constraintsPromise = fetchNyisoConstraints();
    for (const daysBack of [0, 1]) {
      const stamp = nyisoDayStamp(daysBack);
      let parsed = await fetchNyisoDay(stamp, NYISO_TAIL_BYTES);
      if (parsed === null && daysBack === 0) continue; // file not posted yet
      if (!parsed) parsed = await fetchNyisoDay(stamp, NYISO_MAX_BYTES - 1);
      if (!parsed) continue;
      return {
        at: Date.now(),
        interval: parsed.interval,
        // Sign flipped to the SPP convention (positive = priced up) and the
        // energy component derived; see normalizeNyisoRow.
        nodes: parsed.rows.map(normalizeNyisoRow).map((r) => ({
          id: `nyiso:${r.id}`,
          ptid: r.id,
          name: r.name,
          kind: 'gen',
          lmp: r.lmp,
          mcc: r.mcc,
          mlc: r.mlc,
          mec: r.mec,
        })),
        constraints: await constraintsPromise,
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

  const DAY_MAX_BYTES = 4_194_304;
  const DAY_PAST_TTL_MS = 6 * 3_600_000;
  const DAY_RECENT_TTL_MS = 900_000;
  const DAY_MISSING_TTL_MS = 900_000;
  const DAY_LOOKBACK = 10;
  const DATE_RE = /^\d{8}$/;
  /** @type {Map<string, {at:number, missing?:boolean, hours?:number[], nodes?:object[]}>} */
  const dayMem = new Map();
  /** @type {Map<string, Promise<object|null>>} */
  const dayInflight = new Map();

  const dayCachePath = (stamp) =>
    path.join(CACHE_DIR, `lmp-nyiso-da-${stamp}.json`);

  /** A day file is final once its Eastern day has fully passed. */
  function dayTtl(stamp) {
    return stamp < nyisoDayStamp(0) ? DAY_PAST_TTL_MS : DAY_RECENT_TTL_MS;
  }

  /** Accept only stamps from ten days back through tomorrow (Eastern). */
  function dayStampAllowed(stamp) {
    if (!DATE_RE.test(stamp)) return false;
    return stamp >= nyisoDayStamp(DAY_LOOKBACK) && stamp <= nyisoDayStamp(-1);
  }

  async function fetchNyisoDayFile(stamp) {
    const url = `https://mis.nyiso.com/public/csv/damlbmp/${stamp}damlbmp_gen.csv`;
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`NYISO HTTP ${res.status}`);
    const parsed = parseNyisoDayFile(await readCapped(res, DAY_MAX_BYTES));
    if (!parsed) throw new Error('NYISO day-ahead file had no rows');
    return { at: Date.now(), ...parsed };
  }

  async function readDayDisk(stamp) {
    if (dayMem.has(stamp)) return;
    try {
      const parsed = JSON.parse(
        await fsp.readFile(dayCachePath(stamp), 'utf8'),
      );
      if (Number.isFinite(parsed?.at) && Array.isArray(parsed?.hours)) {
        dayMem.set(stamp, parsed);
      }
    } catch {
      /* no disk cache yet */
    }
  }

  async function serveDay(stamp, sendJson) {
    await readDayDisk(stamp);
    const entry = dayMem.get(stamp) || null;
    const ttl = entry?.missing ? DAY_MISSING_TTL_MS : dayTtl(stamp);
    const payload = (e, stale) => ({
      iso: 'nyiso',
      kind: 'da',
      date: stamp,
      fetchedAt: e.at,
      stale,
      ttlMs: dayTtl(stamp),
      hours: e.hours,
      nodes: e.nodes,
    });
    if (entry && Date.now() - entry.at < ttl) {
      if (entry.missing)
        sendJson(404, {
          error: `NYISO day-ahead file for ${stamp} is not posted yet`,
        });
      else sendJson(200, payload(entry, false));
      return;
    }
    if (!dayInflight.has(stamp)) {
      dayInflight.set(
        stamp,
        fetchNyisoDayFile(stamp)
          .then(async (fresh) => {
            if (!fresh) {
              dayMem.set(stamp, { at: Date.now(), missing: true });
              return null;
            }
            dayMem.set(stamp, fresh);
            try {
              await fsp.mkdir(CACHE_DIR, { recursive: true });
              await fsp.writeFile(
                dayCachePath(stamp),
                JSON.stringify(fresh),
                'utf8',
              );
            } catch (err) {
              console.warn(
                '[lmp-proxy] day cache write failed:',
                err?.message || err,
              );
            }
            return fresh;
          })
          .catch((err) => {
            console.warn(
              `[lmp-proxy] nyiso day ${stamp} failed (${err?.message || err}); serving cache if any`,
            );
            return undefined;
          })
          .finally(() => {
            dayInflight.delete(stamp);
          }),
      );
    }
    const fresh = await dayInflight.get(stamp);
    if (fresh) sendJson(200, payload(fresh, false));
    else if (fresh === null)
      sendJson(404, {
        error: `NYISO day-ahead file for ${stamp} is not posted yet`,
      });
    else if (entry && !entry.missing) sendJson(200, payload(entry, true));
    else
      sendJson(502, {
        error: `nyiso day ${stamp} fetch failed and no cache available`,
      });
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
        const date = String(query.get('date') || '').trim();
        if (date) {
          if (iso !== 'nyiso') {
            sendJson(404, {
              error:
                'SPP publishes no keyless day-ahead archive; use the private data seam',
            });
            return;
          }
          if (!dayStampAllowed(date)) {
            sendJson(400, {
              error:
                'date must be YYYYMMDD within the last ten days through tomorrow',
            });
            return;
          }
          await serveDay(date, sendJson);
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
