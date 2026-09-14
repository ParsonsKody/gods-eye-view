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
import { POWER_PLANT_FUEL_ICONS } from './powerPlantIcons.js';
import { createPlantMarkerSpriteCache } from './plantMarkerSprite.js';
import { requestWorldFocus } from '../worldFocus.js';
import { parseNyisoNodes } from './isoLmp.js';
import { formatIntervalEt, money } from './lmpFeeds.js';
import { fleetNameplateByBaFuel, fleetRow, shortDate } from './gridFeeds.js';

/**
 * US power plants (EIA-860 / 860M, bundled by tools/energy/fetch_plants.py).
 *
 * Every plant is one billboard at ellipsoid height: a disc carrying the
 * fuel glyph in the fuel colour (plantMarkerSprite.js), sized by nameplate
 * MW, with no stem: on this map lines mean transmission lines. All 13K
 * markers are always drawn (a cheap pre-render
 * occluder walk hides the far side of the globe); only the ambient cards
 * are budgeted, through the same grid cohort the other local layers use.
 * Hovering a marker shows the detail card (title plus a label and value
 * table), clicking pins it, double-clicking flies the camera to the
 * plant. The table also carries a capacity factor from
 * the EIA-923 sidecar (capacity_factors.json,
 * tools/energy/fetch_capacity_factors.py) for the plants on EIA's monthly
 * survey.
 *
 * Live rows (polled every 5 minutes while the layer is on, all keyless):
 * - Output: NRC daily reactor power for nuclear plants (/api/reactors,
 *   joined by reactor_units.json). No free feed publishes live MW for any
 *   other plant, so no other plant gets an Output row.
 * - RT LBMP and Congestion: the NYISO generator-bus price at the plant
 *   (/api/lmp?iso=nyiso), joined to the nearest bundled NYISO gen node
 *   within NYISO_NODE_JOIN_KM; the node's zone becomes the Zone row.
 * - Fleet: the ISO fuel-mix output of the plant's fuel class over the
 *   bundled nameplate of that class (/api/grid), for NYISO and SPP plants
 *   (the `ba` field from EIA-860M). Labelled as the fleet, never as the
 *   plant.
 */

const plantsUrl = new URL(
  './local_data/eia_power_plants/plants.geojsonl',
  import.meta.url,
).href;
const capacityFactorsUrl = new URL(
  './local_data/eia_power_plants/capacity_factors.json',
  import.meta.url,
).href;
const reactorUnitsUrl = new URL(
  './local_data/eia_power_plants/reactor_units.json',
  import.meta.url,
).href;
const nyisoNodesUrl = new URL(
  './local_data/iso_nodes/nyiso.geojsonl',
  import.meta.url,
).href;
const GRID_API_URL = '/api/grid';
const REACTORS_API_URL = '/api/reactors';
const LMP_API_URL = '/api/lmp';

export const POWER_PLANTS_LAYER_ID = 'local-power-plants';
export const PLANT_OVERLAY_SOURCE_ID = 'local-power-plants';
export const PLANT_DETAIL_SOURCE_ID = 'local-power-plants-detail';
export const PLANT_LABEL_MAX = 600;
export const PLANT_LABEL_GRID_PX = 140;
export const PLANT_LABEL_ACCENT = '#ffb300';
const PARSE_CHUNK = 1500;
/**
 * A NYISO gen node this close to a plant is that plant's price node; a
 * node whose name shares a word with the plant counts out to
 * NYISO_NODE_NAME_KM (EIA and NYISO place the same site a couple of km
 * apart).
 */
export const NYISO_NODE_JOIN_KM = 1.5;
export const NYISO_NODE_NAME_KM = 5;
const NAME_STOP_WORDS = new Set([
  'POWER',
  'PLANT',
  'STATION',
  'ENERGY',
  'CENTER',
  'GENERATING',
  'GENERATION',
  'NUCLEAR',
  'PROJECT',
  'SOLAR',
  'WIND',
  'FARM',
  'HYDRO',
  'HYDROELECTRIC',
  'ELECTRIC',
  'FACILITY',
  'UNIT',
  'LLC',
  'CORP',
  'PARK',
  'NORTH',
  'SOUTH',
  'EAST',
  'WEST',
  'LAKE',
  'RIVER',
  'CREEK',
  'POINT',
  'LONG',
  'ISLAND',
  'NEW',
  'YORK',
]);
const KM_PER_DEG_LAT = 110.57;
const KM_PER_DEG_LON_EQ = 111.32;
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

