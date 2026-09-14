import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  capacityFactorLine,
  createPlantDetailEntry,
  plantCardRows,
  createPlantOverlayEntry,
  isPlantPickId,
  parseCapacityFactors,
  parsePlantRecords,
  plantCardCopy,
  plantLegend,
  plantLiveRows,
  parseReactorUnits,
  joinNyisoNodes,
  reactorOutput,
  powerPlantStyle,
  POWER_PLANT_FUEL_COLORS,
} from './powerPlants.js';
import { parseNyisoNodes } from './isoLmp.js';
import { POWER_PLANT_FUEL_ICONS } from './powerPlantIcons.js';
import {
  createPlantMarkerSpriteCache,
  PLANT_MARKER_SPRITE_PX,
} from './plantMarkerSprite.js';

const JAMES_RIVER = {
  name: 'James River Power Station',
  plant_code: 2161,
  fuel: 'gas',
  prim_source: 'natural gas',
  tech: 'Natural Gas Fired Combustion Turbine',
  total_mw: 155,
  state: 'Missouri',
  utility: 'City Utilities of Springfield - (MO)',
};

test('power plant anchors take the fuel colour and scale with nameplate MW', () => {
  assert.deepEqual(powerPlantStyle({ fuel: 'nuclear', total_mw: 2200 }), {
    color: POWER_PLANT_FUEL_COLORS.nuclear,
    pixelSize: 16,
    markerPx: 26,
  });
  assert.deepEqual(powerPlantStyle({ fuel: 'solar', total_mw: 5 }), {
    color: POWER_PLANT_FUEL_COLORS.solar,
    pixelSize: 6,
    markerPx: 12,
  });
  assert.equal(
    powerPlantStyle({ fuel: 'unlisted' }).color,
    POWER_PLANT_FUEL_COLORS.other,
  );
  assert.equal(powerPlantStyle(null).pixelSize, 6);
  assert.equal(powerPlantStyle({ fuel: 'gas', total_mw: 100 }).pixelSize, 10);
  assert.equal(powerPlantStyle({ fuel: 'gas', total_mw: 100 }).markerPx, 18);
});

test('marker sprites draw the fuel glyph once per fuel and are cached', () => {
  const fills = [];
  class FakePath {
    constructor(d) {
      this.d = d;
    }
  }
  const createCanvas = () => ({
    width: 0,
    height: 0,
    getContext: () => ({
      beginPath() {},
      arc() {},
      stroke() {},
      save() {},
      restore() {},
      translate() {},
      scale() {},
      fill(path) {
        if (path) fills.push([path.d, this.fillStyle]);
      },
    }),
  });
  const cache = createPlantMarkerSpriteCache({
    createCanvas,
    path2d: FakePath,
  });
  const gas = cache.get(
    'gas',
    POWER_PLANT_FUEL_COLORS.gas,
    POWER_PLANT_FUEL_ICONS.gas,
  );
  assert.equal(gas.width, PLANT_MARKER_SPRITE_PX);
  assert.equal(
    cache.get('gas', POWER_PLANT_FUEL_COLORS.gas, POWER_PLANT_FUEL_ICONS.gas),
    gas,
  );
  cache.get('coal', POWER_PLANT_FUEL_COLORS.coal, POWER_PLANT_FUEL_ICONS.coal);
  assert.equal(cache.size(), 2);
  assert.deepEqual(fills, [
    [POWER_PLANT_FUEL_ICONS.gas, POWER_PLANT_FUEL_COLORS.gas],
    [POWER_PLANT_FUEL_ICONS.coal, POWER_PLANT_FUEL_COLORS.coal],
  ]);
});

test('the bundle parses to one record per plant, small sites included', () => {
  const text = readFileSync(
    new URL('./local_data/eia_power_plants/plants.geojsonl', import.meta.url),
    'utf8',
  );
  const records = parsePlantRecords(text);
  assert.equal(records.length, 13446);
  const springfield = records.filter(
    (r) => /Springfield/.test(r.utility) && r.state === 'Missouri',
  );
  assert.deepEqual(springfield.map((r) => r.name).sort(), [
    'James River Power Station',
    'John Twitty Energy Center',
    'McCartney',
    'Noble Hill Landfill',
  ]);
  const noble = springfield.find((r) => r.name === 'Noble Hill Landfill');
  assert.equal(noble.id, 'plant:56404');
  assert.ok(noble.priority > 1000 && noble.priority < 1001);
  assert.ok(isPlantPickId(noble.id));
  assert.equal(isPlantPickId('nyiso:1'), false);
});

