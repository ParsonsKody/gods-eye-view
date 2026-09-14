import path from 'node:path';
import { promises as fsp } from 'node:fs';

import {
  parseNyisoFuelMixTail,
  parseNyisoLoadTail,
  parseNyisoLineOutages,
  parseSppGenMix,
  parseNrcReactorStatus,
} from '../../src/data/gridFeeds.js';

/**
 * Grid-conditions proxy (NYISO, SPP) and NRC reactor status, keyless, with
 * memory + disk cache.
 *
 * Routes:
 *   GET /api/grid?iso=nyiso → {iso, fetchedAt, stale, ttlMs, fuelMix, load, lineOutages}
 *   GET /api/grid?iso=spp   → same shape (SPP publishes no line outages, so
 *                             `lineOutages` is empty; `load` is the SPP load MW)
 *   GET /api/reactors       → {fetchedAt, stale, ttlMs, reportDate, units}
 *
 * NYISO upstream: the day files csv/rtfuelmix/<day>rtfuelmix.csv and
 * csv/pal/<day>pal.csv (5 min rows; the last 64 KB are read via HTTP Range
 * and the parser keeps the last complete interval; yesterday's file is
 * used until today's is posted) plus currentRTLineOutages.csv (tiny).
 * SPP upstream: portal.spp.org/chart-api/gen-mix/asFile (last two hours,
 * 5 min rows). NRC upstream: PowerReactorStatusForLast365Days.txt (about
 * 1.5 MB, daily); only the newest day is kept.
 *
 * TTL 60 s for the ISO feeds and 1 h for NRC, single-flight refresh, serve
 * stale on failure, byte-capped reads, hardcoded upstream hosts.
 *
 * @returns {import('vite').Plugin}
 */
