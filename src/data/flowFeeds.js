/**
 * Pure parsers and copy for the ISO interface-flow layer. Shared by the
 * /api/interface-flows proxy (server) and src/data/interfaceFlows.js
 * (client). No Cesium, no DOM.
 *
 * NYISO publishes currentExternalLimitsFlows.csv every 5 minutes: one row
 * per interface with the flow in MW and its positive and negative limits.
 * A limit of 9999 (or -9999) means "no limit posted".
 */

import { formatIntervalEt } from './lmpFeeds.js';

/** Utilization bands: under 60 %, 60 to 90, 90 and over, no limit posted. */
export const FLOW_BAND_COLORS = Object.freeze({
  low: '#00c853',
  mid: '#ffab00',
  high: '#ff1744',
  none: '#90a4ae',
});
export const FLOW_BAND_LABELS = Object.freeze({
  low: 'under 60% of limit',
  mid: '60 to 90% of limit',
  high: '90% of limit and over',
  none: 'no limit posted',
});
const LIMIT_SENTINEL = 9999;

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

function limitOrNull(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) >= LIMIT_SENTINEL) return null;
  return n;
}

/**
 * Parse the NYISO interface flows CSV (the `current` file or a day file)
 * and keep the rows of the latest timestamp.
 * Columns: Timestamp, Interface Name, Point ID, Flow (MWH),
 * Positive Limit (MWH), Negative Limit (MWH).
 * @param {string} text
 * @returns {{interval:string|null, flows:Array<{name:string, ptid:string, flowMw:number, posLimitMw:number|null, negLimitMw:number|null}>}}
 */
export function parseNyisoInterfaceFlows(text) {
  const lines = String(text || '').split(/\r?\n/);
  const header = splitCsvLine(lines.shift() || '').map((h) =>
    h.trim().toLowerCase(),
  );
  const col = (needle) => header.findIndex((h) => h.startsWith(needle));
  const iStamp = col('timestamp');
  const iName = col('interface name');
  const iPtid = col('point id');
  const iFlow = col('flow');
  const iPos = col('positive limit');
  const iNeg = col('negative limit');
  if ([iStamp, iName, iFlow, iPos, iNeg].some((i) => i < 0))
    return { interval: null, flows: [] };
  const byStamp = new Map();
  const order = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const cols = splitCsvLine(line);
    const stamp = String(cols[iStamp] || '').trim();
    const name = String(cols[iName] || '').trim();
    const flowMw = Number(cols[iFlow]);
    if (!stamp || !name || !Number.isFinite(flowMw)) continue;
    if (!byStamp.has(stamp)) {
      byStamp.set(stamp, []);
      order.push(stamp);
    }
    byStamp.get(stamp).push({
      name,
      ptid: String(cols[iPtid] ?? '').trim(),
      flowMw,
      posLimitMw: limitOrNull(cols[iPos]),
      negLimitMw: limitOrNull(cols[iNeg]),
    });
  }
  if (!order.length) return { interval: null, flows: [] };
  const interval = order[order.length - 1];
  return { interval, flows: byStamp.get(interval) };
}

/**
 * Share of the limit in use, in the direction the flow is going.
 * @param {{flowMw:number, posLimitMw:number|null, negLimitMw:number|null}} row
 * @returns {number|null} 0..1+ or null when no limit is posted that way.
 */
export function flowUtilization(row) {
  const flow = Number(row?.flowMw);
  if (!Number.isFinite(flow)) return null;
  const limit = flow >= 0 ? row?.posLimitMw : row?.negLimitMw;
  if (limit === null || limit === undefined) return null;
  const denom = Math.abs(Number(limit));
  if (!(denom > 0)) return null;
  return Math.abs(flow) / denom;
}

/**
 * @param {number|null} utilization
 * @returns {'low'|'mid'|'high'|'none'}
 */
export function flowBand(utilization) {
  if (utilization === null || !Number.isFinite(utilization)) return 'none';
  if (utilization >= 0.9) return 'high';
  if (utilization >= 0.6) return 'mid';
  return 'low';
}

function mw(value) {
  const v = Number(value);
  return Number.isFinite(v)
    ? `${Math.round(Math.abs(v)).toLocaleString('en-US')} MW`
    : '?';
}

function pct(utilization) {
  return utilization === null || !Number.isFinite(utilization)
    ? null
    : `${Math.round(utilization * 100)}%`;
}

function ago(nowMs, thenMs) {
  const delta = Number(nowMs) - Number(thenMs);
  if (!Number.isFinite(delta) || delta < 0) return null;
  const minutes = Math.floor(delta / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

/**
 * Short ambient label under the arrow: `PJM to NY · 81%`.
 * @param {object} record Flow record joined to its interface row.
 * @returns {string}
 */
export function flowLabel(record) {
  const share = pct(flowUtilization(record));
  return share ? `${record.label} · ${share}` : `${record.label} · ${mw(record.flowMw)}`;
}

/**
 * Title and detail rows for the hover / pinned card.
 * @param {object} record Flow record: feed row plus `label`, `forward`,
 *   `reverse`, `interval`, `fetchedAt`.
 * @param {{nowMs?:number}} [options]
 * @returns {{title:string, details:string[]}}
 */
export function flowCardCopy(record, { nowMs = Date.now() } = {}) {
  const flow = Number(record?.flowMw) || 0;
  const direction = flow < 0 ? record?.reverse : record?.forward;
  const utilization = flowUtilization(record);
  const limit = flow < 0 ? record?.negLimitMw : record?.posLimitMw;
  const share = pct(utilization);
  const details = [
    [
      `${mw(flow)}${direction ? ` ${direction}` : ''}`,
      share && limit !== null && limit !== undefined
        ? `${share} of ${mw(limit)}`
        : 'no limit posted this way',
    ].join(' · '),
  ];
  const limits = [
    record?.posLimitMw === null || record?.posLimitMw === undefined
      ? null
      : `+${mw(record.posLimitMw)}`,
    record?.negLimitMw === null || record?.negLimitMw === undefined
      ? null
      : `-${mw(record.negLimitMw)}`,
  ].filter(Boolean);
  if (limits.length) details.push(`Limits ${limits.join(' / ')}`);
  const when = [
    formatIntervalEt('nyiso', record?.interval)
      ? `${formatIntervalEt('nyiso', record?.interval)} interval`
      : null,
    record?.fetchedAt ? `updated ${ago(nowMs, record.fetchedAt)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  if (when) details.push(when);
  return { title: record?.label || record?.name || 'Interface', details };
}

/**
 * Legend rows: interface count per utilization band.
 * @param {object[]} records
 * @returns {Array<{color:string,label:string,count:number,blurb:string}>}
 */
export function flowLegend(records) {
  const counts = { low: 0, mid: 0, high: 0, none: 0 };
  for (const r of records || []) counts[flowBand(flowUtilization(r))] += 1;
  return ['high', 'mid', 'low', 'none'].map((band) => ({
    color: FLOW_BAND_COLORS[band],
    label: FLOW_BAND_LABELS[band],
    count: counts[band],
    blurb: 'Arrow points the way power flows; size follows the share of the limit',
  }));
}
