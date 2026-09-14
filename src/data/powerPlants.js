import * as Cesium from 'cesium';
import {
  createHoverCardController,
  createHoverCardEntry,
  DEFAULT_OVERLAY_HOST,
} from './hoverCard.js';
import {
  LOCAL_OVERLAY_COHORT_LIMIT,
  selectLocalInfrastructureOverlayCohort,
} from './localGeojsonCore.js';
import { shouldRecomputeInfraLod } from './localGeojsonLod.js';

/**
 * US power plants (EIA-860 / 860M, bundled by tools/energy/fetch_plants.py).
 *
 * Every plant is one PointPrimitive at ellipsoid height, coloured by primary
 * fuel and sized by nameplate MW, with no stem: on this map lines mean
 * transmission lines. All 13K dots are always drawn (a cheap pre-render
 * occluder walk hides the far side of the globe); only the ambient cards
 * are budgeted, through the same grid cohort the other local layers use.
 * Hovering a dot shows the detail card, clicking pins it.
 */

const plantsUrl = new URL(
  './local_data/eia_power_plants/plants.geojsonl',
  import.meta.url,
).href;

export const POWER_PLANTS_LAYER_ID = 'local-power-plants';
export const PLANT_OVERLAY_SOURCE_ID = 'local-power-plants';
export const PLANT_DETAIL_SOURCE_ID = 'local-power-plants-detail';
export const PLANT_LABEL_MAX = 600;
export const PLANT_LABEL_GRID_PX = 140;
export const PLANT_LABEL_ACCENT = '#ffb300';
const PARSE_CHUNK = 1500;
const WALK_INTERVAL_MS = 450;
const OVERLAY_MAX_DISTANCE_M = 14000000;
const OVERLAY_FADE_START_RATIO = 250000 / OVERLAY_MAX_DISTANCE_M;

/** Anchor colour per EIA primary fuel (`fuel` property from fetch_plants.py). */
export const POWER_PLANT_FUEL_COLORS = Object.freeze({
  gas: '#ff9f1c',
  coal: '#8d6e63',
  nuclear: '#d81b60',
  wind: '#4fc3f7',
  solar: '#ffe600',
  hydro: '#2979ff',
  storage: '#00e5a0',
  oil: '#b0bec5',
  geothermal: '#ff5722',
  biomass: '#7cb342',
  other: '#9e9e9e',
});

/** Legend wording per fuel key, in display order. */
export const POWER_PLANT_FUEL_LABELS = Object.freeze({
  gas: 'natural gas',
  coal: 'coal',
  nuclear: 'nuclear',
  wind: 'wind',
  solar: 'solar',
  hydro: 'hydro and pumped storage',
  storage: 'battery storage',
  oil: 'petroleum',
  geothermal: 'geothermal',
  biomass: 'biomass and landfill gas',
  other: 'other',
});

/**
 * Anchor style for one plant: colour by fuel, size by nameplate MW
 * (6 px under 10 MW up to 16 px at 2,000 MW and above).
 * @param {object} props Plant feature properties.
 * @returns {{color:string,pixelSize:number}}
 */
export function powerPlantStyle(props) {
  const color =
    POWER_PLANT_FUEL_COLORS[props?.fuel] || POWER_PLANT_FUEL_COLORS.other;
  const mw = Number(props?.total_mw);
  const scaled = Number.isFinite(mw) && mw > 0 ? Math.log10(mw) : 0;
  const pixelSize = Math.round(
    6 + 10 * Math.min(1, Math.max(0, (scaled - 1) / 2.3)),
  );
  return { color, pixelSize };
}

/** Pick ids of this layer. */
export function isPlantPickId(id) {
  return typeof id === 'string' && id.startsWith('plant:');
}

/**
 * Parse the bundled GeoJSONL into plain draw records.
 * @param {string} text
 * @returns {object[]} Records with `id`, `lon`, `lat`, `priority` and the
 *   plant properties.
 */
