/**
 * Grid-condition feeds behind the "why" of a congestion incident. Pure
 * parsers and copy, shared by the /api/grid and /api/reactors proxies and
 * the plant, line and LMP layers. No Cesium, no DOM.
 *
 * Feeds (all keyless):
 * - NYISO real-time fuel mix, csv/rtfuelmix/<day>rtfuelmix.csv, 5 min,
 *   seven categories in MW (solar sits inside Other Renewables).
 * - NYISO real-time actual load, csv/pal/<day>pal.csv, 5 min, 11 zones.
 * - NYISO real-time line outages, currentRTLineOutages.csv, live; the
 *   equipment name is a fixed-width EMS string (`BECK____-NIAGARA__230_PA27`).
 * - SPP generation mix, portal.spp.org/chart-api/gen-mix/asFile, 5 min,
 *   eleven fuels plus the SPP load, UTC stamps.
 * - NRC power reactor status, PowerReactorStatusForLast365Days.txt, daily,
 *   percent power per unit.
 */
import { splitCsvLine } from './lmpFeeds.js';

/** NYISO fuel-mix category text -> key. */
export const NYISO_FUEL_KEYS = Object.freeze({
  'Dual Fuel': 'dual',
  'Natural Gas': 'gas',
  Nuclear: 'nuclear',
  'Other Fossil Fuels': 'otherFossil',
  'Other Renewables': 'otherRenewables',
  Wind: 'wind',
  Hydro: 'hydro',
});

/** SPP gen-mix column text -> key. */
export const SPP_FUEL_KEYS = Object.freeze({
  Coal: 'coal',
  'Diesel Fuel Oil': 'oil',
  Hydro: 'hydro',
  'Natural Gas': 'gas',
  Nuclear: 'nuclear',
  Solar: 'solar',
  'Waste Disposal Services': 'biomass',
  Wind: 'wind',
  'Waste Heat': 'other',
  'Energy Storage': 'storage',
  Other: 'other',
});

/**
 * Group CSV rows by their first column (a timestamp) and return the last
 * group that is provably complete: when the text is a byte-range tail the
 * first line is partial and the last group counts only if an earlier group
 * precedes it in the window.
 * @param {string} text
 * @param {{partialHead?:boolean, minCols?:number}} [options]
 * @returns {{interval:string, rows:string[][]}|null}
 */
function lastCompleteGroup(text, { partialHead = true, minCols = 4 } = {}) {
  if (typeof text !== 'string' || !text.length) return null;
  const lines = text.split(/\r?\n/);
  if (partialHead) lines.shift();
  const groups = new Map();
  const order = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || /^"?Time Stamp/.test(line)) continue;
    const cols = splitCsvLine(line).map((c) => c.trim());
    if (cols.length < minCols || !cols[0]) continue;
    if (!groups.has(cols[0])) {
      groups.set(cols[0], []);
      order.push(cols[0]);
    }
    groups.get(cols[0]).push(cols);
  }
  if (order.length === 0 || (order.length < 2 && partialHead)) return null;
  const interval = order[order.length - 1];
  return { interval, rows: groups.get(interval) };
}

/**
 * Latest NYISO fuel mix. Columns: Time Stamp, Time Zone, Fuel Category, Gen MW.
 * @param {string} text Day file or a byte-range tail.
 * @param {{partialHead?:boolean}} [options]
 * @returns {{interval:string, mw:Object<string, number>}|null}
 */
export function parseNyisoFuelMixTail(text, options = {}) {
  const group = lastCompleteGroup(text, { ...options, minCols: 4 });
  if (!group) return null;
  const mw = {};
  for (const cols of group.rows) {
    const key = NYISO_FUEL_KEYS[cols[2]];
    const value = Number(cols[3]);
    if (key && Number.isFinite(value)) mw[key] = value;
  }
  return Object.keys(mw).length ? { interval: group.interval, mw } : null;
}

/**
 * Latest NYISO zonal load. Columns: Time Stamp, Time Zone, Name, PTID, Load.
 * @param {string} text Day file or a byte-range tail.
 * @param {{partialHead?:boolean}} [options]
 * @returns {{interval:string, total:number, byZone:Object<string, number>}|null}
 */
export function parseNyisoLoadTail(text, options = {}) {
  const group = lastCompleteGroup(text, { ...options, minCols: 5 });
  if (!group) return null;
  const byZone = {};
  let total = 0;
  for (const cols of group.rows) {
    const value = Number(cols[4]);
    if (!cols[2] || !Number.isFinite(value)) continue;
    byZone[cols[2]] = Math.round(value * 10) / 10;
    total += value;
  }
  return Object.keys(byZone).length
    ? { interval: group.interval, total: Math.round(total), byZone }
    : null;
}

