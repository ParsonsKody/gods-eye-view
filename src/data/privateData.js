/**
 * The private data seam: a local folder of JSON files the app reads through
 * `/api/private/<name>.json`, filled by whatever the operator has (a
 * production-cost forecast, a market-data subscription, a settlement
 * database) and never checked in. The repository holds only the readers,
 * the schema and a synthetic fixture.
 *
 * `series.json` (version 1) carries hourly price series for priced nodes:
 *
 *   {
 *     "version": 1,
 *     "generated": "2026-09-15T02:10:00Z",
 *     "iso": "spp",
 *     "source": "free text shown in the layer panel",
 *     "demo": false,
 *     "hours": ["2026-09-08T05:00:00Z", ...],     // hourly, ascending, UTC
 *     "nodes": { "<key>": {"name", "lat", "lon", "kind"} },
 *     "series": {
 *       "da_forecast": { "<key>": [number|null, ...] },   // one per hour
 *       "da_actual":   { ... },
 *       "rt_actual":   { ... },
 *       "da_forecast_mcc": { ... },                       // optional
 *       "da_actual_mcc":   { ... }                        // optional
 *     }
 *   }
 *
 * Node keys use the LMP layer's ids (`spp:<settlement location>`,
 * `nyiso:<ptid>`) so a private series can dress a live node; keys the live
 * feed does not know are drawn from their own coordinates.
 *
 * Pure module: no Cesium, no DOM, no Node built-ins. The server route
 * resolver lives here too so it can be unit-tested with the parsers.
 */

import { HOUR_MS, snapToHour } from './timeCursor.js';

export const PRIVATE_API_URL = '/api/private';
export const PRIVATE_SERIES_VERSION = 1;
/** File names the route will serve; anything else is a 404. */
export const PRIVATE_FILE_NAMES = Object.freeze(['series', 'constraints', 'units']);
export const PRIVATE_SERIES_NAMES = Object.freeze([
  'da_forecast',
  'da_actual',
  'rt_actual',
  'da_forecast_mcc',
  'da_actual_mcc',
]);
/** Trailing window for the forecast MAE row, in hours. */
export const MAE_WINDOW_HOURS = 168;

const FILE_RE = /^\/([a-z_]+)\.json$/;

/**
 * Decide what `/api/private<urlPath>` should do. Pure so the server plugin
 * stays a thin wrapper.
 * @param {{dir?:string|null, urlPath:string}} input
 * @returns {{status:number, name?:string, error?:string}}
 */
export function resolvePrivateDataRequest({ dir, urlPath }) {
  const m = FILE_RE.exec(String(urlPath || '').split('?')[0]);
  if (!m || !PRIVATE_FILE_NAMES.includes(m[1])) {
    return { status: 404, error: 'unknown private data file' };
  }
  // 204, not 404: an unset seam is the normal state, and browsers log every
  // 404 as a console error.
  if (!dir || !String(dir).trim()) {
    return { status: 204, error: 'GEV_PRIVATE_DATA_DIR is not set' };
  }
  return { status: 200, name: m[1] };
}

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate and index a series.json document.
 * @param {object} json Parsed file.
 * @returns {{version:number, generated:string|null, iso:string, source:string|null, demo:boolean, hours:number[], index:Map<number,number>, nodes:Map<string,object>, series:Record<string, Map<string, Array<number|null>>>}}
 */
export function parsePrivateSeries(json) {
  if (!json || typeof json !== 'object') throw new Error('series.json is not an object');
  if (Number(json.version) !== PRIVATE_SERIES_VERSION) {
    throw new Error(
      `series.json version ${json.version} is not ${PRIVATE_SERIES_VERSION}`,
    );
  }
  const hours = [];
  for (const raw of Array.isArray(json.hours) ? json.hours : []) {
    const ms = Date.parse(String(raw));
    if (!Number.isFinite(ms)) throw new Error(`bad hour stamp ${raw}`);
    const snapped = snapToHour(ms);
    if (hours.length && snapped <= hours[hours.length - 1])
      throw new Error('hours must be ascending and unique');
    hours.push(snapped);
  }
  if (!hours.length) throw new Error('series.json has no hours');
  const index = new Map(hours.map((ms, i) => [ms, i]));

  const nodes = new Map();
  for (const [key, node] of Object.entries(json.nodes || {})) {
    const lat = finite(node?.lat);
    const lon = finite(node?.lon);
    if (lat === null || lon === null) continue;
    nodes.set(key, {
      key,
      name: String(node?.name || key),
      lat,
      lon,
      kind: String(node?.kind || 'node'),
    });
  }

  const series = {};
  for (const name of PRIVATE_SERIES_NAMES) {
    const byKey = json.series?.[name];
    if (!byKey || typeof byKey !== 'object') continue;
    const map = new Map();
    for (const [key, values] of Object.entries(byKey)) {
      if (!Array.isArray(values)) continue;
      const row = new Array(hours.length).fill(null);
      for (let i = 0; i < Math.min(values.length, hours.length); i++)
        row[i] = finite(values[i]);
      map.set(key, row);
    }
    series[name] = map;
  }

  return {
    version: PRIVATE_SERIES_VERSION,
    generated: json.generated ? String(json.generated) : null,
    iso: String(json.iso || '').toLowerCase(),
    source: json.source ? String(json.source) : null,
    demo: Boolean(json.demo),
    hours,
    index,
    nodes,
    series,
  };
}

