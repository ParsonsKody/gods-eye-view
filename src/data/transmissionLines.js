import * as Cesium from 'cesium';
import {
  createHoverCardController,
  createHoverCardEntry,
  DEFAULT_OVERLAY_HOST,
} from './hoverCard.js';
import {
  cableClassificationTypeForScene,
  cableClassificationTypeForStack,
} from './telegeographySubmarineCables.js';

/**
 * US transmission lines from the EIA Atlas archive of the HIFLD dataset
 * (frozen 30 Sep 2024; HIFLD Open closed Aug 2025). Two bundled files:
 * a nationwide backbone (>= 345 kV) drawn whenever the layer is on, and a
 * regional set (100 to 230 kV, SPP + NYISO footprints) that loads lazily
 * the first time the camera drops below REGIONAL_MAX_CAMERA_HEIGHT_M and
 * hides again above it.
 *
 * Each file becomes ONE batched GroundPolylinePrimitive with a colour
 * attribute per line (the traffic heat-line pattern). Cesium builds the
 * ground-clamped geometry in its workers, so the main thread only pays for
 * the JSON parse; the earlier per-feature entity path froze the app for
 * seconds. The classification target follows the active basemap the same
 * way the submarine-cable layer does. Each instance carries its line record
 * as the pick id, so hovering a line shows a card (kV, substations, owner,
 * status) and clicking pins it.
 */

const backboneUrl = new URL(
  './local_data/eia_transmission_lines/lines_backbone.geojson',
  import.meta.url,
).href;
const regionalUrl = new URL(
  './local_data/eia_transmission_lines/lines_regional.geojson',
  import.meta.url,
).href;

/** Camera height (m) below which the regional 100 to 230 kV set is shown. */
export const REGIONAL_MAX_CAMERA_HEIGHT_M = 1800000;

/** [minKv, colour, width px], first match wins. DC lines override colour. */
export const LINE_STYLE_BY_KV = Object.freeze([
  Object.freeze([765, '#e040fb', 3]),
  Object.freeze([500, '#ff5252', 2.4]),
  Object.freeze([345, '#ffb74d', 1.8]),
  Object.freeze([230, '#4dd0e1', 1.4]),
  Object.freeze([0, '#9e9e9e', 1]),
]);
export const DC_LINE_COLOR = '#40c4ff';
const LINE_ALPHA = 0.9;
export const LINE_DETAIL_SOURCE_ID = 'eia-transmission-lines-detail';
/** HIFLD placeholders: "NOT AVAILABLE" and synthetic "UNKNOWN119979" nodes. */
const NOT_AVAILABLE = /^(not available|unknown\d*)$/i;

/** Pick ids of this layer. */
export function isLinePickId(id) {
  return typeof id === 'string' && id.startsWith('line:');
}

/** Title-case an all-caps HIFLD field, keeping AC/DC as written. */
function titleCase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\b(Ac|Dc)\b/g, (m) => m.toUpperCase());
}

function sentenceCase(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\b(ac|dc)\b/g, (m) => m.toUpperCase())
    .replace(/^[a-z]/, (c) => c.toUpperCase());
}

function known(value) {
  const text = String(value || '').trim();
  return text && !NOT_AVAILABLE.test(text) ? text : '';
}

/**
 * Card copy for one line record.
 * @param {object} record `{kv, type, status, owner, sub_1, sub_2}`.
 * @returns {{title:string, details:string[]}}
 */
export function lineCardCopy(record) {
  const kv = Number(record?.kv) || 0;
  const from = known(record?.sub_1);
  const to = known(record?.sub_2);
  const ends =
    from && to
      ? `${titleCase(from)} to ${titleCase(to)}`
      : titleCase(from || to);
  const title = ends ? `${kv} kV · ${ends}` : `${kv} kV line`;
  const details = [];
  const owner = known(record?.owner);
  if (owner) details.push(titleCase(owner));
  const facts = [
    ...String(known(record?.type))
      .split(';')
      .map((part) => sentenceCase(part.trim()))
      .filter(Boolean),
    sentenceCase(known(record?.status)),
  ].filter(Boolean);
  if (facts.length) details.push(facts.join(' · '));
  return { title, details };
}

/**
 * Hover (card) or pinned (selected) detail entry for a line.
 * @param {object} record Line record with `position` (the picked ground point).
 * @param {{pinned?:boolean}} [options]
 * @returns {object}
 */
export function createLineDetailEntry(record, { pinned = false } = {}) {
  const { title, details } = lineCardCopy(record);
  return createHoverCardEntry({
    id: record.id,
    position: record.position,
    title,
    details,
    accent: lineStyleForFeature(record).color,
    pinned,
  });
}