/**
 * Split a NYISO EMS equipment name. Lines read `AAAAAAAA-BBBBBBBB_kv_circuit`
 * (two 8-character station fields padded with underscores); station
 * equipment (transformers, capacitors, breakers) reads `AAAAAAAA_...`.
 * @param {string} name
 * @returns {{kind:'line', from:string, to:string, kv:number|null, circuit:string}|{kind:'equipment', from:string, to:null, kv:number|null, circuit:string}}
 */
export function parseNyisoEquipmentName(name) {
  const text = String(name || '');
  const from = text.slice(0, 8).replace(/_+$/, '');
  if (text[8] === '-') {
    const to = text.slice(9, 17).replace(/_+$/, '');
    const rest = text.slice(17).replace(/^[_ ]+/, '');
    const m = /^(\d{2,3})(?:KV)?[_ ]*(.*)$/.exec(rest);
    return {
      kind: 'line',
      from,
      to,
      kv: m ? Number(m[1]) : null,
      circuit: m ? m[2] : rest,
    };
  }
  const rest = text.slice(9).replace(/^[_ ]+/, '');
  const m = /^(\d{2,3})(?:KV)?[_ ]*(.*)$/.exec(rest);
  return {
    kind: 'equipment',
    from,
    to: null,
    kv: m ? Number(m[1]) : null,
    circuit: m ? m[2] : rest,
  };
}

/**
 * NYISO real-time line outages. Columns: Timestamp, PTID, Equipment Name,
 * Outage Date/Time.
 * @param {string} text
 * @returns {Array<{ptid:string, name:string, kind:string, from:string, to:string|null, kv:number|null, circuit:string, since:string}>}
 */
export function parseNyisoLineOutages(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^"?Timestamp/.test(line)) continue;
    const cols = splitCsvLine(line).map((c) => c.trim());
    if (cols.length < 4 || !cols[2]) continue;
    out.push({
      ptid: cols[1],
      name: cols[2],
      ...parseNyisoEquipmentName(cols[2]),
      since: cols[3],
    });
  }
  return out;
}

/**
 * Latest SPP generation mix row. Header: GMT MKT Interval, BAA, <fuels>, Load.
 * @param {string} text
 * @returns {{interval:string, mw:Object<string, number>, load:number}|null}
 */
export function parseSppGenMix(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]).map((c) => c.trim());
  const cols = splitCsvLine(lines[lines.length - 1]).map((c) => c.trim());
  if (cols.length !== header.length || !cols[0]) return null;
  const mw = {};
  let load = null;
  for (let i = 1; i < header.length; i++) {
    const value = Number(cols[i]);
    if (!Number.isFinite(value)) continue;
    if (header[i] === 'Load') load = Math.round(value);
    const key = SPP_FUEL_KEYS[header[i]];
    if (key) mw[key] = Math.round(((mw[key] || 0) + value) * 10) / 10;
  }
  return Object.keys(mw).length ? { interval: cols[0], mw, load } : null;
}

/**
 * Latest NRC reactor status per unit. Lines: ReportDt|Unit|Power, newest
 * first; the first date in the file is the report date.
 * @param {string} text
 * @returns {{reportDate:string, units:Object<string, number>}|null}
 */
export function parseNrcReactorStatus(text) {
  const units = {};
  let reportDate = null;
  for (const raw of String(text || '')
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)) {
    const cols = raw.split('|');
    if (cols.length < 3 || cols[0].startsWith('ReportDt')) continue;
    const date = cols[0].trim();
    const unit = cols[1].trim();
    const power = Number(cols[2]);
    if (!date || !unit || !Number.isFinite(power)) continue;
    if (!reportDate) reportDate = date;
    if (date !== reportDate) break;
    units[unit] = power;
  }
  return reportDate ? { reportDate: nrcDateIso(reportDate), units } : null;
}

/** `9/14/2026 12:00:00 AM` -> `2026-09-14`. */
function nrcDateIso(text) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(text || ''));
  if (!m) return String(text || '');
  return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
}

/** `2026-09-14` -> `14 Sep`. */
export function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return String(iso || '');
  const months = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');
  return `${Number(m[3])} ${months[Number(m[2]) - 1]}`;
}