export function gridProxy() {
  const TTL_MS = 60_000;
  const NRC_TTL_MS = 3_600_000;
  const TAIL_BYTES = 65_536;
  const SMALL_MAX_BYTES = 262_144;
  const NRC_MAX_BYTES = 4_194_304;
  const NYISO_BASE = 'https://mis.nyiso.com/public/csv';
  const NYISO_OUTAGES_URL = `${NYISO_BASE}/realtimelineoutages/currentRTLineOutages.csv`;
  const SPP_GEN_MIX_URL = 'https://portal.spp.org/chart-api/gen-mix/asFile';
  const NRC_URL =
    'https://www.nrc.gov/reading-rm/doc-collections/event-status/reactor-status/PowerReactorStatusForLast365Days.txt';
  const CACHE_DIR = path.join(process.cwd(), '.gev-cache');
  const KEYS = new Set(['nyiso', 'spp', 'reactors']);

  /** @type {Map<string, object>} */
  const mem = new Map();
  const diskChecked = new Set();
  /** @type {Map<string, Promise<object|null>>} */
  const inflight = new Map();

  const cachePath = (key) => path.join(CACHE_DIR, `grid-${key}.json`);
  const ttlFor = (key) => (key === 'reactors' ? NRC_TTL_MS : TTL_MS);

  async function readDiskOnce(key) {
    if (diskChecked.has(key)) return;
    diskChecked.add(key);
    try {
      const parsed = JSON.parse(await fsp.readFile(cachePath(key), 'utf8'));
      if (Number.isFinite(parsed?.at)) mem.set(key, parsed);
    } catch {
      /* no disk cache yet */
    }
  }

  async function writeDisk(key, entry) {
    try {
      await fsp.mkdir(CACHE_DIR, { recursive: true });
      await fsp.writeFile(cachePath(key), JSON.stringify(entry), 'utf8');
    } catch (err) {
      console.warn('[grid-proxy] cache write failed:', err?.message || err);
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

  async function fetchText(
    url,
    { range = null, maxBytes = SMALL_MAX_BYTES } = {},
  ) {
    const headers = range ? { Range: `bytes=-${range}` } : {};
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (res.status === 404) return null;
    if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
    return {
      text: await readCapped(res, maxBytes),
      partial: res.status === 206,
    };
  }

  /** Last complete interval of a NYISO day file, today then yesterday. */
  async function fetchNyisoDayTail(dir, suffix, parse) {
    for (const daysBack of [0, 1]) {
      const url = `${NYISO_BASE}/${dir}/${nyisoDayStamp(daysBack)}${suffix}`;
      const got = await fetchText(url, { range: TAIL_BYTES });
      if (!got) continue; // not posted yet
      const parsed = parse(got.text, { partialHead: got.partial });
      if (parsed) return parsed;
    }
    return null;
  }

  async function settle(label, promise) {
    try {
      return await promise;
    } catch (err) {
      console.warn(
        `[grid-proxy] ${label} unavailable (${err?.message || err})`,
      );
      return null;
    }
  }

  async function refreshNyiso() {
    const [fuelMix, load, outages] = await Promise.all([
      settle(
        'NYISO fuel mix',
        fetchNyisoDayTail('rtfuelmix', 'rtfuelmix.csv', parseNyisoFuelMixTail),
      ),
      settle(
        'NYISO load',
        fetchNyisoDayTail('pal', 'pal.csv', parseNyisoLoadTail),
      ),
      settle(
        'NYISO line outages',
        fetchText(NYISO_OUTAGES_URL).then((got) =>
          got ? parseNyisoLineOutages(got.text) : null,
        ),
      ),
    ]);
    if (!fuelMix && !load && !outages)
      throw new Error('every NYISO grid feed failed');
    return { at: Date.now(), fuelMix, load, lineOutages: outages || [] };
  }

  async function refreshSpp() {
    const got = await fetchText(SPP_GEN_MIX_URL);
    const mix = got ? parseSppGenMix(got.text) : null;
    if (!mix) throw new Error('SPP gen mix unavailable');
    const { load, ...fuelMix } = mix;
    return { at: Date.now(), fuelMix, load, lineOutages: [] };
  }

  async function refreshReactors() {
    const got = await fetchText(NRC_URL, { maxBytes: NRC_MAX_BYTES });
    const parsed = got ? parseNrcReactorStatus(got.text) : null;
    if (!parsed) throw new Error('NRC reactor status unavailable');
    return { at: Date.now(), ...parsed };
  }

  const REFRESH = {
    nyiso: refreshNyiso,
    spp: refreshSpp,
    reactors: refreshReactors,
  };

  function buildPayload(key, entry, stale) {
    const { at, ...rest } = entry;
    const head = { fetchedAt: at, stale, ttlMs: ttlFor(key) };
    return key === 'reactors'
      ? { ...head, ...rest }
      : { iso: key, ...head, ...rest };
  }

  async function serve(key, sendJson) {
    await readDiskOnce(key);
    const entry = mem.get(key) || null;
    if (entry && Date.now() - entry.at < ttlFor(key)) {
      sendJson(200, buildPayload(key, entry, false));
      return;
    }
    if (!inflight.has(key)) {
      inflight.set(
        key,
        REFRESH[key]()
          .then(async (fresh) => {
            mem.set(key, fresh);
            await writeDisk(key, fresh);
            return fresh;
          })
          .catch((err) => {
            console.warn(
              `[grid-proxy] ${key} refresh failed (${err?.message || err}); serving cache if any`,
            );
            return null;
          })
          .finally(() => {
            inflight.delete(key);
          }),
      );
    }
    const fresh = await inflight.get(key);
    if (fresh) sendJson(200, buildPayload(key, fresh, false));
    else if (entry) sendJson(200, buildPayload(key, entry, true));
    else sendJson(502, { error: `${key} fetch failed and no cache available` });
  }

  const installMiddleware = (server) => {
    const handler = (key) => async (req, res) => {
      const sendJson = (status, obj) => {
        if (res.headersSent) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      try {
        let target = key;
        if (!target) {
          const query = new URL(String(req.url || '/'), 'http://localhost')
            .searchParams;
          target = String(query.get('iso') || '').toLowerCase();
          if (!KEYS.has(target) || target === 'reactors') {
            sendJson(400, { error: 'iso must be nyiso or spp' });
            return;
          }
        }
        await serve(target, sendJson);
      } catch (err) {
        console.warn('[grid-proxy] error:', err?.message || err);
        sendJson(500, { error: 'grid proxy error' });
      }
    };
    server.middlewares.use('/api/grid', handler(null));
    server.middlewares.use('/api/reactors', handler('reactors'));
  };
  return {
    name: 'grid-proxy',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}