/**
 * Polyline colour and width for one line feature.
 * @param {object} props Feature properties (`kv`, `type`).
 * @returns {{color:string,width:number}}
 */
export function lineStyleForFeature(props) {
  const kv = Number(props?.kv) || 0;
  const dc = /\bDC\b/.test(String(props?.type || ''));
  for (const [minKv, color, width] of LINE_STYLE_BY_KV) {
    if (kv >= minKv) return { color: dc ? DC_LINE_COLOR : color, width };
  }
  const [, color, width] = LINE_STYLE_BY_KV[LINE_STYLE_BY_KV.length - 1];
  return { color, width };
}

/**
 * Flatten a GeoJSON FeatureCollection of LineString / MultiLineString
 * features into one styled part per ring. The parts of one feature share a
 * plain `record` (the pick id). Pure; used by the primitive builder and by
 * tests.
 * @param {object} collection Parsed GeoJSON.
 * @returns {{features:number, parts:Array<{positions:number[][], color:string, width:number, record:object}>}}
 */
export function lineParts(collection) {
  const parts = [];
  let features = 0;
  let index = 0;
  for (const feature of collection?.features || []) {
    index += 1;
    const geometry = feature?.geometry;
    let rings;
    if (geometry?.type === 'LineString') rings = [geometry.coordinates];
    else if (geometry?.type === 'MultiLineString') rings = geometry.coordinates;
    else continue;
    const { color, width } = lineStyleForFeature(feature.properties);
    const record = {
      ...(feature.properties || {}),
      id: `line:${feature.id ?? index}`,
    };
    let used = false;
    for (const ring of rings || []) {
      if (!Array.isArray(ring) || ring.length < 2) continue;
      parts.push({ positions: ring, color, width, record });
      used = true;
    }
    if (used) features += 1;
  }
  return { features, parts };
}

/**
 * Build the transmission-lines layer module.
 * @param {object} [options]
 * @param {EventTarget|null} [options.mapStackEventTarget] Basemap switch source.
 * @returns {object} Data-layer module.
 */