test('card copy: ambient card keeps the summary, hover card is a label and value table', () => {
  assert.deepEqual(plantCardCopy(JAMES_RIVER), {
    title: 'James River Power Station',
    details: [
      'natural gas · 155 MW · City Utilities of Springfield - (MO)',
      'Natural Gas Fired Combustion Turbine · EIA 2161',
    ],
    rows: [
      ['Capacity', '155 MW'],
      ['Fuel', 'natural gas'],
      ['Tech', 'Natural Gas Fired Combustion Turbine'],
      ['State', 'Missouri'],
      ['Utility', 'City Utilities of Springfield - (MO)'],
      ['EIA id', '2161'],
    ],
  });
  const multi = plantCardCopy({
    ...JAMES_RIVER,
    tech: 'Conventional Steam Coal; Natural Gas Fired Combustion Turbine;',
  });
  assert.equal(
    multi.details[1],
    'Conventional Steam Coal · Natural Gas Fired Combustion Turbine · EIA 2161',
  );
  assert.deepEqual(multi.rows.slice(2, 4), [
    ['Tech', 'Conventional Steam Coal'],
    ['', 'Natural Gas Fired Combustion Turbine'],
  ]);
  const record = {
    ...JAMES_RIVER,
    id: 'plant:2161',
    priority: 1038.75,
    position: { x: 1, y: 2, z: 3 },
  };
  const ambient = createPlantOverlayEntry(record);
  assert.equal(ambient.variant, 'card');
  assert.equal(ambient.details.length, 1);
  assert.equal(ambient.priority, 1038.75);
  const pinned = createPlantDetailEntry(record, { pinned: true });
  assert.equal(pinned.variant, 'selected');
  assert.equal(pinned.accent, POWER_PLANT_FUEL_COLORS.gas);
  assert.deepEqual(pinned.details, []);
  assert.equal(pinned.rows.length, 6);
  assert.deepEqual(plantCardRows({ name: 'Bare' }), []);
});

test('capacity factor joins the EIA-923 sidecar by plant code onto the hover card only', () => {
  const text = readFileSync(
    new URL(
      './local_data/eia_power_plants/capacity_factors.json',
      import.meta.url,
    ),
    'utf8',
  );
  const cf = parseCapacityFactors(text);
  assert.ok(cf.genMwh.size > 3000);
  assert.equal(cf.hours, 4344);
  assert.equal(cf.period, '2026-01 to 2026-06');
  assert.ok(cf.genMwh.has('2161'), 'James River reports monthly');
  assert.equal(parseCapacityFactors('not json'), null);
  assert.equal(parseCapacityFactors('{"hours":0,"gen_mwh":{}}'), null);

  const meta = { period: '2026-01 to 2026-06', hours: 4344 };
  const record = { ...JAMES_RIVER, genMwh: 37664 };
  assert.equal(
    capacityFactorLine(record, meta),
    'CF 6% · 38 GWh Jan to Jun 2026',
  );
  assert.equal(
    capacityFactorLine({ total_mw: 563, genMwh: 796111 }, meta),
    'CF 33% · 796 GWh Jan to Jun 2026',
  );
  assert.equal(
    capacityFactorLine({ total_mw: 5, genMwh: -120 }, meta),
    'CF 0% · 0.0 GWh Jan to Jun 2026',
  );
  assert.equal(capacityFactorLine(JAMES_RIVER, meta), null);
  assert.equal(capacityFactorLine(record, null), null);
  assert.equal(
    capacityFactorLine(
      { total_mw: 10, genMwh: 5000 },
      { period: '2025-11 to 2026-02', hours: 2880 },
    ),
    'CF 17% · 5.0 GWh Nov 2025 to Feb 2026',
  );

  assert.deepEqual(plantCardRows(record, { cfMeta: meta }).slice(2, 5), [
    ['Tech', 'Natural Gas Fired Combustion Turbine'],
    ['CF', '6% · Jan to Jun 2026'],
    ['Generation', '38 GWh'],
  ]);
  assert.deepEqual(
    plantCardRows(record).map(([label]) => label),
    ['Capacity', 'Fuel', 'Tech', 'State', 'Utility', 'EIA id'],
  );
  assert.equal(plantCardCopy(record, { cfMeta: meta }).details.length, 2);
  const drawn = { ...record, id: 'plant:2161', position: { x: 1, y: 2, z: 3 } };
  assert.equal(createPlantOverlayEntry(drawn).details.length, 1);
  assert.equal(createPlantOverlayEntry(drawn).rows, undefined);
  assert.equal(createPlantDetailEntry(drawn, { cfMeta: meta }).rows.length, 8);
});

