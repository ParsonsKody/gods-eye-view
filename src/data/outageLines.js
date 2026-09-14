/**
 * Place NYISO real-time line outages on the bundled HIFLD lines and read
 * the neighbourhood of a constrained line (outages, derated reactors).
 * Pure; used by the transmission-lines layer and its tests.
 *
 * An outage names its line as two EMS station short names plus kV and
 * circuit (`BECK____-NIAGARA__230_PA27`, split by parseNyisoEquipmentName).
 * It lands on a bundled line when the kV agrees within 10 and both ends
 * match the line's `sub_1` / `sub_2` (namesMatch: normalised equality or a
 * 4+ character prefix). EMS names and HIFLD names agree only part of the
 * time, so the layer legend reports how many outages were placed.
 */
import { distanceToPartKm, namesMatch } from './constraintLines.js';
import { shortDate } from './gridFeeds.js';

const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQ = 111.32;

function endsMatch(record, outage) {
  const a = record?.sub_1;
  const b = record?.sub_2;
  return (
    (namesMatch(outage.from, a) && namesMatch(outage.to, b)) ||
    (namesMatch(outage.from, b) && namesMatch(outage.to, a))
  );
}

/**
 * @param {Array<{kind:string, from:string, to:string|null, kv:number|null}>} outages
 *   From parseNyisoLineOutages.
 * @param {Array<{positions:number[][], record:object}>} parts Line parts
 *   (see lineParts in transmissionLines.js).
 * @returns {{byRecord:Map<object, object[]>, matched:number, total:number}}
 *   `byRecord` maps a line record to the outages on it; `total` counts the
 *   line outages (station equipment is not a line and is left out).
 */
export function matchOutagesToLines(outages, parts) {
  const byRecord = new Map();
  const lines = (outages || []).filter((o) => o?.kind === 'line' && o.to);
  const total = lines.length;
  if (!total || !parts?.length) return { byRecord, matched: 0, total };
  const records = [...new Set(parts.map((part) => part.record))];
  let matched = 0;
  for (const outage of lines) {
    let hit = false;
    for (const record of records) {
      const kv = Number(record?.kv);
      if (
        Number.isFinite(outage.kv) &&
        Number.isFinite(kv) &&
        Math.abs(kv - outage.kv) >= 10
      )
        continue;
      if (!endsMatch(record, outage)) continue;
      if (!byRecord.has(record)) byRecord.set(record, []);
      byRecord.get(record).push(outage);
      hit = true;
    }
    if (hit) matched += 1;
  }
  return { byRecord, matched, total };
}

/** `09/14/2026 08:49:00` -> `14 Sep 08:49 ET`. */
export function sinceText(stamp) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2})/.exec(
    String(stamp || ''),
  );
  if (!m) return String(stamp || '');
  return `${shortDate(`${m[3]}-${m[1]}-${m[2]}`)} ${m[4]} ET`;
}

/** Short name of an outage: `BECK-NIAGARA 230 PA27`. */
export function outageName(outage) {
  return [
    `${outage?.from || '?'}-${outage?.to || '?'}`,
    Number.isFinite(outage?.kv) ? String(outage.kv) : null,
    outage?.circuit || null,
  ]
    .filter(Boolean)
    .join(' ');
}

/** Card line for one outage on the line: `Outage: BECK-NIAGARA 230 PA27 · since 14 Sep 08:49 ET`. */
export function outageCopy(outage) {
  return `Outage: ${outageName(outage)} · since ${sinceText(outage?.since)}`;
}

/** Midpoint of a line's first part, or null. */
function partsMidpoint(partsPositions) {
  const first = partsPositions?.[0];
  if (!first?.length) return null;
  const pair = first[Math.floor(first.length / 2)];
  return Array.isArray(pair) ? { lon: pair[0], lat: pair[1] } : null;
}

/** Minimum distance in km from a point to any of a line's parts. */
function distanceToLineKm(lon, lat, partsPositions) {
  let best = Infinity;
  for (const positions of partsPositions || []) {
    best = Math.min(best, distanceToPartKm(lon, lat, positions));
  }
  return best;
}

/**
 * Outages in the neighbourhood of a (constrained) line: those placed on a
 * line that shares an end name with it, or whose line passes within `km`.
 * @param {object} record The constrained line record.
 * @param {number[][][]} partsPositions That line's parts.
 * @param {Map<object, object[]>} byRecord From matchOutagesToLines.
 * @param {Map<string, number[][][]>} partsById Line id -> parts.
 * @param {{km?:number}} [options]
 * @returns {object[]} Outages, nearest first, this line's own left out.
 */
export function nearbyOutages(
  record,
  partsPositions,
  byRecord,
  partsById,
  { km = 30 } = {},
) {
  const out = [];
  for (const [other, outages] of byRecord || []) {
    if (other === record) continue;
    const shared =
      namesMatch(other?.sub_1, record?.sub_1) ||
      namesMatch(other?.sub_1, record?.sub_2) ||
      namesMatch(other?.sub_2, record?.sub_1) ||
      namesMatch(other?.sub_2, record?.sub_2);
    let distance = shared ? 0 : Infinity;
    if (!shared) {
      const mid = partsMidpoint(partsById?.get(other?.id));
      if (mid) distance = distanceToLineKm(mid.lon, mid.lat, partsPositions);
    }
    if (distance > km) continue;
    for (const outage of outages) out.push({ ...outage, distanceKm: distance });
  }
  out.sort((a, b) => a.distanceKm - b.distanceKm);
  return out;
}

/**
 * Reactor units under `belowPct` within `km` of a line.
 * @param {number[][][]} partsPositions The line's parts.
 * @param {Array<{unit:string, lon:number, lat:number}>} units Reactor sidecar rows.
 * @param {{reportDate:string, units:Object<string, number>}|null} status NRC payload.
 * @param {{km?:number, belowPct?:number}} [options]
 * @returns {Array<{unit:string, pct:number, distanceKm:number}>}
 */
export function nuclearNearby(
  partsPositions,
  units,
  status,
  { km = 80, belowPct = 90 } = {},
) {
  const out = [];
  if (!status?.units) return out;
  for (const u of units || []) {
    const pct = Number(status.units[u.unit]);
    if (!Number.isFinite(pct) || pct >= belowPct) continue;
    if (!Number.isFinite(u.lon) || !Number.isFinite(u.lat)) continue;
    const distance = distanceToLineKm(u.lon, u.lat, partsPositions);
    if (distance <= km) out.push({ unit: u.unit, pct, distanceKm: distance });
  }
  out.sort((a, b) => a.distanceKm - b.distanceKm);
  return out;
}

export { KM_PER_DEG_LAT, KM_PER_DEG_LON_EQ };
