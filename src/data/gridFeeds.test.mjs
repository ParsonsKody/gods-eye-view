import test from 'node:test';
import assert from 'node:assert/strict';
import {
  fleetNameplateByBaFuel,
  fleetRow,
  gridChips,
  gwText,
  parseNrcReactorStatus,
  parseNyisoEquipmentName,
  parseNyisoFuelMixTail,
  parseNyisoLineOutages,
  parseNyisoLoadTail,
  parseSppGenMix,
  shortDate,
  shortTime,
} from './gridFeeds.js';

const FUEL_MIX_TAIL = `1:15:00,EDT,Other Renewables,829.0
09/14/2026 11:15:00,EDT,Wind,520.0
09/14/2026 11:15:00,EDT,Hydro,2611.0
09/14/2026 11:20:00,EDT,Dual Fuel,3554.0
09/14/2026 11:20:00,EDT,Natural Gas,3056.0
09/14/2026 11:20:00,EDT,Nuclear,2427.0
09/14/2026 11:20:00,EDT,Other Fossil Fuels,0.0
09/14/2026 11:20:00,EDT,Other Renewables,820.0
09/14/2026 11:20:00,EDT,Wind,533.0
09/14/2026 11:20:00,EDT,Hydro,2622.0
09/14/2026 11:25:00,EDT,Dual Fuel,3545.0
09/14/2026 11:25:00,EDT,Natural Gas,3084.0
09/14/2026 11:25:00,EDT,Nuclear,2427.0
09/14/2026 11:25:00,EDT,Other Fossil Fuels,0.0
09/14/2026 11:25:00,EDT,Other Renewables,824.0
09/14/2026 11:25:00,EDT,Wind,537.0
09/14/2026 11:25:00,EDT,Hydro,2648.0
`;

const LOAD_TAIL = `ENTRL",61754,1044.3647
"09/14/2026 11:20:00","EDT","WEST",61752,1480.7129
"09/14/2026 11:25:00","EDT","CAPITL",61757,792.5861
"09/14/2026 11:25:00","EDT","LONGIL",61762,2275.9492
"09/14/2026 11:25:00","EDT","N.Y.C.",61761,6745.4697
`;

const OUTAGES = `Timestamp,PTID,Equipment Name,Outage Date/Time
09/14/2026 11:37:00,25013,E.SAYRE_-NWAVERLY_115_956,05/15/2026 10:00:00
09/14/2026 11:37:00,25025,BECK____-NIAGARA__230_PA27,09/14/2026 08:49:00
09/14/2026 11:37:00,25100,E13THSTA-EASTRIVR_69__44371L/M,01/15/2018 12:05:00
09/14/2026 11:37:00,25101,FRASERNY-SIDNEYRR 115_949,01/15/2018 12:05:00
09/14/2026 11:37:00,25200,E13THSTA_345_138_BK 14,03/01/2026 09:00:00
09/14/2026 11:37:00,25201,EDIC_____345KV_CAP_CAP_1,03/01/2026 09:00:00
`;

const SPP_MIX = `GMT MKT Interval,BAA,Coal,Diesel Fuel Oil,Hydro,Natural Gas,Nuclear,Solar,Waste Disposal Services,Wind,Waste Heat,Energy Storage,Other,Load
2026-09-14T15:55:00Z,SPP,7761.80,0.00,976.70,9519.40,1857.10,2256.10,11.50,20211.00,0.00,-18.10,65.70,41852.580
2026-09-14T16:05:00Z,SPP,7728.30,0.00,1034.70,9707.10,1858.20,2259.70,11.40,20549.70,0.00,-207.10,98.00,42262.870
`;

const NRC = `\uFEFFReportDt|Unit|Power
9/14/2026 12:00:00 AM|Arkansas Nuclear 1|100
9/14/2026 12:00:00 AM|FitzPatrick|0
9/14/2026 12:00:00 AM|Nine Mile Point 1|100
9/13/2026 12:00:00 AM|FitzPatrick|82
`;

