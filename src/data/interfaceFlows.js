import * as Cesium from 'cesium';
import {
  createHoverCardController,
  createHoverCardEntry,
  DEFAULT_OVERLAY_HOST,
} from './hoverCard.js';
import {
  cameraPoseSignature,
  screenProjectedRotation,
  stabilizeScreenRotation,
} from './iconOrientation.js';
import {
  FLOW_BAND_COLORS,
  flowBand,
  flowCardCopy,
  flowLabel,
  flowLegend,
  flowUtilization,
} from './flowFeeds.js';
import { nyisoInterface } from './nyisoInterfaces.js';

/**
 * ISO interface flows (NYISO): one arrow per interface, pointing the way
 * power flows, coloured and sized by the share of the posted limit in use.
 * Flows come from the keyless /api/interface-flows proxy every 5 minutes;
 * positions and the direction of positive flow are the hand-built table in
 * nyisoInterfaces.js. Hovering an arrow shows the flow, the limit and the
 * interval; clicking pins the card.
 *
 * Arrows are billboards rotated in screen space (the flights pattern:
 * alignedAxis ZERO plus screenProjectedRotation), recomputed only when the
 * camera pose changes. Each billboard's `id` is its plain record.
 */

const API_URL = '/api/interface-flows';
const ISO = 'nyiso';
export const FLOW_OVERLAY_SOURCE_ID = 'iso-interface-flows';
export const FLOW_DETAIL_SOURCE_ID = 'iso-interface-flows-detail';
const ARROW_W = 36;
const ARROW_H = 44;
const ROTATION_REFRESH_MS = 500;

/** Pick ids of this layer. */
export function isFlowPickId(id) {
  return typeof id === 'string' && id.startsWith('flow:');
}

/**
 * Join feed rows to the interface table; rows without a table entry (the
 * HQ import/export aggregate) are dropped.
 * @param {object} payload /api/interface-flows payload.
 * @param {(name:string)=>object|null} [lookup]
 * @returns {object[]} Draw records with `id`, `lat`, `lon`, `bearingDeg`.
 */
export function buildFlowRecords(payload, lookup = nyisoInterface) {
  const out = [];
  for (const row of payload?.flows || []) {
    const geo = lookup(row.name);
    if (!geo) continue;
    out.push({
      ...row,
      ...geo,
      id: `flow:${payload.iso || ISO}:${row.name}`,
      iso: payload.iso || ISO,
      interval: payload.interval || null,
      fetchedAt: payload.fetchedAt || null,
    });
  }
  return out;
}

/** Billboard scale: 0.75 at zero utilization up to 1.5 at the limit. */
export function flowScale(utilization) {
  const u = Number.isFinite(utilization) ? Math.min(1, Math.max(0, utilization)) : 0.3;
  return 0.75 + 0.75 * u;
}

/**
 * Ambient label under the arrow.
 * @param {object} record Record with `position`.
 * @returns {object}
 */
export function createFlowOverlayEntry(record) {
  return {
    id: record.id,
    position: record.position,
    variant: 'label',
    title: flowLabel(record),
    accent: FLOW_BAND_COLORS[flowBand(flowUtilization(record))],
    priority: 1000 + Math.round((flowUtilization(record) || 0) * 100),
    collisionGroup: 'ambient-label',
    paintLane: 'ambient-label',
    interactive: false,
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
    gapPx: 26,
    verticalOnly: true,
    placement: 'below',
  };
}

/**
 * Hover (card) or pinned (selected) detail entry.
 * @param {object} record Record with `position`.
 * @param {{pinned?:boolean, nowMs?:number}} [options]
 * @returns {object}
 */
export function createFlowDetailEntry(record, { pinned = false, nowMs } = {}) {
  const { title, details } = flowCardCopy(record, { nowMs });
  return createHoverCardEntry({
    id: record.id,
    position: record.position,
    title,
    details,
    accent: FLOW_BAND_COLORS[flowBand(flowUtilization(record))],
    pinned,
  });
}