/** `09/14/2026 11:25:00` -> `11:25 ET`; `2026-09-14T16:20:00Z` -> `16:20Z`. */
export function shortTime(stamp) {
  const text = String(stamp || '');
  let m = /^\d{2}\/\d{2}\/\d{4} (\d{2}:\d{2})/.exec(text);
  if (m) return `${m[1]} ET`;
  m = /T(\d{2}:\d{2})(?::\d{2})?Z$/.exec(text);
  if (m) return `${m[1]}Z`;
  return text;
}

/** `6629` -> `6.6 GW`; `537` -> `0.5 GW`; `41852` -> `41.9 GW`. */
export function gwText(mw) {
  const value = Number(mw);
  if (!Number.isFinite(value)) return '';
  return `${(value / 1000).toFixed(1)} GW`;
}

/**
 * Which live fuel-mix categories stand for a plant's fuel, per ISO, and
 * which bundled fuels make up the matching nameplate so the ratio compares
 * like with like. NYISO folds oil-capable gas units into Dual Fuel and
 * solar into Other Renewables; SPP reports each fuel on its own.
 */
export const FLEET_CATEGORIES = Object.freeze({
  NYIS: Object.freeze({
    gas: {
      label: 'gas+dual',
      live: ['gas', 'dual'],
      nameplate: ['gas', 'oil'],
    },
    oil: {
      label: 'gas+dual',
      live: ['gas', 'dual'],
      nameplate: ['gas', 'oil'],
    },
    nuclear: { label: 'nuclear', live: ['nuclear'], nameplate: ['nuclear'] },
    hydro: { label: 'hydro', live: ['hydro'], nameplate: ['hydro'] },
    wind: { label: 'wind', live: ['wind'], nameplate: ['wind'] },
    solar: {
      label: 'other renewables',
      live: ['otherRenewables'],
      nameplate: ['solar', 'biomass', 'geothermal'],
    },
    biomass: {
      label: 'other renewables',
      live: ['otherRenewables'],
      nameplate: ['solar', 'biomass', 'geothermal'],
    },
    coal: {
      label: 'other fossil',
      live: ['otherFossil'],
      nameplate: ['coal', 'other'],
    },
  }),
  SWPP: Object.freeze({
    coal: { label: 'coal', live: ['coal'], nameplate: ['coal'] },
    oil: { label: 'oil', live: ['oil'], nameplate: ['oil'] },
    hydro: { label: 'hydro', live: ['hydro'], nameplate: ['hydro'] },
    gas: { label: 'gas', live: ['gas'], nameplate: ['gas'] },
    nuclear: { label: 'nuclear', live: ['nuclear'], nameplate: ['nuclear'] },
    solar: { label: 'solar', live: ['solar'], nameplate: ['solar'] },
    biomass: { label: 'biomass', live: ['biomass'], nameplate: ['biomass'] },
    wind: { label: 'wind', live: ['wind'], nameplate: ['wind'] },
    storage: { label: 'storage', live: ['storage'], nameplate: ['storage'] },
  }),
});

const ISO_LABEL = Object.freeze({ NYIS: 'NYISO', SWPP: 'SPP' });

/**
 * Fleet row value for a plant: the live output of its fuel class across
 * the ISO over the bundled nameplate of that class, e.g.
 * `58% · NYISO gas+dual 6.6 of 11.4 GW · 11:25 ET`. Null when the ISO has
 * no mix, the fuel no category, or the nameplate is zero.
 * @param {{ba:string, fuel:string}} record
 * @param {{interval:string, mw:Object<string, number>}|null} mix
 * @param {Map<string, number>} nameplate `'BA|fuel'` -> MW from the bundle.
 * @returns {string|null}
 */
export function fleetRow(record, mix, nameplate) {
  const ba = record?.ba;
  const category = FLEET_CATEGORIES[ba]?.[record?.fuel];
  if (!category || !mix?.mw) return null;
  let live = 0;
  let seen = false;
  for (const key of category.live) {
    if (Number.isFinite(mix.mw[key])) {
      live += mix.mw[key];
      seen = true;
    }
  }
  if (!seen) return null;
  let plate = 0;
  for (const fuel of category.nameplate)
    plate += nameplate?.get(`${ba}|${fuel}`) || 0;
  if (!(plate > 0)) return null;
  const pct = Math.max(0, Math.round((live / plate) * 100));
  return `${pct}% · ${ISO_LABEL[ba] || ba} ${category.label} ${gwText(live)} of ${gwText(plate)} · ${shortTime(mix.interval)}`;
}

