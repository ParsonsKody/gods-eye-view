/**
 * Pure parsers and styling for the ISO LMP (congestion) layer. Shared by the
 * /api/lmp proxy (server) and src/data/isoLmp.js (client). No Cesium, no DOM.
 *
 * NYISO: the real-time generator LBMP CSV grows through the day; the proxy
 * reads only its tail with an HTTP Range request and this module extracts the
 * last complete 5-minute interval.
 *
 * SPP: the price-contour ArcGIS layers return hub, DC-tie, interface and
 * constraint points with live LMP components and coordinates.
 */

/** Diverging congestion palette: negative (blue) through zero (grey) to positive (red). */
export const MCC_NEGATIVE_COLOR = '#2979ff';
export const MCC_NEUTRAL_COLOR = '#b0bec5';
export const MCC_POSITIVE_COLOR = '#ff1744';
/** |MCC| in $/MWh at which the colour saturates. */
export const MCC_SATURATION = 20;
export const CONSTRAINT_COLOR = '#ffd600';

function splitCsvLine(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/**
 * Extract the last complete interval from (the tail of) a NYISO real-time
 * generator LBMP CSV. Columns: Time Stamp, Name, PTID, LBMP, Marginal Cost
 * Losses, Marginal Cost Congestion.
 * @param {string} text Full file or a byte-range tail (first line may be partial).
 * @param {object} [options]
 * @param {boolean} [options.partialHead=true] Drop the first line as partial.
 * @returns {{interval:string, rows:Array<{id:string,name:string,lmp:number,mlc:number,mcc:number}>}|null}
 *   null when no complete interval can be proven (caller should fetch more).
 */
export function parseNyisoRealtimeTail(text, { partialHead = true } = {}) {
  if (typeof text !== 'string' || !text.length) return null;
  const lines = text.split(/\r?\n/);
  if (partialHead) lines.shift();
  const groups = new Map();
  const order = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (
      !line ||
      line.startsWith('"Time Stamp"') ||
      line.startsWith('Time Stamp')
    )
      continue;
    const cols = splitCsvLine(line);
    if (cols.length < 6) continue;
    const ts = cols[0].trim();
    const id = cols[2].trim();
    const lmp = Number(cols[3]);
    const mlc = Number(cols[4]);
    const mcc = Number(cols[5]);
    if (!ts || !id || ![lmp, mlc, mcc].every(Number.isFinite)) continue;
    if (!groups.has(ts)) {
      groups.set(ts, []);
      order.push(ts);
    }
    groups.get(ts).push({ id, name: cols[1].trim(), lmp, mlc, mcc });
  }
  // The last group is complete only if an earlier group precedes it in this
  // window; otherwise the window may have started inside it.
  if (order.length < 2 && partialHead) return null;
  if (order.length === 0) return null;
  const interval = order[order.length - 1];
  return { interval, rows: groups.get(interval) };
}

const SPP_NODE_KINDS = Object.freeze({ 1: 'dc-tie', 2: 'hub', 3: 'interface' });
const SPP_CONSTRAINT_KINDS = Object.freeze({ 4: 'm2m', 5: 'binding' });

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Normalize SPP price-contour ArcGIS query results into layer rows.
 * @param {Record<string, object>} byLayer Map of layer id (1..5) to ArcGIS JSON
 *   ({features:[{attributes, geometry:{x,y}}]}, outSR 4326).
 * @returns {{interval:string|null, nodes:object[], constraints:object[]}}
 */
export function normalizeSppFeatures(byLayer) {
  const nodes = [];
  const constraints = [];
  let intervalMs = null;
  for (const [layerId, json] of Object.entries(byLayer || {})) {
    const features = Array.isArray(json?.features) ? json.features : [];
    const nodeKind = SPP_NODE_KINDS[layerId];
    const constraintKind = SPP_CONSTRAINT_KINDS[layerId];
    for (const feature of features) {
      const a = feature?.attributes || {};
      const lon = finite(feature?.geometry?.x);
      const lat = finite(feature?.geometry?.y);
      if (lon === null || lat === null) continue;
      const ms = finite(a.GMTINTERVALEND);
      if (ms !== null && (intervalMs === null || ms > intervalMs))
        intervalMs = ms;
      if (nodeKind) {
        const name = String(a.SETTLEMENT_LOCATION || a.PNODE || '').trim();
        const lmp = finite(a.LMP);
        if (!name || lmp === null) continue;
        nodes.push({
          id: `spp:${name}`,
          name,
          kind: nodeKind,
          lat,
          lon,
          lmp,
          mcc: finite(a.MCC) ?? 0,
          mlc: finite(a.MLC) ?? 0,
          mec: finite(a.MEC),
        });
      } else if (constraintKind) {
        const name = String(a.CONSTRAINT_NAME || '').trim();
        if (!name) continue;
        constraints.push({
          id: `spp:${constraintKind}:${name}`,
          name,
          kind: constraintKind,
          state: String(a.STATE || '').trim() || null,
          shadowPrice: finite(a.SHADOW_PRICE) ?? 0,
          lat,
          lon,
          monitored: String(a.MONITORED_FACILITY || '').trim() || null,
          contingent: String(a.CONTINGENT_FACILITY || '').trim() || null,
        });
      }
    }
  }
  return {
    interval: intervalMs === null ? null : new Date(intervalMs).toISOString(),
    nodes,
    constraints,
  };
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Diverging colour for a marginal congestion component.
 * @param {number} mcc $/MWh, negative or positive.
 * @returns {string} CSS hex colour.
 */
export function mccColor(mcc) {
  const v = Number(mcc);
  if (!Number.isFinite(v) || v === 0) return MCC_NEUTRAL_COLOR;
  const t = Math.min(1, Math.abs(v) / MCC_SATURATION);
  const from = hexToRgb(MCC_NEUTRAL_COLOR);
  const to = hexToRgb(v < 0 ? MCC_NEGATIVE_COLOR : MCC_POSITIVE_COLOR);
  return rgbToHex(from.map((c, i) => c + (to[i] - c) * t));
}

/**
 * Anchor size for a node: 5 px at zero congestion up to 14 px at saturation.
 * @param {number} mcc
 * @returns {number}
 */
export function mccPixelSize(mcc) {
  const v = Math.abs(Number(mcc)) || 0;
  return Math.round(5 + 9 * Math.min(1, v / MCC_SATURATION));
}

/**
 * Short label for a priced node: LMP with the signed congestion component.
 * @param {{lmp:number,mcc:number}} node
 * @returns {string}
 */
export function nodeLabel(node) {
  const lmp = Number(node?.lmp);
  const mcc = Number(node?.mcc) || 0;
  const sign = mcc > 0 ? '+' : '';
  return `$${Number.isFinite(lmp) ? lmp.toFixed(0) : '?'} (${sign}${mcc.toFixed(0)})`;
}
