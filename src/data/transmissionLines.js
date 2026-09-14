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
import { matchConstraintsToLines } from './constraintLines.js';
import { mccColor, MCC_POSITIVE_COLOR } from './lmpFeeds.js';
import { requestWorldFocus } from '../worldFocus.js';
import {
  matchOutagesToLines,
  nearbyOutages,
  nuclearNearby,
  outageCopy,
  outageName,
  sinceText,
} from './outageLines.js';
import { shortDate } from './gridFeeds.js';

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
 *
 * Congestion: every 5 minutes the layer reads the binding constraints the
 * /api/lmp proxy already serves (SPP and NYISO), matches them to lines
 * (constraintLines.js) and draws the matched lines again, wider, in the
 * LMP congestion gradient by shadow price. The card of such a line names
 * the constraint. No public feed gives MW on individual lines, so this
 * marks where a constraint binds, not measured loading.
 */

const backboneUrl = new URL(
  './local_data/eia_transmission_lines/lines_backbone.geojson',
  import.meta.url,
).href;
const regionalUrl = new URL(
  './local_data/eia_transmission_lines/lines_regional.geojson',
  import.meta.url,
).href;
const LMP_API_URL = '/api/lmp';
const CONSTRAINT_ISOS = ['spp', 'nyiso'];

/** Camera height (m) below which the regional 100 to 230 kV set is shown. */
export const REGIONAL_MAX_CAMERA_HEIGHT_M = 1800000;

/** [minKv, colour, width px], first match wins. DC lines override colour. */
export const LINE_STYLE_BY_KV = Object.freeze([
  Object.freeze([765, '#e040fb', 4.5]),
  Object.freeze([500, '#ff5252', 3.6]),
  Object.freeze([345, '#ffb74d', 2.8]),
  Object.freeze([230, '#4dd0e1', 2.2]),
  Object.freeze([0, '#9e9e9e', 1.6]),
]);
export const DC_LINE_COLOR = '#40c4ff';
const LINE_ALPHA = 0.9;
export const LINE_DETAIL_SOURCE_ID = 'eia-transmission-lines-detail';
/** |shadow price| in $/MWh at which the congested-line colour saturates. */
export const CONSTRAINT_SATURATION = 200;
const CONGESTED_EXTRA_WIDTH = 3;
const OUTAGED_EXTRA_WIDTH = 2;
/** Dashed colour of a line under a NYISO real-time outage. */
export const OUTAGE_COLOR = '#90a4ae';
const GRID_API_URL = '/api/grid';
const REACTORS_API_URL = '/api/reactors';
const reactorUnitsUrl = new URL(
  './local_data/eia_power_plants/reactor_units.json',
  import.meta.url,
).href;
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

/** Congestion gradient colour for a constraint, by |shadow price|. */
export function constraintColor(constraint) {
  return mccColor(
    Math.abs(Number(constraint?.shadowPrice) || 0),
    CONSTRAINT_SATURATION,
  );
}

/**
 * Card line for the constraint binding on a line.
 * @param {object} constraint `{iso, name, monitored, shadowPrice, state}`.
 * @returns {string}
 */