test('NYISO fuel mix tail keeps the last complete interval, keyed by category', () => {
  const mix = parseNyisoFuelMixTail(FUEL_MIX_TAIL);
  assert.equal(mix.interval, '09/14/2026 11:25:00');
  assert.deepEqual(mix.mw, {
    dual: 3545,
    gas: 3084,
    nuclear: 2427,
    otherFossil: 0,
    otherRenewables: 824,
    wind: 537,
    hydro: 2648,
  });
  // A window with one interval only may have started inside it.
  const one = FUEL_MIX_TAIL.split('\n').slice(10).join('\n');
  assert.equal(parseNyisoFuelMixTail(one), null);
  assert.equal(
    parseNyisoFuelMixTail(one, { partialHead: false }).interval,
    '09/14/2026 11:25:00',
  );
});

test('NYISO load tail sums the zones of the last interval', () => {
  const load = parseNyisoLoadTail(LOAD_TAIL);
  assert.equal(load.interval, '09/14/2026 11:25:00');
  assert.deepEqual(load.byZone, {
    CAPITL: 792.6,
    LONGIL: 2275.9,
    'N.Y.C.': 6745.5,
  });
  assert.equal(load.total, 9814);
});

test('NYISO equipment names split into stations, kV and circuit', () => {
  assert.deepEqual(parseNyisoEquipmentName('BECK____-NIAGARA__230_PA27'), {
    kind: 'line',
    from: 'BECK',
    to: 'NIAGARA',
    kv: 230,
    circuit: 'PA27',
  });
  assert.deepEqual(parseNyisoEquipmentName('E13THSTA-EASTRIVR_69__44371L/M'), {
    kind: 'line',
    from: 'E13THSTA',
    to: 'EASTRIVR',
    kv: 69,
    circuit: '44371L/M',
  });
  assert.deepEqual(parseNyisoEquipmentName('FRASERNY-SIDNEYRR 115_949'), {
    kind: 'line',
    from: 'FRASERNY',
    to: 'SIDNEYRR',
    kv: 115,
    circuit: '949',
  });
  assert.deepEqual(parseNyisoEquipmentName('E13THSTA_345_138_BK 14'), {
    kind: 'equipment',
    from: 'E13THSTA',
    to: null,
    kv: 345,
    circuit: '138_BK 14',
  });
  assert.equal(
    parseNyisoEquipmentName('EDIC_____345KV_CAP_CAP_1').kind,
    'equipment',
  );
  const outages = parseNyisoLineOutages(OUTAGES);
  assert.equal(outages.length, 6);
  assert.equal(outages.filter((o) => o.kind === 'line').length, 4);
  assert.deepEqual(outages[1], {
    ptid: '25025',
    name: 'BECK____-NIAGARA__230_PA27',
    kind: 'line',
    from: 'BECK',
    to: 'NIAGARA',
    kv: 230,
    circuit: 'PA27',
    since: '09/14/2026 08:49:00',
  });
});

test('SPP gen mix takes the last row, folds waste heat into other, and keeps the load', () => {
  const mix = parseSppGenMix(SPP_MIX);
  assert.equal(mix.interval, '2026-09-14T16:05:00Z');
  assert.equal(mix.load, 42263);
  assert.deepEqual(mix.mw, {
    coal: 7728.3,
    oil: 0,
    hydro: 1034.7,
    gas: 9707.1,
    nuclear: 1858.2,
    solar: 2259.7,
    biomass: 11.4,
    wind: 20549.7,
    other: 98,
    storage: -207.1,
  });
  assert.equal(parseSppGenMix('header only'), null);
});

test('NRC status keeps the newest day per unit', () => {
  assert.deepEqual(parseNrcReactorStatus(NRC), {
    reportDate: '2026-09-14',
    units: {
      'Arkansas Nuclear 1': 100,
      FitzPatrick: 0,
      'Nine Mile Point 1': 100,
    },
  });
  assert.equal(parseNrcReactorStatus(''), null);
});