/** Canvas arrow pointing up (rotation 0 = screen-up), one per colour. */
function makeArrowImage(color) {
  const canvas = document.createElement('canvas');
  canvas.width = ARROW_W;
  canvas.height = ARROW_H;
  const ctx = canvas.getContext('2d');
  const cx = ARROW_W / 2;
  ctx.beginPath();
  ctx.moveTo(cx, 2);
  ctx.lineTo(ARROW_W - 2, 20);
  ctx.lineTo(cx + 7, 20);
  ctx.lineTo(cx + 7, ARROW_H - 3);
  ctx.lineTo(cx - 7, ARROW_H - 3);
  ctx.lineTo(cx - 7, 20);
  ctx.lineTo(2, 20);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(0,0,0,0.75)';
  ctx.lineJoin = 'round';
  ctx.stroke();
  return canvas;
}

export function createInterfaceFlowsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
} = {}) {
  let _viewer = null;
  let _billboards = null;
  /** @type {Map<string, {record:object, billboard:Cesium.Billboard, rotation:number|null}>} */
  let _drawn = new Map();
  const _images = new Map();
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let _interval = null;
  let _stale = false;
  let _legend = [];
  let _cardId = null;
  let _preRenderRemover = null;
  let _lastPoseSig = null;
  let _lastRotPassMs = 0;
  let _rowControlsListener = null;

  function arrowImage(color) {
    let image = _images.get(color);
    if (!image) {
      image = makeArrowImage(color);
      _images.set(color, image);
    }
    return image;
  }

  function pickedRecord(picked) {
    const id = picked?.id;
    if (!id || typeof id !== 'object') return null;
    const drawn = _drawn.get(String(id.id));
    return drawn && drawn.record === id ? drawn.record : null;
  }

  function publishLabels() {
    if (!_enabled) return;
    const entries = [];
    for (const { record } of _drawn.values()) {
      if (record.id === _cardId) continue;
      entries.push(createFlowOverlayEntry(record));
    }
    overlayHost.setEntries(FLOW_OVERLAY_SOURCE_ID, entries, {
      cohortLimit: 32,
      collisionCapacity: 32,
      moving: false,
    });
  }

  const hover = createHoverCardController({
    ownerId: 'iso-interface-flows',
    sourceId: FLOW_DETAIL_SOURCE_ID,
    isPickId: isFlowPickId,
    resolve: pickedRecord,
    entryFor: (record, { pinned }) => createFlowDetailEntry(record, { pinned }),
    onChange: (record) => {
      const id = record?.id || null;
      if (id === _cardId) return;
      _cardId = id;
      publishLabels();
    },
    overlayHost,
  });

  /** Rotate every arrow to its course in screen space when the camera moved. */
  function orient(force = false) {
    if (!_viewer || !_drawn.size) return;
    const now = performance.now();
    const sig = cameraPoseSignature(_viewer.camera);
    if (!force && sig === _lastPoseSig && now - _lastRotPassMs < ROTATION_REFRESH_MS)
      return;
    _lastPoseSig = sig;
    _lastRotPassMs = now;
    for (const drawn of _drawn.values()) {
      const course =
        drawn.record.flowMw < 0
          ? (drawn.record.bearingDeg + 180) % 360
          : drawn.record.bearingDeg;
      const projected = screenProjectedRotation(
        _viewer.scene,
        drawn.record.position,
        course,
        drawn.rotation,
      );
      const next = stabilizeScreenRotation(drawn.rotation, projected);
      if (next !== null && next !== drawn.rotation) {
        drawn.rotation = next;
        drawn.billboard.rotation = next;
      }
    }
  }

  /** Update billboards in place: mutate existing, add new, drop vanished. */
  function reconcile(records) {
    const next = new Set();
    for (const record of records) {
      next.add(record.id);
      record.position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
      const utilization = flowUtilization(record);
      const color = FLOW_BAND_COLORS[flowBand(utilization)];
      const scale = flowScale(utilization);
      const existing = _drawn.get(record.id);
      if (existing) {
        existing.record = record;
        existing.billboard.id = record;
        existing.billboard.position = record.position;
        existing.billboard.image = arrowImage(color);
        existing.billboard.scale = scale;
        continue;
      }
      const billboard = _billboards.add({
        id: record,
        position: record.position,
        image: arrowImage(color),
        scale,
        alignedAxis: Cesium.Cartesian3.ZERO,
        rotation: 0,
        verticalOrigin: Cesium.VerticalOrigin.CENTER,
        horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      _drawn.set(record.id, { record, billboard, rotation: null });
    }
    for (const [id, drawn] of _drawn) {
      if (next.has(id)) continue;
      _billboards.remove(drawn.billboard);
      _drawn.delete(id);
    }
    orient(true);
  }

  const layer = {
    id: 'iso-interface-flows',
    name: 'Interface Flows',
    icon: '➤',
    source: 'NYISO · 5 min',
    updateInterval: 300000,

    init(viewer) {
      _viewer = viewer;
      _billboards = new Cesium.BillboardCollection({ scene: viewer.scene });
      _billboards.show = false;
      viewer.scene.primitives.add(_billboards);
      _drawn = new Map();
      _enabled = false;
      _cardId = null;
      overlayHost.setVisible(FLOW_OVERLAY_SOURCE_ID, false);
      hover.install(viewer);
      if (!_preRenderRemover)
        _preRenderRemover = viewer.scene.preRender.addEventListener(() => {
          if (_enabled) orient();
        });
    },

    enable() {
      _enabled = true;
      if (_billboards) _billboards.show = true;
      overlayHost.setVisible(FLOW_OVERLAY_SOURCE_ID, true);
      hover.setEnabled(true);
      publishLabels();
      _viewer?.scene?.requestRender?.();
    },

    disable() {
      _enabled = false;
      if (_billboards) _billboards.show = false;
      hover.setEnabled(false);
      overlayHost.clearSource(FLOW_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FLOW_OVERLAY_SOURCE_ID, false);
      _viewer?.scene?.requestRender?.();
    },

    async update() {
      try {
        const response = await fetch(`${API_URL}?iso=${ISO}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        if (!_billboards) return false;
        const records = buildFlowRecords(payload);
        reconcile(records);
        if (_enabled) {
          publishLabels();
          hover.sync((id) => _drawn.get(id)?.record || null);
        }
        _lastUpdate = Date.now();
        _lastError = null;
        _interval = payload.interval || null;
        _stale = Boolean(payload.stale);
        _legend = flowLegend(records);
        _rowControlsListener?.();
        _viewer?.scene?.requestRender?.();
        console.log(
          `[Data:Interface Flows] Updated: ${records.length} interfaces (${_interval || 'no interval'})`,
        );
        return true;
      } catch (e) {
        console.warn('[Data:Interface Flows] Fetch error:', e);
        _lastError = e?.message || 'interface flows network error';
        return _drawn.size > 0;
      }
    },

    destroy(viewer) {
      _enabled = false;
      hover.remove();
      overlayHost.clearSource(FLOW_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(FLOW_OVERLAY_SOURCE_ID, false);
      if (_preRenderRemover) _preRenderRemover();
      _preRenderRemover = null;
      const target = viewer || _viewer;
      if (_billboards) {
        try {
          target?.scene?.primitives?.remove(_billboards);
        } catch {
          /* collection already gone */
        }
        _billboards = null;
      }
      _drawn = new Map();
      _cardId = null;
      _lastUpdate = null;
      _lastError = null;
      _interval = null;
      _legend = [];
      _viewer = null;
    },

    getRowControls() {
      return { chips: [], legend: _legend };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: _drawn.size,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}

const interfaceFlowsLayer = createInterfaceFlowsLayer();

export default interfaceFlowsLayer;