test('legend counts sites per fuel in the Yes Energy order with a glyph each', () => {
  const legend = plantLegend([
    { fuel: 'solar' },
    { fuel: 'wind' },
    { fuel: 'solar' },
    { fuel: 'mystery' },
  ]);
  assert.deepEqual(
    legend.map((l) => [l.label, l.count]),
    [
      ['wind', 1],
      ['solar', 2],
      ['other', 1],
    ],
  );
  assert.equal(legend[1].color, POWER_PLANT_FUEL_COLORS.solar);
  const all = plantLegend(
    Object.keys(POWER_PLANT_FUEL_COLORS).map((fuel) => ({ fuel })),
  );
  assert.deepEqual(
    all.map((l) => l.label),
    [
      'coal',
      'nuclear',
      'gas',
      'hydro',
      'wind',
      'solar',
      'oil',
      'storage',
      'biomass',
      'geothermal',
      'other',
    ],
  );
  for (const item of all) {
    assert.match(item.icon, /^M[\d.\s\-a-zA-Z,]+z$/, item.label);
  }
  assert.equal(all[2].blurb.startsWith('natural gas · '), true);
});

test('reactor sidecar and NYISO node join land live data on the right plants', () => {
  const reactorText = readFileSync(
    new URL(
      './local_data/eia_power_plants/reactor_units.json',
      import.meta.url,
    ),
    'utf8',
  );
  const units = parseReactorUnits(reactorText);
  assert.ok(units.size >= 50);
  assert.deepEqual(units.get('6110'), [{ unit: 'FitzPatrick', ba: 'NYIS' }]);
  assert.equal(units.get('2589').length, 2);
  assert.equal(parseReactorUnits('nope').size, 0);

  const nodes = parseNyisoNodes(
    readFileSync(
      new URL('./local_data/iso_nodes/nyiso.geojsonl', import.meta.url),
      'utf8',
    ),
  );
  // Caithness sits 1.9 km from its NYISO node: the shared name carries it.
  const caithness = {
    name: 'Caithness Long Island Energy Center',
    ba: 'NYIS',
    lon: -72.9403,
    lat: 40.8142,
  };
  // Nine Mile Point and FitzPatrick share a site; names keep them apart.
  const fitz = {
    name: 'James A Fitzpatrick',
    ba: 'NYIS',
    lon: -76.40839,
    lat: 43.52139,
  };
  const nmp = {
    name: 'Nine Mile Point Nuclear Station',
    ba: 'NYIS',
    lon: -76.41,
    lat: 43.5211,
  };
  const twitty = {
    name: 'John Twitty Energy Center',
    ba: 'SWPP',
    lon: -93.38804,
    lat: 37.15171,
  };
  const far = { name: 'Nowhere', ba: 'NYIS', lon: -75.5, lat: 44.9 };
  assert.equal(joinNyisoNodes([caithness, fitz, nmp, twitty, far], nodes), 3);
  assert.deepEqual(caithness.nyisoPtids, ['323624']);
  assert.equal(caithness.zone, 'LONGIL');
  assert.equal(nodes.get(fitz.nyisoPtids[0]).name, 'FITZPATRICK____');
  assert.deepEqual(nmp.nyisoPtids.map((id) => nodes.get(id).name).sort(), [
    'NINE_MILE_1',
    'NINE_MILE_2',
  ]);
  assert.equal(nmp.zone, 'CENTRL');
  assert.equal(twitty.nyisoPtids, undefined);
  assert.equal(far.nyisoPtids, undefined);
});

