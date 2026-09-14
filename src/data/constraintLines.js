/**
 * Match ISO binding constraints to bundled HIFLD transmission lines. Pure;
 * used by the transmission-lines layer and its tests.
 *
 * Why spatial first: constraint facilities carry EMS short names (`NHAYS`,
 * `VINETAP3`) that rarely equal the HIFLD substation names (`NORTH HAYS`),
 * so a name join alone finds almost nothing (3 of 62 live SPP constraints
 * on 2026-09-14). SPP does publish a point per constraint, placed at the
 * monitored substation, and 77 of 80 of those sit within 1 km of a bundled
 * line. So an SPP constraint marks every line at that substation, narrowed
 * to one line when an end name does match. NYISO constraints have no
 * point, only `A kv B kv circuit`, so they match by name and kV alone.
 */

const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQ = 111.32;
const SPP_FACILITY = /^(LN|XFMR|BRK)\s+(.+?)\s+-\s+(.+)$/i;
const NYISO_FACILITY = /^(.+?)\s+(\d{2,3})\s+(.+?)\s+(\d{2,3})\s+\S+$/;

function norm(text) {
  return String(text || '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
}

/** Normalised equality, or a 4+ character prefix either way. */
export function namesMatch(a, b) {
  const x = norm(a);
  const y = norm(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const short = x.length < y.length ? x : y;
  const long = x.length < y.length ? y : x;
  return short.length >= 4 && long.startsWith(short);
}

function segmentDistanceKm(px, py, ax, ay, bx, by, kmPerDegLon) {
  const ax2 = ax * kmPerDegLon;
  const bx2 = bx * kmPerDegLon;
  const px2 = px * kmPerDegLon;
  const ay2 = ay * KM_PER_DEG_LAT;
  const by2 = by * KM_PER_DEG_LAT;
  const py2 = py * KM_PER_DEG_LAT;
  const dx = bx2 - ax2;
  const dy = by2 - ay2;
  let t = 0;
  const len2 = dx * dx + dy * dy;
  if (len2 > 0) {
    t = ((px2 - ax2) * dx + (py2 - ay2) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const ex = ax2 + t * dx - px2;
  const ey = ay2 + t * dy - py2;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Minimum distance in km from a point to a lon/lat polyline. */
export function distanceToPartKm(lon, lat, positions) {
  const kmPerDegLon = KM_PER_DEG_LON_EQ * Math.cos((lat * Math.PI) / 180);
  let best = Infinity;
  for (let i = 0; i + 1 < positions.length; i++) {
    const [ax, ay] = positions[i];
    const [bx, by] = positions[i + 1];
    const d = segmentDistanceKm(lon, lat, ax, ay, bx, by, kmPerDegLon);
    if (d < best) best = d;
  }
  return best;
}

function bbox(positions) {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of positions) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLon, maxLon, minLat, maxLat };
}

/**
 * Parse a monitored-facility string into its end names and kV.
 * @param {object} constraint `{iso, name, monitored}`.
 * @returns {{ends:string[], kv:number|null, element:string|null}}
 */
export function facilityEnds(constraint) {
  const text = String(constraint?.monitored || constraint?.name || '').trim();
  if (constraint?.iso === 'nyiso') {
    const m = NYISO_FACILITY.exec(text);
    if (!m) return { ends: [], kv: null, element: null };
    return { ends: [m[1], m[3]], kv: Number(m[2]), element: 'LN' };
  }
  const m = SPP_FACILITY.exec(text);
  if (!m) return { ends: [], kv: null, element: null };
  return {
    ends: m[1].toUpperCase() === 'LN' ? [m[2], m[3]] : [],
    kv: null,
    element: m[1].toUpperCase(),
  };
}

function endMatches(record, ends) {
  return ends.some(
    (end) => namesMatch(end, record?.sub_1) || namesMatch(end, record?.sub_2),
  );
}

/**
 * @param {object[]} constraints Constraint records from /api/lmp
 *   (`{iso, name, monitored, shadowPrice, lat?, lon?}`).
 * @param {Array<{positions:number[][], record:object}>} parts Line parts
 *   (see lineParts in transmissionLines.js).
 * @param {{radiusKm?:number}} [options]
 * @returns {{byRecord:Map<object, object>, matched:number, total:number}}
 *   `byRecord` maps a line record to the constraint with the largest
 *   |shadow price| that touches it.
 */
export function matchConstraintsToLines(
  constraints,
  parts,
  { radiusKm = 1 } = {},
) {
  const byRecord = new Map();
  const total = (constraints || []).length;
  if (!total || !parts?.length) return { byRecord, matched: 0, total };

  const boxes = parts.map((part) => bbox(part.positions));
  const byName = new Map();
  for (const part of parts) {
    for (const key of [norm(part.record?.sub_1), norm(part.record?.sub_2)]) {
      if (!key) continue;
      if (!byName.has(key)) byName.set(key, []);
      byName.get(key).push(part);
    }
  }
  const nameIndex = [...byName.entries()];

  const assign = (part, constraint) => {
    const current = byRecord.get(part.record);
    if (
      !current ||
      Math.abs(constraint.shadowPrice || 0) > Math.abs(current.shadowPrice || 0)
    )
      byRecord.set(part.record, constraint);
  };

  let matched = 0;
  for (const constraint of constraints) {
    const { ends, kv } = facilityEnds(constraint);
    let hits = [];
    if (Number.isFinite(constraint.lat) && Number.isFinite(constraint.lon)) {
      const { lat, lon } = constraint;
      const padLat = radiusKm / KM_PER_DEG_LAT;
      const padLon =
        radiusKm /
        (KM_PER_DEG_LON_EQ * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
      for (let i = 0; i < parts.length; i++) {
        const b = boxes[i];
        if (
          lon < b.minLon - padLon ||
          lon > b.maxLon + padLon ||
          lat < b.minLat - padLat ||
          lat > b.maxLat + padLat
        )
          continue;
        if (distanceToPartKm(lon, lat, parts[i].positions) <= radiusKm)
          hits.push(parts[i]);
      }
      if (ends.length) {
        const named = hits.filter((part) => endMatches(part.record, ends));
        if (named.length) hits = named;
      }
    } else if (ends.length) {
      const seen = new Set();
      for (const end of ends) {
        const key = norm(end);
        for (const [name, list] of nameIndex) {
          if (!namesMatch(key, name)) continue;
          for (const part of list) {
            if (seen.has(part)) continue;
            if (kv !== null && Math.abs(Number(part.record?.kv) - kv) >= 10)
              continue;
            seen.add(part);
            hits.push(part);
          }
        }
      }
    }
    if (!hits.length) continue;
    matched += 1;
    for (const part of hits) assign(part, constraint);
  }
  return { byRecord, matched, total };
}
