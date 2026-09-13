import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  mccColor,
  mccPixelSize,
  nodeLabel,
  CONSTRAINT_COLOR,
} from './lmpFeeds.js';

/**
 * ISO real-time congestion layer: SPP + NYISO nodal LMP with the marginal
 * congestion component driving colour and size, plus SPP binding and M2M
 * constraints as gold markers sized by shadow price. Prices come from the
 * keyless /api/lmp proxy every 5 minutes. NYISO node coordinates are the
 * bundled iso_nodes/nyiso.geojsonl (built by tools/energy/build_nodes.py);
 * SPP coordinates ride along in the feed.
 */

const API_URL = '/api/lmp';
const ISOS = ['nyiso', 'spp'];
const nyisoNodesUrl = new URL(
  './local_data/iso_nodes/nyiso.geojsonl',
  import.meta.url,
).href;

export const LMP_OVERLAY_SOURCE_ID = 'iso-lmp';
export const LMP_OVERLAY_COHORT_LIMIT = 96;
export const LMP_OVERLAY_COLLISION_CAPACITY = 48;

const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/**
 * Overlay label for a priced node or a constraint.
 * @param {object} input
 * @returns {object}
 */
export function createLmpOverlayEntry({
  id,
  position,
  title,
  accent,
  priority,
}) {
  return {
    id: String(id),
    position,
    variant: 'label',
    title,
    accent,
    priority,
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    verticalOnly: true,
    placement: 'above',
  };
}

/** Keep the most congested points, stable identity as the tie-break. */
export function selectLmpOverlayCohort(
  entries,
  limit = LMP_OVERLAY_COHORT_LIMIT,
) {
  const cap = Math.max(
    0,
    Math.min(LMP_OVERLAY_COHORT_LIMIT, Math.floor(Number(limit) || 0)),
  );
  if (!Array.isArray(entries) || cap === 0) return [];
  return entries
    .slice()
    .sort(
      (a, b) =>
        b.priority - a.priority || String(a.id).localeCompare(String(b.id)),
    )
    .slice(0, cap);
}

/**
 * Parse the bundled NYISO node file into a PTID -> coordinate map.
 * @param {string} text GeoJSONL.
 * @returns {Map<string, {lon:number, lat:number, name:string, zone:string}>}
 */
export function parseNyisoNodes(text) {
  const map = new Map();
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line);
      const [lon, lat] = f?.geometry?.coordinates || [];
      const id = String(f?.properties?.id || '');
      if (!id || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
      map.set(id, {
        lon,
        lat,
        name: f.properties.name || '',
        zone: f.properties.zone || '',
      });
    } catch {
      /* skip malformed line */
    }
  }
  return map;
}

/**
 * Join proxy payloads to coordinates and produce plain draw records.
 * @param {object[]} payloads /api/lmp payloads (any subset of ISOs).
 * @param {Map<string, object>} nyisoNodes From parseNyisoNodes.
 * @returns {{points:object[], constraints:object[], intervals:Record<string,string|null>}}
 */
export function buildLmpRecords(payloads, nyisoNodes) {
  const points = [];
  const constraints = [];
  const intervals = {};
  for (const payload of payloads) {
    if (!payload || !Array.isArray(payload.nodes)) continue;
    intervals[payload.iso] = payload.interval || null;
    for (const node of payload.nodes) {
      let { lat, lon, name } = node;
      if (payload.iso === 'nyiso') {
        const hit = nyisoNodes.get(String(node.ptid));
        if (!hit) continue;
        lat = hit.lat;
        lon = hit.lon;
        name = hit.name || name;
      }
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
      points.push({ ...node, iso: payload.iso, lat, lon, name });
    }
    for (const c of payload.constraints || []) {
      if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
      constraints.push({ ...c, iso: payload.iso });
    }
  }
  return { points, constraints, intervals };
}

