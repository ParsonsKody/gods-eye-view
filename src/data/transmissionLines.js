import * as Cesium from 'cesium';
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
 * hides again above it. Lines are ground-clamped polylines; the
 * classification target follows the active basemap the same way the
 * submarine-cable layer does.
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
 * Build the transmission-lines layer module.
 * @param {object} [options]
 * @param {EventTarget|null} [options.mapStackEventTarget] Basemap switch source.
 * @returns {object} Data-layer module.
 */
export function createTransmissionLinesLayer({
  mapStackEventTarget = typeof window !== 'undefined' ? window : null,
} = {}) {
  let _viewer = null;
  let _enabled = false;
  let _error = null;
  let _lastUpdate = null;
  let _backbone = null;
  let _regional = null;
  let _loading = null;
  let _regionalLoading = null;
  /** Ownership token: destroy bumps it so in-flight loads discard themselves. */
  let _generation = 0;
  let _classification = Cesium.ClassificationType.BOTH;
  let _mapStackListener = null;
  let _moveEndRemover = null;

  function styleEntity(entity) {
    if (!entity?.polyline) return;
    const props = entity.properties?.getValue?.(Cesium.JulianDate.now()) || {};
    const { color, width } = lineStyleForFeature(props);
    entity.polyline.material = new Cesium.ColorMaterialProperty(
      Cesium.Color.fromCssColorString(color).withAlpha(0.9),
    );
    entity.polyline.width = width;
    entity.polyline.clampToGround = true;
    entity.polyline.classificationType = _classification;
  }

  async function loadSet(url, generation) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    if (generation !== _generation) return null;
    const source = await Cesium.GeoJsonDataSource.load(json, {
      clampToGround: true,
      strokeWidth: 1,
    });
    if (generation !== _generation) return null;
    for (const entity of source.entities.values) styleEntity(entity);
    return source;
  }

  function applyClassification(next) {
    if (next === undefined || next === _classification) return;
    _classification = next;
    for (const source of [_backbone, _regional]) {
      if (!source) continue;
      for (const entity of source.entities.values) {
        if (entity.polyline) entity.polyline.classificationType = next;
      }
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
        .then((source) => {
          if (!source || !_viewer || generation !== _generation) return;
          _regional = source;
          _viewer.dataSources.add(source);
          source.show = _enabled && regionalWanted();
        })
        .catch((err) => {
          _error = err?.message || String(err);
        })
        .finally(() => {
          _regionalLoading = null;
        });
      return;
    }
    if (_regional && _regional.show !== wanted) {
      _regional.show = wanted;
      _viewer.scene?.requestRender?.();
    }
  }

  function count() {
    return (
      (_backbone?.entities?.values?.length || 0) +
      (_regional?.entities?.values?.length || 0)
    );
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
    },

    enable(viewer) {
      if (viewer) _viewer = viewer;
      _enabled = true;
      if (!_backbone && !_loading) {
        const generation = _generation;
        _loading = loadSet(backboneUrl, generation)
          .then((source) => {
            if (!source || !_viewer || generation !== _generation) return;
            _backbone = source;
            _viewer.dataSources.add(source);
            source.show = _enabled;
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
        if (_backbone) _backbone.show = _enabled;
        updateRegionalVisibility();
        _viewer?.scene?.requestRender?.();
      });
      if (_backbone) _backbone.show = _enabled;
      updateRegionalVisibility();
      _viewer?.scene?.requestRender?.();
    },

    disable() {
      _enabled = false;
      if (_backbone) _backbone.show = false;
      if (_regional) _regional.show = false;
      _viewer?.scene?.requestRender?.();
    },

    // Static bundle: nothing to poll. Returning false would tell the manager
    // the enable was rejected.
    update() {
      return true;
    },

    destroy(viewer) {
      _generation += 1;
      const target = viewer || _viewer;
      for (const source of [_backbone, _regional]) {
        if (source && target?.dataSources) {
          try {
            target.dataSources.remove(source, true);
          } catch {
            /* collection already gone */
          }
        }
      }
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