export function parsePlantRecords(text) {
  const records = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let feature;
    try {
      feature = JSON.parse(line);
    } catch {
      continue;
    }
    const [lon, lat] = feature?.geometry?.coordinates || [];
    const props = feature?.properties || {};
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const mw = Number(props.total_mw);
    // Named plants first, then bigger nameplate wins the card slot
    // (4,000 MW = +1000), the same score the shared engine used.
    const priority =
      (props.name ? 1000 : 0) +
      (Number.isFinite(mw) && mw > 0 ? Math.min(mw, 4000) / 4 : 0);
    records.push({
      ...props,
      id: `plant:${props.plant_code ?? records.length}`,
      lon,
      lat,
      priority,
    });
  }
  return records;
}

function mwText(mw) {
  const value = Number(mw);
  return Number.isFinite(value) && value > 0
    ? `${Math.round(value).toLocaleString('en-US')} MW`
    : '';
}

/**
 * Card copy for one plant. The first detail line is what the ambient card
 * shows; the hover card adds the technology and the EIA id.
 * @param {object} record
 * @returns {{title:string, details:string[]}}
 */
export function plantCardCopy(record) {
  const title = record?.name || 'Power plant';
  const summary = [
    record?.prim_source || record?.fuel,
    mwText(record?.total_mw),
    record?.utility,
  ]
    .filter(Boolean)
    .join(' · ');
  const tech = [
    record?.tech?.replace(/;\s*$/, '').replace(/;\s*/g, ' · '),
    record?.plant_code ? `EIA ${record.plant_code}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return { title, details: [summary, tech].filter(Boolean) };
}

/**
 * Ambient card (same shape the shared local-infrastructure engine publishes).
 * @param {object} record Record with `position`.
 * @returns {object}
 */
export function createPlantOverlayEntry(record) {
  const { title, details } = plantCardCopy(record);
  return {
    id: record.id,
    source: PLANT_OVERLAY_SOURCE_ID,
    position: record.position,
    variant: 'card',
    title,
    details: details.slice(0, 1),
    accent: PLANT_LABEL_ACCENT,
    priority: record.priority,
    collisionGroup: 'ambient-card',
    zIndex: 30,
    interactive: false,
    minDistance: 0,
    maxDistance: OVERLAY_MAX_DISTANCE_M,
    distanceFadeStartRatio: OVERLAY_FADE_START_RATIO,
    distanceScale: {
      near: 250000,
      nearValue: 1,
      far: 9000000,
      farValue: 0.62,
    },
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 15,
    placement: 'above',
  };
}

/**
 * Hover (card) or pinned (selected) detail entry.
 * @param {object} record Record with `position`.
 * @param {{pinned?:boolean}} [options]
 * @returns {object}
 */
export function createPlantDetailEntry(record, { pinned = false } = {}) {
  const { title, details } = plantCardCopy(record);
  return createHoverCardEntry({
    id: record.id,
    position: record.position,
    title,
    details,
    accent: powerPlantStyle(record).color,
    pinned,
  });
}

/**
 * Legend rows: one per fuel with its colour and site count.
 * @param {object[]} records
 * @returns {Array<{color:string,label:string,count:number,blurb:string}>}
 */
export function plantLegend(records) {
  const counts = {};
  for (const r of records || []) {
    const key = POWER_PLANT_FUEL_COLORS[r?.fuel] ? r.fuel : 'other';
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.keys(POWER_PLANT_FUEL_LABELS)
    .filter((key) => counts[key])
    .map((key) => ({
      color: POWER_PLANT_FUEL_COLORS[key],
      label: POWER_PLANT_FUEL_LABELS[key],
      count: counts[key],
      blurb: 'EIA primary energy source; dot size follows nameplate MW',
    }));
}

export function createPowerPlantsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  fetchText = (url) =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }),
} = {}) {
  let _viewer = null;
  let _points = null;
  /** @type {object[]} Records with `position` and `point`. */
  let _records = [];
  /** @type {Map<string, object>} */
  let _byId = new Map();
  let _legend = [];
  let _enabled = false;
  let _loading = null;
  let _generation = 0;
  let _lastUpdate = null;
  let _error = null;
  let _preRenderRemover = null;
  let _moveEndRemover = null;
  let _lastWalk = 0;
  let _cohortDirty = true;
  let _lastProbeMs = Number.NEGATIVE_INFINITY;
  const _lastCohortCamera = new Cesium.Cartesian3();
  /** @type {object[]} Ambient entries the last walk selected. */
  let _cohort = [];
  /** Id of the record carrying the hover or pinned card, if any. */
  let _cardId = null;
  let _rowControlsListener = null;

  /** Ambient cards minus the one the detail card already covers. */
  function publishCohort() {
    overlayHost.setEntries(
      PLANT_OVERLAY_SOURCE_ID,
      _cardId ? _cohort.filter((entry) => entry.id !== _cardId) : _cohort,
      {
        cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
        collisionCapacity: 96,
        moving: false,
      },
    );
  }

  function pickedRecord(picked) {
    const id = picked?.id;
    if (!id || typeof id !== 'object') return null;
    return _byId.get(String(id.id)) === id ? id : null;
  }

  const hover = createHoverCardController({
    ownerId: POWER_PLANTS_LAYER_ID,
    sourceId: PLANT_DETAIL_SOURCE_ID,
    isPickId: isPlantPickId,
    resolve: pickedRecord,
    entryFor: createPlantDetailEntry,
    onChange: (record) => {
      const id = record?.id || null;
      if (id === _cardId) return;
      _cardId = id;
      if (_enabled) publishCohort();
    },
    overlayHost,
  });

  async function load(generation) {
    const text = await fetchText(plantsUrl);
    if (generation !== _generation || !_points) return;
    const parsed = parsePlantRecords(text);
    for (let i = 0; i < parsed.length; i++) {
      if (i > 0 && i % PARSE_CHUNK === 0) {
        // Yield so a 13K-row bundle never blocks one long task.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (generation !== _generation || !_points) return;
      }
      const record = parsed[i];
      record.position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
      const style = powerPlantStyle(record);
      record.point = _points.add({
        id: record,
        position: record.position,
        pixelSize: style.pixelSize,
        color: Cesium.Color.fromCssColorString(style.color),
        outlineColor: Cesium.Color.BLACK,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      record.entry = createPlantOverlayEntry(record);
      _records.push(record);
      _byId.set(record.id, record);
    }
    _legend = plantLegend(_records);
    _lastUpdate = Date.now();
    _error = null;
    _cohortDirty = true;
    _rowControlsListener?.();
    _viewer?.scene?.requestRender?.();
  }

  function startLoad() {
    if (_loading || _records.length) return;
    const generation = _generation;
    _loading = load(generation)
      .catch((err) => {
        if (generation === _generation) _error = err?.message || String(err);
      })
      .finally(() => {
        _loading = null;
      });
  }

  /**
   * 450 ms pre-render walk: hide dots behind the globe, and when the camera
   * has moved, re-pick the ambient-card cohort from the dots in view.
   */
  function walk() {
    if (!_enabled || !_viewer || !_records.length) return;
    const now = performance.now();
    if (now - _lastWalk < WALK_INTERVAL_MS) return;
    _lastWalk = now;
    const scene = _viewer.scene;
    const cameraPos = _viewer.camera.positionWC;
    if (!cameraPos) return;

    if (!_cohortDirty) {
      const probe = shouldRecomputeInfraLod({
        nowMs: now,
        lastProbeMs: _lastProbeMs,
        movedSqM: Cesium.Cartesian3.distanceSquared(
          cameraPos,
          _lastCohortCamera,
        ),
        cameraHeightM: _viewer.camera.positionCartographic?.height,
      });
      _lastProbeMs = probe.lastProbeMs;
      if (probe.recompute) _cohortDirty = true;
    }

    const occluder = new Cesium.EllipsoidalOccluder(
      Cesium.Ellipsoid.WGS84,
      cameraPos,
    );
    const visible = [];
    for (const record of _records) {
      const show = occluder.isPointVisible(record.position);
      if (record.point.show !== show) record.point.show = show;
      if (show && _cohortDirty) visible.push(record);
    }
    if (!_cohortDirty) return;
    _cohortDirty = false;
    Cesium.Cartesian3.clone(cameraPos, _lastCohortCamera);
    _lastProbeMs = now;
    const canvas = scene.canvas;
    _cohort = selectLocalInfrastructureOverlayCohort(visible, {
      maxEntries: PLANT_LABEL_MAX,
      gridPx: PLANT_LABEL_GRID_PX,
      width: canvas.clientWidth || canvas.width || 0,
      height: canvas.clientHeight || canvas.height || 0,
      cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
      project: (record) =>
        Cesium.SceneTransforms.worldToWindowCoordinates(scene, record.position),
    });
    publishCohort();
  }

  return {
    id: POWER_PLANTS_LAYER_ID,
    name: 'Power Plants',
    icon: '⚡',
    source: 'EIA-860',
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init(viewer) {
      _viewer = viewer;
      _points = new Cesium.PointPrimitiveCollection({
        blendOption: Cesium.BlendOption.OPAQUE,
      });
      _points.show = false;
      viewer.scene.primitives.add(_points);
      overlayHost.setVisible(PLANT_OVERLAY_SOURCE_ID, false);
      hover.install(viewer);
      if (!_preRenderRemover)
        _preRenderRemover = viewer.scene.preRender.addEventListener(walk);
      if (!_moveEndRemover)
        _moveEndRemover = viewer.camera.moveEnd.addEventListener(() => {
          _cohortDirty = true;
          _lastWalk = 0;
          viewer.scene.requestRender?.();
        });
    },

    enable(viewer) {
      if (viewer && !_viewer) this.init(viewer);
      _enabled = true;
      if (_points) _points.show = true;
      overlayHost.setVisible(PLANT_OVERLAY_SOURCE_ID, true);
      hover.setEnabled(true);
      _cohortDirty = true;
      _lastWalk = 0;
      startLoad();
      _viewer?.scene?.requestRender?.();
    },

    disable() {
      _enabled = false;
      if (_points) _points.show = false;
      hover.setEnabled(false);
      overlayHost.clearSource(PLANT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(PLANT_OVERLAY_SOURCE_ID, false);
      _viewer?.scene?.requestRender?.();
    },

    // Static bundle: nothing to poll. Returning false would tell the manager
    // the enable was rejected.
    update() {
      return true;
    },

    destroy(viewer) {
      _generation += 1;
      _enabled = false;
      hover.remove();
      overlayHost.clearSource(PLANT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(PLANT_OVERLAY_SOURCE_ID, false);
      if (_preRenderRemover) _preRenderRemover();
      if (_moveEndRemover) _moveEndRemover();
      _preRenderRemover = null;
      _moveEndRemover = null;
      const target = viewer || _viewer;
      if (_points) {
        try {
          target?.scene?.primitives?.remove(_points);
        } catch {
          /* collection already gone */
        }
        _points = null;
      }
      _records = [];
      _cohort = [];
      _cardId = null;
      _byId = new Map();
      _legend = [];
      _lastUpdate = null;
      _error = null;
      _viewer = null;
    },

    getRowControls() {
      return { chips: [], legend: _legend };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return { count: _records.length, lastUpdate: _lastUpdate, error: _error };
    },
  };
}

export default createPowerPlantsLayer();