export function createIsoLmpLayer({ overlayHost = DEFAULT_OVERLAY_HOST } = {}) {
  let _dataSource = null;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _enabled = false;
  /** @type {Map<string, object>|null} */
  let _nyisoNodes = null;
  let _nyisoNodesPromise = null;

  async function loadNyisoNodes() {
    if (_nyisoNodes) return _nyisoNodes;
    if (!_nyisoNodesPromise) {
      _nyisoNodesPromise = fetch(nyisoNodesUrl)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.text();
        })
        .then((text) => {
          _nyisoNodes = parseNyisoNodes(text);
          return _nyisoNodes;
        })
        .finally(() => {
          _nyisoNodesPromise = null;
        });
    }
    return _nyisoNodesPromise;
  }

  const layer = {
    id: 'iso-lmp',
    name: 'ISO Congestion (LMP)',
    icon: '⌁',
    source: 'SPP + NYISO · 5 min',
    updateInterval: 300000,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('iso-lmp');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _enabled = false;
      overlayHost.setVisible(LMP_OVERLAY_SOURCE_ID, false);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
      overlayHost.setVisible(LMP_OVERLAY_SOURCE_ID, true);
    },

    disable() {
      _enabled = false;
      if (_dataSource) _dataSource.show = false;
      overlayHost.clearSource(LMP_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(LMP_OVERLAY_SOURCE_ID, false);
    },

    async update() {
      try {
        const nyisoNodes = await loadNyisoNodes().catch((err) => {
          console.warn(
            '[Data:ISO LMP] NYISO node file failed:',
            err?.message || err,
          );
          return new Map();
        });
        const results = await Promise.allSettled(
          ISOS.map(async (iso) => {
            const response = await fetch(`${API_URL}?iso=${iso}`);
            if (!response.ok) throw new Error(`${iso} HTTP ${response.status}`);
            return response.json();
          }),
        );
        const payloads = results
          .filter((r) => r.status === 'fulfilled')
          .map((r) => r.value);
        const failures = results
          .filter((r) => r.status === 'rejected')
          .map((r) => r.reason?.message || String(r.reason));
        if (!payloads.length) {
          _lastError = failures.join('; ') || 'no ISO feed';
          return false;
        }

        const { points, constraints } = buildLmpRecords(payloads, nyisoNodes);
        const nextEntities = [];
        const overlayEntries = [];

        for (const p of points) {
          const position = Cesium.Cartesian3.fromDegrees(p.lon, p.lat);
          const color = Cesium.Color.fromCssColorString(mccColor(p.mcc));
          nextEntities.push(
            new Cesium.Entity({
              id: `lmp:${p.id}`,
              position,
              point: {
                pixelSize: mccPixelSize(p.mcc),
                color: color.withAlpha(0.92),
                outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
                outlineWidth: 1,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
              properties: {
                iso: p.iso,
                node: p.name,
                kind: p.kind,
                lmp: p.lmp,
                mcc: p.mcc,
                mlc: p.mlc,
              },
            }),
          );
          overlayEntries.push(
            createLmpOverlayEntry({
              id: p.id,
              position,
              title: nodeLabel(p),
              accent: color.toCssColorString(),
              priority: Math.round(Math.abs(p.mcc) * 100),
            }),
          );
        }

        const gold = Cesium.Color.fromCssColorString(CONSTRAINT_COLOR);
        for (const c of constraints) {
          const position = Cesium.Cartesian3.fromDegrees(c.lon, c.lat);
          const size = 7 + Math.min(11, Math.abs(c.shadowPrice) / 25);
          nextEntities.push(
            new Cesium.Entity({
              id: `lmp:${c.id}`,
              position,
              point: {
                pixelSize: Math.round(size),
                color: gold.withAlpha(c.shadowPrice ? 0.95 : 0.45),
                outlineColor: Cesium.Color.BLACK.withAlpha(0.7),
                outlineWidth: 1.5,
                heightReference: Cesium.HeightReference.CLAMP_TO_GROUND,
                disableDepthTestDistance: Number.POSITIVE_INFINITY,
              },
              properties: {
                iso: c.iso,
                constraint: c.name,
                kind: c.kind,
                state: c.state,
                shadowPrice: c.shadowPrice,
                monitored: c.monitored,
                contingent: c.contingent,
              },
            }),
          );
          if (c.shadowPrice) {
            overlayEntries.push(
              createLmpOverlayEntry({
                id: c.id,
                position,
                title: `${c.name} $${Math.round(c.shadowPrice)}`,
                accent: CONSTRAINT_COLOR,
                priority: 100000 + Math.round(Math.abs(c.shadowPrice) * 100),
              }),
            );
          }
        }

        _dataSource.entities.removeAll();
        for (const entity of nextEntities) _dataSource.entities.add(entity);
        if (_enabled) {
          overlayHost.setEntries(
            LMP_OVERLAY_SOURCE_ID,
            selectLmpOverlayCohort(overlayEntries),
            {
              cohortLimit: LMP_OVERLAY_COHORT_LIMIT,
              collisionCapacity: LMP_OVERLAY_COLLISION_CAPACITY,
              moving: false,
            },
          );
        }

        _count = nextEntities.length;
        _lastUpdate = Date.now();
        _lastError = failures.length ? failures.join('; ') : null;
        console.log(
          `[Data:ISO LMP] Updated: ${points.length} nodes, ${constraints.length} constraints`,
        );
        return true;
      } catch (e) {
        console.warn('[Data:ISO LMP] Fetch error:', e);
        _lastError = 'LMP network error';
        return false;
      }
    },

    destroy(viewer) {
      _enabled = false;
      overlayHost.clearSource(LMP_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(LMP_OVERLAY_SOURCE_ID, false);
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return { count: _count, lastUpdate: _lastUpdate, error: _lastError };
    },
  };
  return layer;
}

const isoLmpLayer = createIsoLmpLayer();

export default isoLmpLayer;
