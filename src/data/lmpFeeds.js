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

/**
 * Parse NYISO's limiting constraints CSV (current or day file) and keep the
 * rows of the latest timestamp. Columns: Time Stamp, Time Zone, Limiting
 * Facility, Facility PTID, Contingency, Constraint Cost($). The cost is
 * NYISO's (negative) shadow price. No coordinates come with it.
 * @param {string} text
 * @returns {Array<{id:string,name:string,kind:'binding',ptid:string,contingent:string|null,shadowPrice:number,monitored:string,state:null,interval:string}>}
 */
export function parseNyisoLimitingConstraints(text) {
  const lines = String(text || '').split(/\r?\n/);
  const header = splitCsvLine(lines.shift() || '').map((h) =>
    h.trim().toLowerCase(),
  );
  const col = (needle) => header.findIndex((h) => h.startsWith(needle));
  const iStamp = col('time stamp');
  const iName = col('limiting facility');
  const iPtid = col('facility ptid');
  const iCont = col('contingency');
  const iCost = col('constraint cost');
  if ([iStamp, iName, iCost].some((i) => i < 0)) return [];
  const byStamp = new Map();
  const order = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const cols = splitCsvLine(line);
    const stamp = String(cols[iStamp] || '').trim();
    const name = String(cols[iName] || '').trim();
    const cost = Number(cols[iCost]);
    if (!stamp || !name || !Number.isFinite(cost)) continue;
    if (!byStamp.has(stamp)) {
      byStamp.set(stamp, []);
      order.push(stamp);
    }
    const ptid = String(cols[iPtid] ?? '').trim();
    byStamp.get(stamp).push({
      id: `nyiso:binding:${ptid || name}`,
      name,
      kind: 'binding',
      ptid,
      contingent: String(cols[iCont] ?? '').trim() || null,
      shadowPrice: cost,
      monitored: name,
      state: null,
      interval: stamp,
    });
  }
  if (!order.length) return [];
  return byStamp.get(order[order.length - 1]);
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
 * @param {number} [saturation=MCC_SATURATION] |value| at which the colour saturates.
 * @returns {string} CSS hex colour.
 */
export function mccColor(mcc, saturation = MCC_SATURATION) {
  const v = Number(mcc);
  if (!Number.isFinite(v) || v === 0) return MCC_NEUTRAL_COLOR;
  const t = Math.min(1, Math.abs(v) / saturation);
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

/**
 * NYISO publishes LBMP = energy + losses - congestion, so its congestion
 * component is positive where congestion LOWERS the price. SPP, and the
 * colour scale of the layer, use LMP = energy + congestion + losses. Flip
 * the NYISO sign so a positive congestion component means "priced up" for
 * both ISOs, and derive the energy component the file does not carry.
 * @param {{lmp:number,mlc:number,mcc:number}} row Parsed NYISO row.
 * @returns {object} Row with SPP-convention `mcc` and a derived `mec`.
 */
export function normalizeNyisoRow(row) {
  const lmp = Number(row?.lmp);
  const mlc = Number(row?.mlc);
  const mcc = -Number(row?.mcc);
  return { ...row, mcc, mec: round2(lmp - mlc - mcc) };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

const NYISO_STAMP = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})/;

/**
 * Interval stamp as Eastern wall-clock "HH:MM ET". NYISO stamps are already
 * Eastern ("MM/DD/YYYY HH:MM:SS"); SPP stamps are ISO UTC.
 * @param {string} iso 'nyiso' | 'spp'.
 * @param {string|null|undefined} interval Feed interval string.
 * @returns {string|null}
 */
export function formatIntervalEt(iso, interval) {
  if (!interval) return null;
  if (iso === 'nyiso') {
    const m = NYISO_STAMP.exec(String(interval));
    return m ? `${m[4]}:${m[5]} ET` : null;
  }
  const ms = Date.parse(String(interval));
  if (!Number.isFinite(ms)) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${hour}:${get('minute')} ET`;
}

function money(value, { signed = false, decimals = 2 } = {}) {
  const v = Number(value);
  if (!Number.isFinite(v)) return '?';
  const abs = Math.abs(v).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  if (v < 0) return `-$${abs}`;
  return `${signed && v > 0 ? '+' : ''}$${abs}`;
}

function ago(nowMs, thenMs) {
  const delta = Number(nowMs) - Number(thenMs);
  if (!Number.isFinite(delta) || delta < 0) return null;
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

const KIND_LABELS = Object.freeze({
  gen: 'gen',
  hub: 'hub',
  'dc-tie': 'DC tie',
  interface: 'interface',
  binding: 'binding',
  m2m: 'M2M',
});

/**
 * Title and detail rows for the hover / pinned detail card.
 * @param {object} record Priced node or constraint record as drawn.
 * @param {object} [options]
 * @param {number} [options.nowMs] Clock for the "updated N ago" row.
 * @returns {{title:string, details:string[]}}
 */
export function lmpCardCopy(record, { nowMs = Date.now() } = {}) {
  const iso = String(record?.iso || '').toUpperCase();
  const kind = KIND_LABELS[record?.kind] || String(record?.kind || '');
  const title = `${iso} ${kind} · ${record?.name || '?'}`.trim();
  const when = [
    formatIntervalEt(record?.iso, record?.interval)
      ? `${formatIntervalEt(record?.iso, record?.interval)} interval`
      : null,
    record?.fetchedAt ? `updated ${ago(nowMs, record.fetchedAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const details = [];
  if (record?.kind === 'binding' || record?.kind === 'm2m') {
    details.push(
      [
        `Shadow price ${money(record.shadowPrice, { decimals: 0 })}/MWh`,
        record.state || null,
      ]
        .filter(Boolean)
        .join(' · '),
    );
    if (record.monitored) details.push(`Monitored: ${record.monitored}`);
    if (record.contingent) details.push(`Contingency: ${record.contingent}`);
  } else {
    details.push(`LMP ${money(record?.lmp)}/MWh`);
    details.push(
      [
        `Energy ${money(record?.mec)}`,
        `Congestion ${money(record?.mcc, { signed: true })}`,
        `Losses ${money(record?.mlc, { signed: true })}`,
      ].join(' · '),
    );
  }
  if (when) details.push(when);
  return { title, details };
}

/**
 * Legend rows for the layer panel: counts of priced nodes by congestion
 * sign plus the constraint count.
 * @param {object[]} points Priced node records.
 * @param {object[]} constraints Constraint records.
 * @returns {Array<{color:string,label:string,count:number,blurb:string}>}
 */
export function lmpLegend(points, constraints) {
  let up = 0;
  let down = 0;
  let flat = 0;
  for (const p of points || []) {
    const v = Number(p?.mcc) || 0;
    if (v > 0) up += 1;
    else if (v < 0) down += 1;
    else flat += 1;
  }
  return [
    {
      color: MCC_POSITIVE_COLOR,
      label: 'congestion raises price',
      count: up,
      blurb: 'Positive congestion component; colour saturates at $20/MWh',
    },
    {
      color: MCC_NEGATIVE_COLOR,
      label: 'congestion lowers price',
      count: down,
      blurb: 'Negative congestion component; colour saturates at -$20/MWh',
    },
    {
      color: MCC_NEUTRAL_COLOR,
      label: 'no congestion',
      count: flat,
      blurb: 'Congestion component is zero',
    },
    {
      color: CONSTRAINT_COLOR,
      label: 'SPP constraint',
      count: (constraints || []).length,
      blurb: 'Binding or M2M constraint, sized by shadow price',
    },
  ];
}