/** Legend wording per fuel key, in display order (short label, tooltip). */
export const POWER_PLANT_FUEL_LABELS = Object.freeze({
  coal: 'coal',
  nuclear: 'nuclear',
  gas: 'gas',
  hydro: 'hydro',
  wind: 'wind',
  solar: 'solar',
  oil: 'oil',
  storage: 'storage',
  biomass: 'biomass',
  geothermal: 'geothermal',
  other: 'other',
});

const POWER_PLANT_FUEL_BLURBS = Object.freeze({
  gas: 'natural gas',
  hydro: 'hydro and pumped storage',
  storage: 'battery storage',
  oil: 'petroleum',
  biomass: 'biomass and landfill gas',
});

/**
 * Anchor style for one plant: colour by fuel, size by nameplate MW.
 * `pixelSize` is the legacy dot ramp (6 px under 10 MW up to 16 px at
 * 2,000 MW and above); `markerPx` is the glyph marker edge over the same
 * ramp (12 px to 26 px: a glyph under 12 px is unreadable).
 * @param {object} props Plant feature properties.
 * @returns {{color:string,pixelSize:number,markerPx:number}}
 */
export function powerPlantStyle(props) {
  const color =
    POWER_PLANT_FUEL_COLORS[props?.fuel] || POWER_PLANT_FUEL_COLORS.other;
  const mw = Number(props?.total_mw);
  const scaled = Number.isFinite(mw) && mw > 0 ? Math.log10(mw) : 0;
  const t = Math.min(1, Math.max(0, (scaled - 1) / 2.3));
  const pixelSize = Math.round(6 + 10 * t);
  const markerPx = Math.round(12 + 14 * t);
  return { color, pixelSize, markerPx };
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

/**
 * Parse the EIA-923 sidecar.
 * @param {string} text JSON `{period, hours, gen_mwh:{code:mwh}}`.
 * @returns {{period:string, hours:number, genMwh:Map<string, number>}|null}
 */
export function parseCapacityFactors(text) {
  let json;
  try {
    json = JSON.parse(String(text || ''));
  } catch {
    return null;
  }
  const hours = Number(json?.hours);
  if (!Number.isFinite(hours) || hours <= 0 || !json?.gen_mwh) return null;
  const genMwh = new Map();
  for (const [code, value] of Object.entries(json.gen_mwh)) {
    const mwh = Number(value);
    if (Number.isFinite(mwh)) genMwh.set(String(code), mwh);
  }
  return { period: String(json.period || ''), hours, genMwh };
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** `2026-01 to 2026-06` -> `Jan to Jun 2026`. */
function periodText(period) {
  const m = /^(\d{4})-(\d{2}) to (\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) return String(period || '');
  const from = MONTHS[Number(m[2]) - 1];
  const to = MONTHS[Number(m[4]) - 1];
  return m[1] === m[3]
    ? `${from} to ${to} ${m[3]}`
    : `${from} ${m[1]} to ${to} ${m[3]}`;
}

/**
 * A plant's capacity factor over the sidecar period, or null when the
 * sidecar has no row for it. Negative net generation (station service
 * only) reads 0%.
 * @param {object} record `{total_mw, genMwh}`.
 * @param {{period:string, hours:number}|null} meta
 * @returns {{pct:string, energy:string, period:string}|null}
 */
export function capacityFactor(record, meta) {
  const mwh = Number(record?.genMwh);
  const mw = Number(record?.total_mw);
  const hours = Number(meta?.hours);
  if (!Number.isFinite(mwh) || !(mw > 0) || !(hours > 0)) return null;
  const cf = Math.max(0, mwh / (mw * hours));
  const gwh = Math.max(0, mwh) / 1000;
  const energy =
    gwh >= 10
      ? `${Math.round(gwh).toLocaleString('en-US')} GWh`
      : `${gwh.toFixed(1)} GWh`;
  return {
    pct: `${Math.round(cf * 100)}%`,
    energy,
    period: periodText(meta.period),
  };
}

/** One-line form of {@link capacityFactor}: `CF 33% · 796 GWh Jan to Jun 2026`. */
export function capacityFactorLine(record, meta) {
  const cf = capacityFactor(record, meta);
  return cf ? `CF ${cf.pct} · ${cf.energy} ${cf.period}` : null;
}

/**
 * Parse the reactor sidecar into plant code -> NRC units.
 * @param {string} text JSON `{units:[{unit, plant_code, ba, lon, lat}]}`.
 * @returns {Map<string, Array<{unit:string, ba:string}>>}
 */
export function parseReactorUnits(text) {
  const map = new Map();
  let json;
  try {
    json = JSON.parse(String(text || ''));
  } catch {
    return map;
  }
  for (const row of json?.units || []) {
    if (!row?.unit || row.plant_code == null) continue;
    const key = String(row.plant_code);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push({ unit: String(row.unit), ba: String(row.ba || '') });
  }
  return map;
}

/**
 * Attach the NYISO generator nodes within `maxKm` of each NYISO plant
 * (`record.nyisoPtids`, nearest first) and the nearest node's zone
 * (`record.zone`).
 * @param {object[]} records Plant records with `ba`, `lon`, `lat`.
 * @param {Map<string, {lon:number, lat:number, zone:string}>} nodes From parseNyisoNodes.
 * @param {number} [maxKm]
 * @returns {number} Plants that gained a node.
 */
export function joinNyisoNodes(
  records,
  nodes,
  { maxKm = NYISO_NODE_JOIN_KM, nameKm = NYISO_NODE_NAME_KM } = {},
) {
  if (!nodes?.size) return 0;
  const list = [...nodes.entries()].map(([id, node]) => [
    id,
    node,
    String(node.name || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, ''),
  ]);
  let joined = 0;
  for (const record of records || []) {
    if (record?.ba !== 'NYIS') continue;
    const tokens = String(record.name || '')
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter((w) => w.length >= 4 && !NAME_STOP_WORDS.has(w))
      .map((w) => w.slice(0, 6));
    const kmPerDegLon =
      KM_PER_DEG_LON_EQ * Math.cos((record.lat * Math.PI) / 180);
    const near = [];
    const named = [];
    for (const [id, node, name] of list) {
      const dx = (node.lon - record.lon) * kmPerDegLon;
      const dy = (node.lat - record.lat) * KM_PER_DEG_LAT;
      const km = Math.sqrt(dx * dx + dy * dy);
      if (km > nameKm) continue;
      const hit = { id, km, zone: node.zone };
      if (tokens.some((t) => name.includes(t))) named.push(hit);
      else if (km <= maxKm) near.push(hit);
    }
    const picks = named.length ? named : near;
    if (!picks.length) continue;
    picks.sort((a, b) => a.km - b.km);
    record.nyisoPtids = picks.map((n) => n.id);
    record.zone = picks[0].zone || '';
    joined += 1;
  }
  return joined;
}

/** `Nine Mile Point 2` -> `U2`; a unit without a number keeps its name. */
function unitLabel(unit) {
  const m = /\s(\d+)$/.exec(String(unit || ''));
  return m ? `U${m[1]}` : String(unit || '');
}

/**
 * NRC output for a nuclear plant: the mean of its units' percent power.
 * @param {object} record
 * @param {{reactors?:{reportDate:string, units:object}|null, reactorUnits?:Map<string, object[]>}|null} live
 * @returns {{pct:number, units:Array<{label:string, pct:number}>, date:string}|null}
 */
export function reactorOutput(record, live) {
  const units = live?.reactorUnits?.get(String(record?.plant_code ?? ''));
  const status = live?.reactors?.units;
  if (!units?.length || !status) return null;
  const rows = [];
  for (const u of units) {
    const pct = Number(status[u.unit]);
    if (Number.isFinite(pct)) rows.push({ label: unitLabel(u.unit), pct });
  }
  if (!rows.length) return null;
  const mean = Math.round(
    rows.reduce((sum, r) => sum + r.pct, 0) / rows.length,
  );
  return { pct: mean, units: rows, date: shortDate(live.reactors.reportDate) };
}

/** The plant's NYISO price node: the joined node with the largest |congestion|. */
function priceNode(record, live) {
  const byPtid = live?.lmp?.byPtid;
  if (!byPtid || !record?.nyisoPtids?.length) return null;
  let best = null;
  for (const ptid of record.nyisoPtids) {
    const node = byPtid.get(String(ptid));
    if (!node || !Number.isFinite(node.lmp)) continue;
    if (!best || Math.abs(node.mcc || 0) > Math.abs(best.mcc || 0)) best = node;
  }
  return best;
}

/**
 * Live rows for one plant (empty without live data): Output (nuclear,
 * NRC), RT LBMP and Congestion (NYISO plants with a price node), Fleet
 * (NYISO and SPP plants).
 * @param {object} record
 * @param {object|null} live `{nyiso, spp, reactors, lmp, reactorUnits, nameplate}`.
 * @returns {Array<[string, string]>}
 */
export function plantLiveRows(record, live) {
  if (!live) return [];
  const rows = [];
  const output = reactorOutput(record, live);
  if (output) {
    const units =
      output.units.length > 1
        ? output.units.map((u) => `${u.label} ${u.pct}%`).join(' · ') + ' · '
        : '';
    rows.push(['Output', `${output.pct}% · ${units}NRC ${output.date}`]);
  }
  const node = priceNode(record, live);
  if (node) {
    const when = formatIntervalEt('nyiso', live.lmp.interval);
    rows.push(['RT LBMP', `${money(node.lmp)}${when ? ` · ${when}` : ''}`]);
    rows.push(['Congestion', `${money(node.mcc, { signed: true })}/MWh`]);
  }
  const mix =
    record?.ba === 'NYIS'
      ? live.nyiso?.fuelMix
      : record?.ba === 'SWPP'
        ? live.spp?.fuelMix
        : null;
  const fleet = fleetRow(record, mix, live.nameplate);
  if (fleet) rows.push(['Fleet', fleet]);
  return rows;
}

function mwText(mw) {
  const value = Number(mw);
  return Number.isFinite(value) && value > 0
    ? `${Math.round(value).toLocaleString('en-US')} MW`
    : '';
}

function techText(record) {
  return record?.tech?.replace(/;\s*$/, '').replace(/;\s*/g, ' · ') || '';
}

/**
 * Label and value table for the hover and pinned card (the Yes Energy
 * generator card shape). Rows without a value are left out; the live rows
 * need `live` (see plantLiveRows), the CF and Generation rows the EIA-923
 * sidecar. Zone (NYISO) or BA stands where Yes shows the zone; State
 * only shows when neither is known.
 * @param {object} record
 * @param {{cfMeta?:{period:string, hours:number}|null, live?:object|null}} [ctx]
 * @returns {Array<[string, string]>}
 */
export function plantCardRows(record, { cfMeta = null, live = null } = {}) {
  const cf = capacityFactor(record, cfMeta);
  // One technology per row (a blank label continues the Tech row) so a
  // multi-technology plant does not stretch the card.
  const techs = techText(record).split(' · ');
  const area = record?.zone
    ? ['Zone', record.zone]
    : record?.ba
      ? ['BA', record.ba]
      : ['State', record?.state || ''];
  return [
    ['Capacity', mwText(record?.total_mw)],
    ...plantLiveRows(record, live),
    ['Fuel', record?.prim_source || record?.fuel || ''],
    ...techs.map((tech, i) => [i === 0 ? 'Tech' : '', tech]),
    ['CF', cf ? `${cf.pct} · ${cf.period}` : ''],
    ['Generation', cf ? cf.energy : ''],
    area,
    ['Utility', record?.utility || ''],
    ['EIA id', record?.plant_code ? String(record.plant_code) : ''],
  ].filter(([, value]) => value);
}

/**
 * Card copy for one plant. The first detail line is what the ambient card
 * shows (fuel, MW, the NRC output when the plant has one, utility);
 * `rows` is the table the hover card draws.
 * @param {object} record
 * @param {{cfMeta?:object|null, live?:object|null}} [ctx]
 * @returns {{title:string, details:string[], rows:Array<[string, string]>}}
 */
export function plantCardCopy(record, ctx = {}) {
  const title = record?.name || 'Power plant';
  const output = reactorOutput(record, ctx?.live);
  const summary = [
    record?.prim_source || record?.fuel,
    mwText(record?.total_mw),
    output ? `${output.pct}%` : null,
    record?.utility,
  ]
    .filter(Boolean)
    .join(' · ');
  const tech = [
    techText(record),
    record?.plant_code ? `EIA ${record.plant_code}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
  return {
    title,
    details: [summary, tech].filter(Boolean),
    rows: plantCardRows(record, ctx),
  };
}

/**
 * Ambient card (same shape the shared local-infrastructure engine publishes).
 * @param {object} record Record with `position`.
 * @param {{live?:object|null}} [ctx] Live data for the NRC output figure.
 * @returns {object}
 */
export function createPlantOverlayEntry(record, ctx = {}) {
  const { title, details } = plantCardCopy(record, ctx);
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
 * Hover (card) or pinned (selected) detail entry: the title over the
 * label and value table.
 * @param {object} record Record with `position`.
 * @param {{pinned?:boolean, cfMeta?:object|null, live?:object|null}} [options]
 * @returns {object}
 */
export function createPlantDetailEntry(
  record,
  { pinned = false, cfMeta = null, live = null } = {},
) {
  const { title, rows } = plantCardCopy(record, { cfMeta, live });
  return createHoverCardEntry({
    id: record.id,
    position: record.position,
    title,
    details: [],
    rows,
    accent: powerPlantStyle(record).color,
    pinned,
  });
}

/**
 * Legend rows: one per fuel with its colour, glyph and site count, in the
 * Yes Energy order.
 * @param {object[]} records
 * @returns {Array<{color:string,icon:string,label:string,count:number,blurb:string}>}
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
      icon: POWER_PLANT_FUEL_ICONS[key],
      label: POWER_PLANT_FUEL_LABELS[key],
      count: counts[key],
      blurb: [
        POWER_PLANT_FUEL_BLURBS[key],
        'EIA primary energy source; marker size follows nameplate MW',
      ]
        .filter(Boolean)
        .join(' · '),
    }));
}

export function createPowerPlantsLayer({
  overlayHost = DEFAULT_OVERLAY_HOST,
  sprites = createPlantMarkerSpriteCache(),
  focus = requestWorldFocus,
  fetchJson = (url) =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    }),
  fetchText = (url) =>
    fetch(url).then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }),
} = {}) {
  let _viewer = null;
  let _markers = null;
  /** @type {object[]} Records with `position` and `marker`. */
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
  /** @type {{period:string, hours:number}|null} EIA-923 sidecar metadata. */
  let _cfMeta = null;
  /** Live feeds for the card rows; `null` until the first poll lands. */
  let _live = null;
  /** @type {Map<string, object[]>} Plant code -> NRC units (sidecar). */
  let _reactorUnits = new Map();
  /** @type {Map<string, number>} `'BA|fuel'` -> nameplate MW (bundle). */
  let _nameplate = new Map();
  /** @type {object[]} Nuclear records with NRC units (label refresh). */
  let _nuclearRecords = [];
  let _liveAt = null;

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
    entryFor: (record, { pinned }) =>
      createPlantDetailEntry(record, { pinned, cfMeta: _cfMeta, live: _live }),
    onChange: (record) => {
      const id = record?.id || null;
      if (id === _cardId) return;
      _cardId = id;
      if (_enabled) publishCohort();
    },
    // Double-click: pin the card and fly to the plant.
    onActivate: (record) =>
      focus({
        kind: 'plant',
        id: record.id,
        label: record.name || 'Power plant',
        position: record.position,
      }),
    overlayHost,
  });

  const optional = (url, what) =>
    fetchText(url).catch((err) => {
      console.warn(
        `[Data:Power Plants] ${what} unavailable:`,
        err?.message || err,
      );
      return '';
    });

  async function load(generation) {
    const [text, cfText, reactorText, nodesText] = await Promise.all([
      fetchText(plantsUrl),
      optional(capacityFactorsUrl, 'capacity factors'),
      optional(reactorUnitsUrl, 'reactor units'),
      optional(nyisoNodesUrl, 'NYISO nodes'),
    ]);
    if (generation !== _generation || !_markers) return;
    const parsed = parsePlantRecords(text);
    const cf = parseCapacityFactors(cfText);
    if (cf) {
      _cfMeta = { period: cf.period, hours: cf.hours };
      for (const record of parsed) {
        const mwh = cf.genMwh.get(String(record.plant_code));
        if (mwh !== undefined) record.genMwh = mwh;
      }
    }
    for (let i = 0; i < parsed.length; i++) {
      if (i > 0 && i % PARSE_CHUNK === 0) {
        // Yield so a 13K-row bundle never blocks one long task.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (generation !== _generation || !_markers) return;
      }
      const record = parsed[i];
      record.position = Cesium.Cartesian3.fromDegrees(record.lon, record.lat);
      const style = powerPlantStyle(record);
      const fuel = POWER_PLANT_FUEL_COLORS[record.fuel] ? record.fuel : 'other';
      record.marker = _markers.add({
        id: record,
        position: record.position,
        width: style.markerPx,
        height: style.markerPx,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      });
      // One atlas texture per fuel: setImage keys by id, `image:` would
      // give every canvas its own entry.
      const sprite = sprites.get(
        fuel,
        style.color,
        POWER_PLANT_FUEL_ICONS[fuel],
      );
      if (sprite) record.marker.setImage(`plant-fuel:${fuel}`, sprite);
      record.entry = createPlantOverlayEntry(record);
      _records.push(record);
      _byId.set(record.id, record);
    }
    _reactorUnits = parseReactorUnits(reactorText);
    _nuclearRecords = _records.filter((r) =>
      _reactorUnits.has(String(r.plant_code)),
    );
    _nameplate = fleetNameplateByBaFuel(_records);
    joinNyisoNodes(_records, parseNyisoNodes(nodesText));
    if (_live) refreshLive();
    _legend = plantLegend(_records);
    _lastUpdate = Date.now();
    _error = null;
    _cohortDirty = true;
    _rowControlsListener?.();
    _viewer?.scene?.requestRender?.();
  }

  /** Re-derive everything that reads `_live`: nuclear labels, the open card. */
  function refreshLive() {
    for (const record of _nuclearRecords)
      record.entry = createPlantOverlayEntry(record, { live: _live });
    hover.sync((id) => _byId.get(id) || null);
    _cohortDirty = true;
    _lastWalk = 0;
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
      if (record.marker.show !== show) record.marker.show = show;
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
    source: 'EIA-860 · live rows 5 min',
    updateInterval: 300000,
    statsRefreshInterval: 1000,

    init(viewer) {
      _viewer = viewer;
      _markers = new Cesium.BillboardCollection();
      _markers.show = false;
      viewer.scene.primitives.add(_markers);
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
      if (_markers) _markers.show = true;
      overlayHost.setVisible(PLANT_OVERLAY_SOURCE_ID, true);
      hover.setEnabled(true);
      _cohortDirty = true;
      _lastWalk = 0;
      startLoad();
      _viewer?.scene?.requestRender?.();
    },

    disable() {
      _enabled = false;
      if (_markers) _markers.show = false;
      hover.setEnabled(false);
      overlayHost.clearSource(PLANT_OVERLAY_SOURCE_ID);
      overlayHost.setVisible(PLANT_OVERLAY_SOURCE_ID, false);
      _viewer?.scene?.requestRender?.();
    },

    /**
     * Poll the live feeds behind the card rows. Every endpoint is
     * proxy-cached, so this adds no upstream traffic. A failed feed keeps
     * its last value; the enable is never rejected for it.
     */
    async update() {
      if (!_enabled) return true;
      const results = await Promise.allSettled([
        fetchJson(`${GRID_API_URL}?iso=nyiso`),
        fetchJson(`${GRID_API_URL}?iso=spp`),
        fetchJson(REACTORS_API_URL),
        fetchJson(`${LMP_API_URL}?iso=nyiso`),
      ]);
      if (!_enabled) return true;
      const value = (i) =>
        results[i].status === 'fulfilled' ? results[i].value : null;
      const prev = _live || {};
      const lmp = value(3);
      _live = {
        nyiso: value(0) || prev.nyiso || null,
        spp: value(1) || prev.spp || null,
        reactors: value(2)?.units ? value(2) : prev.reactors || null,
        lmp: Array.isArray(lmp?.nodes)
          ? {
              interval: lmp.interval,
              byPtid: new Map(lmp.nodes.map((n) => [String(n.ptid), n])),
            }
          : prev.lmp || null,
        reactorUnits: _reactorUnits,
        nameplate: _nameplate,
      };
      const failed = results.filter((r) => r.status === 'rejected');
      if (failed.length) {
        console.warn(
          '[Data:Power Plants] live feed failed:',
          failed.map((r) => r.reason?.message || r.reason).join('; '),
        );
      }
      _liveAt = Date.now();
      refreshLive();
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
      if (_markers) {
        try {
          target?.scene?.primitives?.remove(_markers);
        } catch {
          /* collection already gone */
        }
        _markers = null;
      }
      _records = [];
      _cohort = [];
      _cardId = null;
      _byId = new Map();
      _legend = [];
      _cfMeta = null;
      _live = null;
      _liveAt = null;
      _reactorUnits = new Map();
      _nameplate = new Map();
      _nuclearRecords = [];
      _lastUpdate = null;
      _error = null;
      _viewer = null;
    },

    getRowControls() {
      return {
        chips: [],
        legend: _legend,
        legendHeading: 'Fuel type',
        legendLayout: 'list',
      };
    },

    setRowControlsListener(listener) {
      _rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        count: _records.length,
        lastUpdate: _liveAt || _lastUpdate,
        error: _error,
      };
    },
  };
}

export default createPowerPlantsLayer();
