import * as Cesium from 'cesium';
import { gridChips } from './gridFeeds.js';
import {
  createHoverCardController,
  createHoverCardEntry,
  DEFAULT_OVERLAY_HOST,
} from './hoverCard.js';
import {
  mccColor,
  mccPixelSize,
  nodeLabel,
  lmpCardCopy,
  lmpLegend,
  formatIntervalEt,
  CONSTRAINT_COLOR,
} from './lmpFeeds.js';

/**
 * ISO real-time congestion layer: SPP + NYISO nodal LMP with the marginal
 * congestion component driving colour and size, plus SPP binding and M2M
 * constraints as gold markers sized by shadow price. Prices come from the
 * keyless /api/lmp proxy every 5 minutes (positive congestion = priced up
 * for both ISOs; the proxy normalises NYISO's sign). NYISO node coordinates
 * are the bundled iso_nodes/nyiso.geojsonl (built by
 * tools/energy/build_nodes.py); SPP coordinates ride along in the feed.
 *
 * Points live in one PointPrimitiveCollection and are updated in place on
 * every refresh (no remove-and-rebuild churn). Each point's `id` is its
 * plain record, which is what scene.pick() returns: hovering a point shows
 * a detail card with the price decomposition, clicking pins it.
 */

const API_URL = '/api/lmp';
const ISOS = ['nyiso', 'spp'];
const reactorUnitsUrl = new URL(
  './local_data/eia_power_plants/reactor_units.json',
  import.meta.url,
).href;
const GRID_API_URL = '/api/grid';
const REACTORS_API_URL = '/api/reactors';
const nyisoNodesUrl = new URL(
  './local_data/iso_nodes/nyiso.geojsonl',
  import.meta.url,
).href;

export const LMP_OVERLAY_SOURCE_ID = 'iso-lmp';
export const LMP_DETAIL_SOURCE_ID = 'iso-lmp-detail';
export const LMP_OVERLAY_COHORT_LIMIT = 96;
export const LMP_OVERLAY_COLLISION_CAPACITY = 48;

/** Pick ids of this layer: the record's string id. */
export function isLmpPickId(id) {
  return (
    typeof id === 'string' && (id.startsWith('spp:') || id.startsWith('nyiso:'))
  );
}

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

/**
 * Detail card for the hovered (card) or pinned (selected) record.
 * @param {object} record Node or constraint record with `position`.
 * @param {{pinned?:boolean, nowMs?:number}} [options]
 * @returns {object}
 */
export function createLmpDetailEntry(record, { pinned = false, nowMs } = {}) {
  const { title, details } = lmpCardCopy(record, { nowMs });
  const accent =
    record.kind === 'binding' || record.kind === 'm2m'
      ? CONSTRAINT_COLOR
      : mccColor(record.mcc);
  return createHoverCardEntry({
    id: record.id,
    position: record.position,
    title,
    details,
    accent,
    pinned,
  });
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
 * Join proxy payloads to coordinates and produce plain draw records. Every
 * record carries its ISO, interval and fetch time for the detail card.
 * @param {object[]} payloads /api/lmp payloads (any subset of ISOs).
 * @param {Map<string, object>} nyisoNodes From parseNyisoNodes.
 * @returns {{points:object[], constraints:object[], intervals:Record<string,string|null>, stale:boolean}}
 */
export function buildLmpRecords(payloads, nyisoNodes) {
  const points = [];
  const constraints = [];
  const intervals = {};
  let stale = false;
  for (const payload of payloads) {
    if (!payload || !Array.isArray(payload.nodes)) continue;
    intervals[payload.iso] = payload.interval || null;
    if (payload.stale) stale = true;
    const meta = {
      iso: payload.iso,
      interval: payload.interval || null,
      fetchedAt: payload.fetchedAt || null,
    };
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
      points.push({ ...node, ...meta, lat, lon, name });
    }
    for (const c of payload.constraints || []) {
      if (!Number.isFinite(c.lat) || !Number.isFinite(c.lon)) continue;
      constraints.push({ ...c, ...meta });
    }
  }
  return { points, constraints, intervals, stale };
}