export function createTransmissionLinesLayer({
  mapStackEventTarget = typeof window !== 'undefined' ? window : null,
  overlayHost = DEFAULT_OVERLAY_HOST,
} = {}) {
  let _viewer = null;
  let _enabled = false;
  let _error = null;
  let _lastUpdate = null;
  /** @type {{primitive:Cesium.GroundPolylinePrimitive, features:number}|null} */
  let _backbone = null;
  let _regional = null;
  let _loading = null;
  let _regionalLoading = null;
  /** Ownership token: destroy bumps it so in-flight loads discard themselves. */
  let _generation = 0;
  let _classification = Cesium.ClassificationType.BOTH;
  let _mapStackListener = null;
  let _moveEndRemover = null;

  function buildPrimitive(collection) {
    const { features, parts } = lineParts(collection);
    const colorCache = new Map();
    const instances = parts.map(({ positions, color, width, record }) => {
      let attr = colorCache.get(color);
      if (!attr) {
        attr = Cesium.ColorGeometryInstanceAttribute.fromColor(
          Cesium.Color.fromCssColorString(color).withAlpha(LINE_ALPHA),
        );
        colorCache.set(color, attr);
      }
      return new Cesium.GeometryInstance({
        id: record,
        geometry: new Cesium.GroundPolylineGeometry({
          positions: Cesium.Cartesian3.fromDegreesArray(positions.flat()),
          width,
        }),
        attributes: { color: attr },
      });
    });
    const primitive = new Cesium.GroundPolylinePrimitive({
      geometryInstances: instances,
      appearance: new Cesium.PolylineColorAppearance(),
      classificationType: _classification,
      allowPicking: true,
    });
    return { primitive, features };
  }

  /** Our line record from a pick, anchored at the ground point under the cursor. */
  function pickedLine(picked, windowPosition) {
    const record = picked?.id;
    if (!record || typeof record !== 'object' || !isLinePickId(record.id))
      return null;
    if (
      picked.primitive !== _backbone?.primitive &&
      picked.primitive !== _regional?.primitive
    )
      return null;
    const position = _viewer?.camera?.pickEllipsoid(windowPosition);
    return position ? { ...record, position } : null;
  }

  const hover = createHoverCardController({
    ownerId: 'eia-transmission-lines',
    sourceId: LINE_DETAIL_SOURCE_ID,
    isPickId: isLinePickId,
    resolve: pickedLine,
    entryFor: createLineDetailEntry,
    overlayHost,
  });

  async function loadSet(url, generation) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (generation !== _generation) return null;
    const scene = _viewer?.scene;
    if (!scene) return null;
    if (!Cesium.GroundPolylinePrimitive.isSupported(scene)) {
      throw new Error('ground polylines unsupported on this GPU');
    }
    const set = buildPrimitive(json);
    scene.groundPrimitives.add(set.primitive);
    return set;
  }

  function applyClassification(next) {
    if (next === undefined || next === _classification) return;
    _classification = next;
    for (const set of [_backbone, _regional]) {
      if (set) set.primitive.classificationType = next;
    }
    _viewer?.scene?.requestRender?.();
  }

  function regionalWanted() {
    const height = _viewer?.camera?.positionCartographic?.height;
    return Number.isFinite(height) && height < REGIONAL_MAX_CAMERA_HEIGHT_M;
  }

  function updateRegionalVisibility() {
    if (!_enabled || !_viewer) return;
    const wanted = regionalWanted();
    if (wanted && !_regional && !_regionalLoading) {
      const generation = _generation;
      _regionalLoading = loadSet(regionalUrl, generation)
        .then((set) => {
          if (!set || !_viewer || generation !== _generation) return;
          _regional = set;
          set.primitive.show = _enabled && regionalWanted();
        })
        .catch((err) => {
          _error = err?.message || String(err);
        })
        .finally(() => {
          _regionalLoading = null;
        });
      return;
    }
    if (_regional && _regional.primitive.show !== wanted) {
      _regional.primitive.show = wanted;
      _viewer.scene?.requestRender?.();
    }
  }

  function count() {
    return (_backbone?.features || 0) + (_regional?.features || 0);
  }

  function removeSet(set) {
    if (!set) return;
    try {
      _viewer?.scene?.groundPrimitives?.remove(set.primitive);
    } catch {
      /* collection already gone */
    }
  }

  return {
    id: 'eia-transmission-lines',
    name: 'Transmission Lines',
    icon: '⌇',
    source: 'EIA / HIFLD 2024',
    updateInterval: 0,
    statsRefreshInterval: 1000,

    init(viewer) {
      _viewer = viewer;
      _classification = cableClassificationTypeForScene(viewer?.scene);
      if (!_mapStackListener && mapStackEventTarget?.addEventListener) {
        _mapStackListener = (event) =>
          applyClassification(
            event?.detail?.activeId
              ? cableClassificationTypeForStack(event.detail.activeId)
              : cableClassificationTypeForScene(_viewer?.scene),
          );
        mapStackEventTarget.addEventListener(
          'gev:map-stack-changed',
          _mapStackListener,
        );
      }
      if (!_moveEndRemover && viewer?.camera?.moveEnd?.addEventListener) {
        _moveEndRemover = viewer.camera.moveEnd.addEventListener(
          updateRegionalVisibility,
        );
      }
      hover.install(viewer);
    },

    enable(viewer) {
      if (viewer) _viewer = viewer;
      _enabled = true;
      hover.setEnabled(true);
      if (!_backbone && !_loading) {
        const generation = _generation;
        _loading = loadSet(backboneUrl, generation)
          .then((set) => {
            if (!set || !_viewer || generation !== _generation) return;
            _backbone = set;
            set.primitive.show = _enabled;
            _lastUpdate = Date.now();
            _error = null;
          })
          .catch((err) => {
            _error = err?.message || String(err);
          })
          .finally(() => {
            _loading = null;
          });
      }
      // Do not await the load: the manager treats a slow enable as a failed
      // toggle. Visibility is applied when the load settles.
      void _loading?.then(() => {
        if (_backbone) _backbone.primitive.show = _enabled;
        updateRegionalVisibility();
        _viewer?.scene?.requestRender?.();
      });
      if (_backbone) _backbone.primitive.show = _enabled;
      updateRegionalVisibility();
      _viewer?.scene?.requestRender?.();
    },

    disable() {
      _enabled = false;
      hover.setEnabled(false);
      if (_backbone) _backbone.primitive.show = false;
      if (_regional) _regional.primitive.show = false;
      _viewer?.scene?.requestRender?.();
    },

    // Static bundle: nothing to poll. Returning false would tell the manager
    // the enable was rejected.
    update() {
      return true;
    },

    destroy(viewer) {
      _generation += 1;
      if (viewer) _viewer = viewer;
      hover.remove();
      removeSet(_backbone);
      removeSet(_regional);
      _backbone = null;
      _regional = null;
      _enabled = false;
      if (_moveEndRemover) {
        _moveEndRemover();
        _moveEndRemover = null;
      }
      if (_mapStackListener && mapStackEventTarget?.removeEventListener) {
        mapStackEventTarget.removeEventListener(
          'gev:map-stack-changed',
          _mapStackListener,
        );
        _mapStackListener = null;
      }
      _viewer = null;
    },

    getStats() {
      return { count: count(), lastUpdate: _lastUpdate, error: _error };
    },
  };
}

export default createTransmissionLinesLayer();