/**
 * Bundled nameplate by balancing authority and fuel.
 * @param {Array<{ba?:string, fuel?:string, total_mw?:number}>} records
 * @returns {Map<string, number>} `'BA|fuel'` -> MW.
 */
export function fleetNameplateByBaFuel(records) {
  const out = new Map();
  for (const r of records || []) {
    const mw = Number(r?.total_mw);
    if (!r?.ba || !r?.fuel || !(mw > 0)) continue;
    const key = `${r.ba}|${r.fuel}`;
    out.set(key, (out.get(key) || 0) + mw);
  }
  return out;
}

/**
 * Grid-condition chips for the ISO Congestion row: load, wind, nuclear
 * (with any unit under 90%), line outages, binding constraints, per ISO.
 * @param {object} input
 * @param {{load?:{total:number}|null, fuelMix?:{mw:object}|null, lineOutages?:object[]}|null} input.nyiso
 * @param {{load?:number|null, fuelMix?:{mw:object}|null}|null} input.spp
 * @param {{reportDate:string, units:Object<string, number>}|null} input.reactors
 * @param {Array<{unit:string, plant_code:number, ba?:string}>} [input.reactorUnits] Bundled sidecar (NY units are those whose plant sits in NYIS).
 * @param {{nyiso?:number, spp?:number}} [input.binding] Binding constraint counts.
 * @returns {Array<{id:string, label:string, title:string, state:'info'}>}
 */
export function gridChips({
  nyiso,
  spp,
  reactors,
  reactorUnits = [],
  binding = {},
}) {
  const chips = [];
  const chip = (id, label, title) =>
    chips.push({ id, label, title, state: 'info' });
  const derated = (ba) =>
    reactorUnits
      .filter(
        (u) =>
          u.ba === ba &&
          Number.isFinite(reactors?.units?.[u.unit]) &&
          reactors.units[u.unit] < 90,
      )
      .map((u) => `${u.unit} ${reactors.units[u.unit]}%`);
  if (nyiso) {
    if (nyiso.load?.total)
      chip(
        'ny-load',
        `NY load ${gwText(nyiso.load.total)}`,
        `NYISO actual load, ${shortTime(nyiso.load.interval)}`,
      );
    const mw = nyiso.fuelMix?.mw;
    if (mw) {
      if (Number.isFinite(mw.wind))
        chip(
          'ny-wind',
          `NY wind ${gwText(mw.wind)}`,
          `NYISO wind output, ${shortTime(nyiso.fuelMix.interval)}`,
        );
      if (Number.isFinite(mw.nuclear)) {
        const down = derated('NYIS');
        chip(
          'ny-nuclear',
          `NY nuclear ${gwText(mw.nuclear)}${down.length ? ` · ${down.join(', ')}` : ''}`,
          down.length
            ? `NRC unit power ${shortDate(reactors.reportDate)}`
            : 'NYISO nuclear output',
        );
      }
    }
    if (Array.isArray(nyiso.lineOutages)) {
      const lines = nyiso.lineOutages.filter((o) => o.kind === 'line').length;
      chip(
        'ny-outages',
        `NY line outages ${lines}`,
        `${nyiso.lineOutages.length} NYISO real-time outages, ${lines} on lines`,
      );
    }
    if (Number.isFinite(binding.nyiso))
      chip(
        'ny-binding',
        `NY binding ${binding.nyiso}`,
        'NYISO limiting constraints with a shadow price',
      );
  }
  if (spp) {
    if (spp.load)
      chip(
        'spp-load',
        `SPP load ${gwText(spp.load)}`,
        `SPP load, ${shortTime(spp.fuelMix?.interval)}`,
      );
    const mw = spp.fuelMix?.mw;
    if (mw) {
      if (Number.isFinite(mw.wind))
        chip(
          'spp-wind',
          `SPP wind ${gwText(mw.wind)}`,
          `SPP wind output, ${shortTime(spp.fuelMix.interval)}`,
        );
      if (Number.isFinite(mw.nuclear)) {
        const down = derated('SWPP');
        chip(
          'spp-nuclear',
          `SPP nuclear ${gwText(mw.nuclear)}${down.length ? ` · ${down.join(', ')}` : ''}`,
          down.length
            ? `NRC unit power ${shortDate(reactors.reportDate)}`
            : 'SPP nuclear output',
        );
      }
    }
    if (Number.isFinite(binding.spp))
      chip(
        'spp-binding',
        `SPP binding ${binding.spp}`,
        'SPP binding constraints with a shadow price',
      );
  }
  return chips;
}