function constraintPixelSize(shadowPrice) {
  return Math.round(7 + Math.min(11, Math.abs(shadowPrice) / 25));
}

export function createIsoLmpLayer({ overlayHost = DEFAULT_OVERLAY_HOST } = {}) {
  let _viewer = null;
  let _points = null;
  /** @type {Map<string, {record:object, point:Cesium.PointPrimitive}>} */
  let _drawn = new Map();
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;
  let _intervals = {};
  let _stale = false;
  let _legend = [];
  /** Grid-condition chips (load, wind, nuclear, outages, binding) per ISO. */
  let _chips = [];
  /** @type {object[]|null} Reactor sidecar rows (unit, plant_code, ba). */
  let _reactorUnits = null;
  let _reactorUnitsPromise = null;
  let _enabled = false;
  /** @type {Map<string, object>|null} */
  let _nyisoNodes = null;
  let _nyisoNodesPromise = null;
  let _rowControlsListener = null;

  /** Our record from a scene.pick() result, or null. */
  function pickedRecord(picked) {
    const id = picked?.id;
    if (!id || typeof id !== 'object') return null;
    const drawn = _drawn.get(String(id.id));
    return drawn && drawn.record === id ? drawn.record : null;
  }

  const hover = createHoverCardController({
    ownerId: 'iso-lmp',
    sourceId: LMP_DETAIL_SOURCE_ID,
    isPickId: isLmpPickId,
    resolve: pickedRecord,
    entryFor: (record, { pinned }) => createLmpDetailEntry(record, { pinned }),
    overlayHost,
  });

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

  /** Update points in place: mutate existing, add new, drop vanished. */
  function reconcile(points, constraints) {
    const next = new Set();
    const upsert = (record, style) => {
      next.add(record.id);
      record.position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
      const existing = _drawn.get(record.id);
      if (existing) {
        existing.record = record;
        existing.point.id = record;
        existing.point.position = record.position;
        existing.point.color = style.color;
        existing.point.pixelSize = style.pixelSize;
        existing.point.outlineWidth = style.outlineWidth;
        return;
      }
      const point = _points.add({
        id: record,
        position: record.position,
        pixelSize: style.pixelSize,
        color: style.color,
        outlineColor: Cesium.Color.BLACK.withAlpha(0.6),
        outlineWidth: style.outlineWidth,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      _drawn.set(record.id, { record, point });
    };
    for (const p of points) {
      upsert(p, {
        color: Cesium.Color.fromCssColorString(mccColor(p.mcc)).withAlpha(0.92),
        pixelSize: mccPixelSize(p.mcc),
        outlineWidth: 1,
      });
    }
    const gold = Cesium.Color.fromCssColorString(CONSTRAINT_COLOR);
    for (const c of constraints) {
      upsert(c, {
        color: gold.withAlpha(c.shadowPrice ? 0.95 : 0.45),
        pixelSize: constraintPixelSize(c.shadowPrice),
        outlineWidth: 1.5,
      });
    }
    for (const [id, drawn] of _drawn) {
      if (next.has(id)) continue;
      _points.remove(drawn.point);
      _drawn.delete(id);
    }
  }

  function loadingLabel() {
    const parts = ISOS.map((iso) => {
      const stamp = formatIntervalEt(iso, _intervals[iso]);
      return stamp ? `${iso.toUpperCase()} ${stamp}` : null;
    }).filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  }

  const layer = {
    id: 'iso-lmp',
    name: 'ISO Congestion (LMP)',
    icon: '⌁',
    source: 'SPP + NYISO · 5 min',
    updateInterval: 300000,

    init(viewer) {
      _viewer = viewer;
      _points = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.TRANSLUCENT,
      });
      viewer.scene.primitives.add(_points);
      _points.show = false;
      _drawn = new Map();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _intervals = {};
      _stale = false;
      _legend = [];
      _enabled = false;
      overlayHost.setVisible(LMP_OVERLAY_SOURCE_ID, false);
      hover.install(viewer);
    },

    enable() {
      _enabled = true;
      if (_points) _points.show = true;
      overlayHost.setVisible(LMP_OVERLAY_SOURCE_ID, true);
      hover.setEnabled(true);
    },

    disable() {
      _enabled = false;
      if (_points) _points.show = false;
      hover.setEnabled(false);
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
        if (!_reactorUnits && !_reactorUnitsPromise) {
          _reactorUnitsPromise = fetch(reactorUnitsUrl)
            .then((r) =>
              r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)),
            )
            .then((json) => {
              _reactorUnits = Array.isArray(json?.units) ? json.units : [];
            })
            .catch((err) => {
              console.warn(
                '[Data:ISO LMP] reactor units unavailable:',
                err?.message || err,
              );
              _reactorUnits = [];
            });
        }
        const json = (url) =>
          fetch(url).then((r) =>
            r.ok
              ? r.json()
              : Promise.reject(new Error(`${url} HTTP ${r.status}`)),
          );
        // The grid feeds behind the chips ride along; a failure there only
        // costs the chips, never the nodes.
        const gridPromise = Promise.allSettled([
          json(`${GRID_API_URL}?iso=nyiso`),
          json(`${GRID_API_URL}?iso=spp`),
          json(REACTORS_API_URL),
          _reactorUnitsPromise,
        ]);
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
        if (!_points) return false;

        const { points, constraints, intervals, stale } = buildLmpRecords(
          payloads,
          nyisoNodes,
        );
        reconcile(points, constraints);

        const overlayEntries = [];
        for (const p of points) {
          overlayEntries.push(
            createLmpOverlayEntry({
              id: p.id,
              position: p.position,
              title: nodeLabel(p),
              accent: mccColor(p.mcc),
              priority: Math.round(Math.abs(p.mcc) * 100),
            }),
          );
        }
        for (const c of constraints) {
          if (!c.shadowPrice) continue;
          overlayEntries.push(
            createLmpOverlayEntry({
              id: c.id,
              position: c.position,
              title: `${c.name} $${Math.round(c.shadowPrice)}`,
              accent: CONSTRAINT_COLOR,
              priority: 100000 + Math.round(Math.abs(c.shadowPrice) * 100),
            }),
          );
        }
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
          hover.sync((id) => _drawn.get(id)?.record || null);
        }

        _count = _drawn.size;
        _lastUpdate = Date.now();
        _lastError = failures.length ? failures.join('; ') : null;
        _intervals = intervals;
        _stale = stale;
        _legend = lmpLegend(points, constraints);
        const [gridNy, gridSpp, reactors] = await gridPromise;
        const value = (r) => (r.status === 'fulfilled' ? r.value : null);
        const bindingCount = (prefix) =>
          constraints.filter(
            (c) => String(c.id).startsWith(prefix) && c.shadowPrice,
          ).length;
        _chips = gridChips({
          nyiso: value(gridNy),
          spp: value(gridSpp),
          reactors: value(reactors)?.units ? value(reactors) : null,
          reactorUnits: _reactorUnits || [],
          binding: { nyiso: bindingCount('nyiso:'), spp: bindingCount('spp:') },
        });
        _rowControlsListener?.();
        _viewer?.scene?.requestRender?.();
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
      hover.remove();
      overlayHost.clearSource(LMP_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(LMP_OVERLAY_SOURCE_ID, false);
      const target = viewer || _viewer;
      if (_points) {
        try {
          target?.scene?.primitives?.remove(_points);
        } catch {
          /* collection already gone */
        }
        _points = null;
      }
      _drawn = new Map();
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
      _intervals = {};
      _legend = [];
      _chips = [];
      _viewer = null;
    },

    getRowControls() {
      return { chips: _chips, legend: _legend };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
        loadingLabel: loadingLabel(),
      };
    },
  };
  return layer;
}

const isoLmpLayer = createIsoLmpLayer();

export default isoLmpLayer;
