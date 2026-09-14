import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createPlantDetailEntry,
  createPlantOverlayEntry,
  isPlantPickId,
  parsePlantRecords,
  plantCardCopy,
  plantLegend,
  powerPlantStyle,
  POWER_PLANT_FUEL_COLORS,
} from './powerPlants.js';

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
  });
  assert.deepEqual(powerPlantStyle({ fuel: 'solar', total_mw: 5 }), {
    color: POWER_PLANT_FUEL_COLORS.solar,
    pixelSize: 6,
  });
  assert.equal(
    powerPlantStyle({ fuel: 'unlisted' }).color,
    POWER_PLANT_FUEL_COLORS.other,
  );
  assert.equal(powerPlantStyle(null).pixelSize, 6);
  assert.equal(powerPlantStyle({ fuel: 'gas', total_mw: 100 }).pixelSize, 10);
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

test('card copy: ambient card keeps the summary, hover card adds tech and EIA id', () => {
  assert.deepEqual(plantCardCopy(JAMES_RIVER), {
    title: 'James River Power Station',
    details: [
      'natural gas · 155 MW · City Utilities of Springfield - (MO)',
      'Natural Gas Fired Combustion Turbine · EIA 2161',
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
  assert.equal(pinned.details.length, 2);
});

test('legend counts sites per fuel in display order', () => {
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
});