/** One value, or null when the hour or node is not in the file. */
export function seriesValueAt(parsed, name, key, hourMs) {
  const i = parsed?.index?.get(snapToHour(hourMs));
  if (i === undefined) return null;
  const row = parsed.series?.[name]?.get(key);
  return row ? row[i] : null;
}

/**
 * Everything the card needs for one node at one hour.
 * @returns {{forecast:number|null, daActual:number|null, rtActual:number|null, forecastMcc:number|null, daActualMcc:number|null, error:number|null}}
 */
export function nodeSnapshot(parsed, key, hourMs) {
  const at = (name) => seriesValueAt(parsed, name, key, hourMs);
  const forecast = at('da_forecast');
  const daActual = at('da_actual');
  return {
    forecast,
    daActual,
    rtActual: at('rt_actual'),
    forecastMcc: at('da_forecast_mcc'),
    daActualMcc: at('da_actual_mcc'),
    error:
      forecast !== null && daActual !== null
        ? Math.round((forecast - daActual) * 100) / 100
        : null,
  };
}

/**
 * Mean absolute forecast error over the hours before and including
 * `hourMs`, within `windowHours`. Hours missing either side are skipped.
 * @returns {{mae:number|null, n:number}}
 */
export function trailingMae(parsed, key, hourMs, windowHours = MAE_WINDOW_HOURS) {
  const end = snapToHour(hourMs);
  if (end === null) return { mae: null, n: 0 };
  const start = end - windowHours * HOUR_MS;
  const fc = parsed?.series?.da_forecast?.get(key);
  const act = parsed?.series?.da_actual?.get(key);
  if (!fc || !act) return { mae: null, n: 0 };
  let sum = 0;
  let n = 0;
  for (let i = 0; i < parsed.hours.length; i++) {
    const h = parsed.hours[i];
    if (h <= start || h > end) continue;
    if (fc[i] === null || act[i] === null) continue;
    sum += Math.abs(fc[i] - act[i]);
    n += 1;
  }
  return { mae: n ? Math.round((sum / n) * 100) / 100 : null, n };
}

/**
 * Shift a fixture so its declared "now" hour lands on the wall clock. The
 * bundled demo file would otherwise slide out of the cursor window within
 * days. Returns a new raw document; the input is not mutated.
 * @param {object} json Raw series.json with `demo_now_index`.
 * @param {number} nowMs
 */
export function rebaseSeriesToNow(json, nowMs) {
  const anchor = Number(json?.demo_now_index);
  const hours = Array.isArray(json?.hours) ? json.hours : [];
  if (!Number.isInteger(anchor) || anchor < 0 || anchor >= hours.length) return json;
  const anchorMs = snapToHour(Date.parse(hours[anchor]));
  const shift = snapToHour(nowMs) - anchorMs;
  return {
    ...json,
    hours: hours.map((h) => new Date(snapToHour(Date.parse(h)) + shift).toISOString()),
  };
}

/**
 * Loader for the browser: the private file when the seam is configured,
 * the bundled fixture (marked demo) when it is not (204 from the route) or
 * the file is missing (404). A malformed private file is an error, never
 * silently replaced by the demo.
 * @param {{fetchImpl?:typeof fetch, fixtureUrl:string, now?:() => number}} options
 * @returns {() => Promise<{data:object, source:'private'|'fixture'}>}
 */
export function createPrivateSeriesLoader({
  fetchImpl = (...args) => fetch(...args),
  fixtureUrl,
  now = () => Date.now(),
}) {
  return async function loadPrivateSeries() {
    const res = await fetchImpl(`${PRIVATE_API_URL}/series.json`);
    if (res.ok) {
      return { data: parsePrivateSeries(await res.json()), source: 'private' };
    }
    if (res.status !== 204 && res.status !== 404)
      throw new Error(`private series HTTP ${res.status}`);
    const fixture = await fetchImpl(fixtureUrl);
    if (!fixture.ok) throw new Error(`fixture HTTP ${fixture.status}`);
    const raw = rebaseSeriesToNow(await fixture.json(), now());
    const data = parsePrivateSeries({ ...raw, demo: true });
    return { data, source: 'fixture' };
  };
}