export function constraintCopy(constraint) {
  const price = Math.abs(Number(constraint?.shadowPrice) || 0);
  const dollars = `$${Math.round(price).toLocaleString('en-US')}/MWh`;
  if (constraint?.iso === 'nyiso') {
    return `Limiting: ${constraint.name} · ${dollars}`;
  }
  const facility =
    constraint?.monitored && constraint.monitored !== constraint.name
      ? ` (${constraint.monitored})`
      : '';
  return [
    `Binding: ${constraint?.name || '?'}${facility}`,
    dollars,
    constraint?.state ? sentenceCase(constraint.state) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * Card copy for one line record.
 * @param {object} record `{kv, type, status, owner, sub_1, sub_2, constraint?}`.
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
  if (record?.constraint) details.push(constraintCopy(record.constraint));
  for (const outage of record?.outages || []) details.push(outageCopy(outage));
  // The neighbourhood of a constrained line: what else is out, what
  // reactor is down. Filled by the layer from the live feeds.
  if (record?.constraint) {
    const near = record.nearbyOutages || [];
    if (near.length) {
      const named = near
        .slice(0, 2)
        .map((o) => `${outageName(o)} (since ${sinceText(o.since)})`)
        .join(', ');
      details.push(`Outages nearby: ${near.length} · ${named}`);
    }
    const nuke = record.nuclearNearby;
    if (nuke?.units?.length) {
      details.push(
        `Nuclear nearby: ${nuke.units.map((u) => `${u.unit} ${u.pct}%`).join(', ')} (NRC ${nuke.date})`,
      );
    }
  }
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
    accent: record.constraint
      ? constraintColor(record.constraint)
      : record.outages?.length
        ? OUTAGE_COLOR
        : lineStyleForFeature(record).color,
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
 * Bounding sphere of one line (every part of the feature), centre lifted
 * to the ellipsoid surface so a long run still validates as a world
 * focus target.
 * @param {number[][][]} partsPositions Lon/lat pairs per part.
 * @returns {Cesium.BoundingSphere|null}
 */
export function lineBoundingSphere(partsPositions) {
  const flat = [];
  for (const positions of partsPositions || []) {
    for (const pair of positions || []) flat.push(pair[0], pair[1]);
  }
  if (flat.length < 4) return null;
  const sphere = Cesium.BoundingSphere.fromPoints(
    Cesium.Cartesian3.fromDegreesArray(flat),
  );
  const surface = Cesium.Ellipsoid.WGS84.scaleToGeodeticSurface(sphere.center);
  if (surface) sphere.center = surface;
  return sphere;
}

/**
 * Legend row for the panel: how many constraints landed on a line.
 * @param {{matched:number,total:number}} stats
 * @returns {Array<{color:string,label:string,count:number,blurb:string}>}
 */
export function constraintLegend(stats) {
  const matched = stats?.matched || 0;
  const total = stats?.total || 0;
  return [
    {
      color: MCC_POSITIVE_COLOR,
      label: 'binding constraints on lines',
      count: matched,
      blurb: `${matched} of ${total} live SPP and NYISO constraints placed on a line; colour saturates at $${CONSTRAINT_SATURATION}/MWh shadow price`,
    },
  ];
}

/**
 * Legend row for the panel: how many NYISO line outages landed on a line.
 * @param {{matched:number,total:number}} stats
 * @returns {Array<{color:string,label:string,count:number,blurb:string}>}
 */
export function outageLegend(stats) {
  const matched = stats?.matched || 0;
  const total = stats?.total || 0;
  if (!total) return [];
  return [
    {
      color: OUTAGE_COLOR,
      label: 'lines out (dashed)',
      count: matched,
      blurb: `${matched} of ${total} NYISO real-time line outages placed on a bundled line (EMS and HIFLD station names agree only partly)`,
    },
  ];
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
  focus = requestWorldFocus,
} = {}) {
  let _viewer = null;
  let _enabled = false;
  let _error = null;
  let _lastUpdate = null;
  /** @type {{primitive:Cesium.GroundPolylinePrimitive, features:number, parts:object[]}|null} */
  let _backbone = null;
  let _regional = null;
  /** @type {{primitive:Cesium.GroundPolylinePrimitive}|null} Matched lines, redrawn wider. */
  let _congested = null;
  /** @type {{primitive:Cesium.GroundPolylinePrimitive}|null} Lines under outage, dashed. */
  let _outaged = null;
  /** @type {object[]} Latest NYISO line outages from /api/grid. */
  let _outages = [];
  let _outageStats = { matched: 0, total: 0 };
  /** @type {Set<object>} Records currently carrying `outages`. */
  let _outagedRecords = new Set();
  /** @type {{reportDate:string, units:object}|null} NRC payload. */
  let _reactors = null;
  /** @type {object[]|null} Reactor sidecar rows (unit, lon, lat). */
  let _reactorUnits = null;
  let _reactorUnitsPromise = null;
  let _loading = null;
  let _regionalLoading = null;
  /** Ownership token: destroy bumps it so in-flight loads discard themselves. */
  let _generation = 0;
  let _classification = Cesium.ClassificationType.BOTH;
  let _mapStackListener = null;
  let _moveEndRemover = null;
  /** @type {object[]} Latest constraints from the LMP proxy, tagged with `iso`. */
  let _constraints = [];
  let _matchStats = { matched: 0, total: 0 };
  /** @type {Set<object>} Records currently carrying a `constraint`. */
  let _matchedRecords = new Set();
  let _rowControlsListener = null;
  /** @type {Map<string, number[][][]>} Lon/lat parts per line id, both sets. */
  const _partsById = new Map();

  function buildPrimitive(collection) {
    const { features, parts } = lineParts(collection);
    for (const part of parts) {
      const list = _partsById.get(part.record.id) || [];
      list.push(part.positions);
      _partsById.set(part.record.id, list);
    }
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
    return { primitive, features, parts };
  }

  /** Our line record from a pick, anchored at the ground point under the cursor. */
  function pickedLine(picked, windowPosition) {
    const record = picked?.id;
    if (!record || typeof record !== 'object' || !isLinePickId(record.id))
      return null;
    if (
      picked.primitive !== _backbone?.primitive &&
      picked.primitive !== _regional?.primitive &&
      picked.primitive !== _congested?.primitive &&
      picked.primitive !== _outaged?.primitive
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
    // Double-click: frame the whole line.
    onActivate: (record) => {
      const sphere = lineBoundingSphere(_partsById.get(record.id));
      if (!sphere) return;
      focus({
        kind: 'line',
        id: record.id,
        label: lineCardCopy(record).title,
        position: sphere.center,
        radiusM: sphere.radius,
      });
    },
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
    for (const set of [_backbone, _regional, _congested, _outaged]) {
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
          rematch();
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

  /**
   * Match the latest constraints to the loaded parts and redraw the
   * congested set (teardown and rebuild: the base sets share one colour
   * attribute per voltage band, so they cannot be recoloured per line).
   */
  function rematch() {
    const parts = [...(_backbone?.parts || []), ...(_regional?.parts || [])];
    const { byRecord, matched, total } = matchConstraintsToLines(
      _constraints,
      parts,
    );
    for (const record of _matchedRecords) {
      delete record.constraint;
      delete record.nearbyOutages;
      delete record.nuclearNearby;
    }
    _matchedRecords = new Set();
    for (const [record, constraint] of byRecord) {
      record.constraint = constraint;
      _matchedRecords.add(record);
    }
    _matchStats = { matched, total };
    removeSet(_congested);
    _congested = null;
    const scene = _viewer?.scene;
    if (scene && byRecord.size) {
      const instances = [];
      for (const part of parts) {
        const constraint = byRecord.get(part.record);
        if (!constraint) continue;
        instances.push(
          new Cesium.GeometryInstance({
            id: part.record,
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(
                part.positions.flat(),
              ),
              width: part.width + CONGESTED_EXTRA_WIDTH,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                Cesium.Color.fromCssColorString(constraintColor(constraint)),
              ),
            },
          }),
        );
      }
      const primitive = new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineColorAppearance(),
        classificationType: _classification,
        allowPicking: true,
      });
      primitive.show = _enabled;
      scene.groundPrimitives.add(primitive);
      _congested = { primitive };
    }
    // NYISO outages: dashed over the base set, one row per circuit on the
    // card, and the neighbourhood rows on every constrained line.
    const outageMatch = matchOutagesToLines(_outages, parts);
    for (const record of _outagedRecords) delete record.outages;
    _outagedRecords = new Set();
    for (const [record, outages] of outageMatch.byRecord) {
      record.outages = outages;
      _outagedRecords.add(record);
    }
    _outageStats = { matched: outageMatch.matched, total: outageMatch.total };
    for (const record of _matchedRecords) {
      const own = _partsById.get(record.id) || [];
      record.nearbyOutages = nearbyOutages(
        record,
        own,
        outageMatch.byRecord,
        _partsById,
      );
      const units =
        _reactors && _reactorUnits
          ? nuclearNearby(own, _reactorUnits, _reactors)
          : [];
      record.nuclearNearby = units.length
        ? { date: shortDate(_reactors.reportDate), units }
        : null;
    }
    removeSet(_outaged);
    _outaged = null;
    if (scene && outageMatch.byRecord.size) {
      const instances = [];
      for (const part of parts) {
        if (!outageMatch.byRecord.has(part.record)) continue;
        instances.push(
          new Cesium.GeometryInstance({
            id: part.record,
            geometry: new Cesium.GroundPolylineGeometry({
              positions: Cesium.Cartesian3.fromDegreesArray(
                part.positions.flat(),
              ),
              width: part.width + OUTAGED_EXTRA_WIDTH,
            }),
          }),
        );
      }
      const primitive = new Cesium.GroundPolylinePrimitive({
        geometryInstances: instances,
        appearance: new Cesium.PolylineMaterialAppearance({
          material: Cesium.Material.fromType('PolylineDash', {
            color: Cesium.Color.fromCssColorString(OUTAGE_COLOR),
            gapColor: Cesium.Color.TRANSPARENT,
            dashLength: 16,
          }),
        }),
        classificationType: _classification,
        allowPicking: true,
      });
      primitive.show = _enabled;
      scene.groundPrimitives.add(primitive);
      _outaged = { primitive };
    }
    // A hovered or pinned card is a copy of its record; refresh it so the
    // constraint line appears or disappears with the feed.
    const byId = new Map(parts.map((part) => [part.record.id, part.record]));
    hover.sync((id) => {
      const current =
        hover.pinned()?.id === id ? hover.pinned() : hover.hovered();
      const record = byId.get(id);
      return current && record
        ? { ...record, position: current.position }
        : current || null;
    });
    _rowControlsListener?.();
    scene?.requestRender?.();
  }

  return {
    id: 'eia-transmission-lines',
    name: 'Transmission Lines',
    icon: '⌇',
    source: 'EIA / HIFLD 2024 · constraints and outages 5 min',
    updateInterval: 300000,

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
            rematch();
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
      if (_congested) _congested.primitive.show = _enabled;
      if (_outaged) _outaged.primitive.show = _enabled;
      updateRegionalVisibility();
      _viewer?.scene?.requestRender?.();
    },

    disable() {
      _enabled = false;
      hover.setEnabled(false);
      if (_backbone) _backbone.primitive.show = false;
      if (_regional) _regional.primitive.show = false;
      if (_congested) _congested.primitive.show = false;
      if (_outaged) _outaged.primitive.show = false;
      _viewer?.scene?.requestRender?.();
    },

    /**
     * Refresh the binding constraints, the NYISO line outages and the NRC
     * reactor status (the line bundle itself is static). A feed failure
     * keeps the last set; the enable is never rejected for it, so this
     * always returns true.
     */
    async update() {
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
              '[Data:Transmission] reactor units unavailable:',
              err?.message || err,
            );
            _reactorUnits = [];
          });
      }
      const [gridResult, reactorResult] = await Promise.allSettled([
        fetch(`${GRID_API_URL}?iso=nyiso`).then((r) =>
          r.ok ? r.json() : Promise.reject(new Error(`grid HTTP ${r.status}`)),
        ),
        fetch(REACTORS_API_URL).then((r) =>
          r.ok
            ? r.json()
            : Promise.reject(new Error(`reactors HTTP ${r.status}`)),
        ),
        _reactorUnitsPromise,
      ]);
      if (
        gridResult.status === 'fulfilled' &&
        Array.isArray(gridResult.value?.lineOutages)
      )
        _outages = gridResult.value.lineOutages;
      if (reactorResult.status === 'fulfilled' && reactorResult.value?.units)
        _reactors = reactorResult.value;
      const results = await Promise.allSettled(
        CONSTRAINT_ISOS.map(async (iso) => {
          const response = await fetch(`${LMP_API_URL}?iso=${iso}`);
          if (!response.ok) throw new Error(`${iso} HTTP ${response.status}`);
          const payload = await response.json();
          // Activated constraints with a zero shadow price are not binding;
          // highlighting them would only add grey clutter.
          return (payload?.constraints || [])
            .filter((c) => Number(c?.shadowPrice))
            .map((c) => ({ ...c, iso: payload.iso || iso }));
        }),
      );
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      if (fulfilled.length) _constraints = fulfilled.flatMap((r) => r.value);
      const failed = [...results, gridResult, reactorResult].filter(
        (r) => r.status === 'rejected',
      );
      if (failed.length) {
        console.warn(
          '[Data:Transmission] live feed failed:',
          failed.map((r) => r.reason?.message || r.reason).join('; '),
        );
      }
      if (failed.length < results.length + 2) rematch();
      return true;
    },

    destroy(viewer) {
      _generation += 1;
      if (viewer) _viewer = viewer;
      hover.remove();
      removeSet(_backbone);
      removeSet(_regional);
      removeSet(_congested);
      removeSet(_outaged);
      _partsById.clear();
      _backbone = null;
      _regional = null;
      _congested = null;
      _outaged = null;
      _outages = [];
      _outageStats = { matched: 0, total: 0 };
      _outagedRecords = new Set();
      _reactors = null;
      _constraints = [];
      _matchStats = { matched: 0, total: 0 };
      _matchedRecords = new Set();
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

    getRowControls() {
      return {
        chips: [],
        legend: [
          ...constraintLegend(_matchStats),
          ...outageLegend(_outageStats),
        ],
      };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return { count: count(), lastUpdate: _lastUpdate, error: _error };
    },
  };
}

export default createTransmissionLinesLayer();