test('fleet row compares live ISO output with bundled nameplate of the same class', () => {
  const nameplate = fleetNameplateByBaFuel([
    { ba: 'NYIS', fuel: 'gas', total_mw: 9000 },
    { ba: 'NYIS', fuel: 'oil', total_mw: 2400 },
    { ba: 'NYIS', fuel: 'nuclear', total_mw: 3330 },
    { ba: 'SWPP', fuel: 'coal', total_mw: 12000 },
    { ba: 'SWPP', fuel: 'coal', total_mw: 0 },
    { fuel: 'coal', total_mw: 500 },
  ]);
  assert.equal(nameplate.get('NYIS|gas'), 9000);
  assert.equal(nameplate.get('SWPP|coal'), 12000);
  const ny = parseNyisoFuelMixTail(FUEL_MIX_TAIL);
  assert.equal(
    fleetRow({ ba: 'NYIS', fuel: 'gas' }, ny, nameplate),
    '58% · NYISO gas+dual 6.6 GW of 11.4 GW · 11:25 ET',
  );
  assert.equal(
    fleetRow({ ba: 'NYIS', fuel: 'nuclear' }, ny, nameplate),
    '73% · NYISO nuclear 2.4 GW of 3.3 GW · 11:25 ET',
  );
  const spp = parseSppGenMix(SPP_MIX);
  assert.equal(
    fleetRow({ ba: 'SWPP', fuel: 'coal' }, spp, nameplate),
    '64% · SPP coal 7.7 GW of 12.0 GW · 16:05Z',
  );
  // No category, no mix, or no nameplate: no row.
  assert.equal(
    fleetRow({ ba: 'SWPP', fuel: 'geothermal' }, spp, nameplate),
    null,
  );
  assert.equal(fleetRow({ ba: 'MISO', fuel: 'coal' }, spp, nameplate), null);
  assert.equal(fleetRow({ ba: 'NYIS', fuel: 'hydro' }, ny, nameplate), null);
  assert.equal(fleetRow({ ba: 'NYIS', fuel: 'gas' }, null, nameplate), null);
});

test('grid chips read load, wind, nuclear with derated units, outages and binding counts', () => {
  const chips = gridChips({
    nyiso: {
      load: parseNyisoLoadTail(LOAD_TAIL),
      fuelMix: parseNyisoFuelMixTail(FUEL_MIX_TAIL),
      lineOutages: parseNyisoLineOutages(OUTAGES),
    },
    spp: { load: 42263, fuelMix: parseSppGenMix(SPP_MIX) },
    reactors: parseNrcReactorStatus(NRC),
    reactorUnits: [
      { unit: 'FitzPatrick', plant_code: 6110, ba: 'NYIS' },
      { unit: 'Nine Mile Point 1', plant_code: 2589, ba: 'NYIS' },
      { unit: 'Wolf Creek 1', plant_code: 210, ba: 'SWPP' },
    ],
    binding: { nyiso: 3, spp: 12 },
  });
  assert.deepEqual(
    chips.map((c) => c.label),
    [
      'NY load 9.8 GW',
      'NY wind 0.5 GW',
      'NY nuclear 2.4 GW · FitzPatrick 0%',
      'NY line outages 4',
      'NY binding 3',
      'SPP load 42.3 GW',
      'SPP wind 20.5 GW',
      'SPP nuclear 1.9 GW',
      'SPP binding 12',
    ],
  );
  assert.ok(chips.every((c) => c.state === 'info' && c.id && c.title));
  assert.deepEqual(gridChips({ nyiso: null, spp: null, reactors: null }), []);
});

test('short copy helpers', () => {
  assert.equal(gwText(6629), '6.6 GW');
  assert.equal(gwText('x'), '');
  assert.equal(shortDate('2026-09-14'), '14 Sep');
  assert.equal(shortTime('09/14/2026 11:25:00'), '11:25 ET');
  assert.equal(shortTime('2026-09-14T16:20:00Z'), '16:20Z');
});