test('live rows: NRC output for nuclear, nodal price for NY, fleet for NYISO and SPP', () => {
  const live = {
    nyiso: {
      fuelMix: {
        interval: '09/14/2026 11:25:00',
        mw: { dual: 3545, gas: 3084, nuclear: 2427 },
      },
    },
    spp: {
      fuelMix: { interval: '2026-09-14T16:05:00Z', mw: { coal: 7728.3 } },
    },
    reactors: {
      reportDate: '2026-09-14',
      units: {
        FitzPatrick: 0,
        'Nine Mile Point 1': 100,
        'Nine Mile Point 2': 100,
      },
    },
    lmp: {
      interval: '09/14/2026 14:00:00',
      byPtid: new Map([
        ['323624', { ptid: '323624', lmp: 45.11, mcc: 0 }],
        ['323625', { ptid: '323625', lmp: 47.5, mcc: -12.4 }],
      ]),
    },
    reactorUnits: new Map([
      ['6110', [{ unit: 'FitzPatrick', ba: 'NYIS' }]],
      [
        '2589',
        [
          { unit: 'Nine Mile Point 1', ba: 'NYIS' },
          { unit: 'Nine Mile Point 2', ba: 'NYIS' },
        ],
      ],
    ]),
    nameplate: new Map([
      ['NYIS|gas', 9000],
      ['NYIS|oil', 2400],
      ['NYIS|nuclear', 3330],
      ['SWPP|coal', 12000],
    ]),
  };
  const fitz = {
    name: 'James A Fitzpatrick',
    plant_code: 6110,
    fuel: 'nuclear',
    prim_source: 'nuclear',
    total_mw: 852.8,
    ba: 'NYIS',
    zone: 'CENTRL',
    state: 'New York',
  };
  assert.deepEqual(reactorOutput(fitz, live), {
    pct: 0,
    units: [{ label: 'FitzPatrick', pct: 0 }],
    date: '14 Sep',
  });
  assert.deepEqual(plantLiveRows(fitz, live), [
    ['Output', '0% · NRC 14 Sep'],
    ['Fleet', '73% · NYISO nuclear 2.4 GW of 3.3 GW · 11:25 ET'],
  ]);
  const nmp = {
    plant_code: 2589,
    fuel: 'nuclear',
    total_mw: 1896.1,
    ba: 'NYIS',
  };
  assert.equal(
    plantLiveRows(nmp, live)[0][1],
    '100% · U1 100% · U2 100% · NRC 14 Sep',
  );
  // The ambient summary carries the NRC figure; the table stands in Zone for State.
  assert.equal(
    plantCardCopy(fitz, { live }).details[0],
    'nuclear · 853 MW · 0%',
  );
  assert.deepEqual(
    plantCardRows(fitz, { live }).map(([label]) => label),
    ['Capacity', 'Output', 'Fleet', 'Fuel', 'Zone', 'EIA id'],
  );

  const caithness = {
    plant_code: 56234,
    fuel: 'gas',
    prim_source: 'natural gas',
    total_mw: 317.3,
    ba: 'NYIS',
    zone: 'LONGIL',
    nyisoPtids: ['323624', '323625'],
    state: 'New York',
    utility: 'Caithness Long Island, LLC',
  };
  assert.deepEqual(plantLiveRows(caithness, live), [
    ['RT LBMP', '$47.50 · 14:00 ET'],
    ['Congestion', '-$12.40/MWh'],
    ['Fleet', '58% · NYISO gas+dual 6.6 GW of 11.4 GW · 11:25 ET'],
  ]);
  assert.deepEqual(
    plantCardRows(caithness, { live }).map(([label]) => label),
    [
      'Capacity',
      'RT LBMP',
      'Congestion',
      'Fleet',
      'Fuel',
      'Zone',
      'Utility',
      'EIA id',
    ],
  );

  const twitty = {
    plant_code: 6195,
    fuel: 'coal',
    prim_source: 'coal',
    total_mw: 563,
    ba: 'SWPP',
    state: 'Missouri',
  };
  assert.deepEqual(plantLiveRows(twitty, live), [
    ['Fleet', '64% · SPP coal 7.7 GW of 12.0 GW · 16:05Z'],
  ]);
  assert.deepEqual(
    plantCardRows(twitty, { live }).find(([l]) => l === 'BA'),
    ['BA', 'SWPP'],
  );
  // Without live data, or outside NYISO and SPP, the table is the static one.
  assert.deepEqual(plantLiveRows(twitty, null), []);
  assert.deepEqual(plantLiveRows({ fuel: 'coal', ba: 'MISO' }, live), []);
  assert.deepEqual(
    plantCardRows({ ...twitty, ba: '' }).map(([label]) => label),
    ['Capacity', 'Fuel', 'State', 'EIA id'],
  );
});
