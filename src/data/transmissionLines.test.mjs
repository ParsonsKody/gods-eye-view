import test from 'node:test';
import * as Cesium from 'cesium';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createTransmissionLinesLayer,
  constraintCopy,
  constraintColor,
  constraintLegend,
  createLineDetailEntry,
  lineCardCopy,
  lineParts,
  lineBoundingSphere,
  lineStyleForFeature,
  isLinePickId,
  outageLegend,
  OUTAGE_COLOR,
  LINE_STYLE_BY_KV,
  DC_LINE_COLOR,
} from './transmissionLines.js';

test('line style picks the voltage band and lets DC override the colour', () => {
  assert.deepEqual(lineStyleForFeature({ kv: 765, type: 'AC; OVERHEAD' }), {
    color: LINE_STYLE_BY_KV[0][1],
    width: LINE_STYLE_BY_KV[0][2],
  });
  assert.deepEqual(lineStyleForFeature({ kv: 345 }), {
    color: LINE_STYLE_BY_KV[2][1],
    width: LINE_STYLE_BY_KV[2][2],
  });
  assert.equal(lineStyleForFeature({ kv: 115 }).width, 1.6);
  assert.equal(
    lineStyleForFeature({ kv: 500, type: 'DC; OVERHEAD' }).color,
    DC_LINE_COLOR,
  );
  assert.equal(lineStyleForFeature(null).width, 1.6);
});

test('layer module exposes the data-layer contract without loading', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('factory must not fetch');
  });
  const layer = createTransmissionLinesLayer({ mapStackEventTarget: null });
  assert.equal(layer.id, 'eia-transmission-lines');
  assert.equal(layer.updateInterval, 300000);
  assert.deepEqual(layer.getRowControls().legend[0].count, 0);
  for (const fn of [
    'init',
    'enable',
    'disable',
    'update',
    'destroy',
    'getStats',
  ])
    assert.equal(typeof layer[fn], 'function', fn);
  assert.deepEqual(layer.getStats(), {
    count: 0,
    lastUpdate: null,
    error: null,
  });
  layer.destroy();
});

test('bundled line files keep their feature counts', () => {
  for (const [file, count] of [
    ['lines_backbone', 3467],
    ['lines_regional', 19846],
  ]) {
    const json = JSON.parse(
      readFileSync(
        new URL(
          `./local_data/eia_transmission_lines/${file}.geojson`,
          import.meta.url,
        ),
        'utf8',
      ),
    );
    assert.equal(json.features.length, count);
  }
});

test('lineParts flattens multi-part lines and styles each part', () => {
  const { features, parts } = lineParts({
    features: [
      {
        geometry: {
          type: 'LineString',
          coordinates: [
            [-97, 38],
            [-96, 38],
          ],
        },
        properties: { kv: 345 },
        id: 'A1',
      },
      {
        geometry: {
          type: 'MultiLineString',
          coordinates: [
            [
              [-75, 42],
              [-74, 42],
            ],
            [[-74, 42]],
            [
              [-73, 42],
              [-72, 43],
            ],
          ],
        },
        properties: { kv: 500, type: 'DC; OVERHEAD' },
      },
      { geometry: { type: 'Point', coordinates: [0, 0] }, properties: {} },
    ],
  });
  assert.equal(features, 2);
  assert.equal(parts.length, 3);
  assert.equal(parts[0].color, LINE_STYLE_BY_KV[2][1]);
  assert.equal(parts[1].color, DC_LINE_COLOR);
  assert.equal(parts[2].width, LINE_STYLE_BY_KV[1][2]);
  assert.equal(parts[0].record.id, 'line:A1');
  assert.equal(parts[1].record, parts[2].record, 'parts share the record');
  assert.equal(parts[1].record.id, 'line:2');
  assert.ok(isLinePickId(parts[1].record.id));
  assert.equal(isLinePickId('plant:1'), false);
  assert.deepEqual(lineParts(null), { features: 0, parts: [] });
});

test('line card copy names the ends, owner and status, dropping unknowns', () => {
  assert.deepEqual(
    lineCardCopy({
      kv: 1000,
      volt_class: 'DC',
      owner: 'BONNEVILLE POWER ADMINISTRATION',
      status: 'IN SERVICE',
      type: 'DC; OVERHEAD',
      sub_1: 'CELILO',
      sub_2: 'SYLMAR EAST',
    }),
    {
      title: '1000 kV · Celilo to Sylmar East',
      details: [
        'Bonneville Power Administration',
        'DC · Overhead · In service',
      ],
    },
  );
  assert.deepEqual(
    lineCardCopy({
      kv: 345,
      owner: 'NOT AVAILABLE',
      status: 'NOT AVAILABLE',
      type: 'AC; OVERHEAD',
      sub_1: 'NOT AVAILABLE',
      sub_2: 'WOLF CREEK',
    }),
    { title: '345 kV · Wolf Creek', details: ['AC · Overhead'] },
  );
  assert.equal(lineCardCopy({}).title, '0 kV line');
});

test('a line carrying a binding constraint says so on the card, in the congestion colour', () => {
  const spp = {
    iso: 'spp',
    name: 'VINHAYKNOXFR',
    monitored: 'LN VINETAP3 - NHAYS',
    shadowPrice: -1486.87,
    state: 'BREACHED',
  };
  assert.equal(
    constraintCopy(spp),
    'Binding: VINHAYKNOXFR (LN VINETAP3 - NHAYS) · $1,487/MWh · Breached',
  );
  assert.equal(
    constraintCopy({
      iso: 'nyiso',
      name: 'FARRAGUT 138 PLYMTHST 138 1',
      shadowPrice: -12.4,
    }),
    'Limiting: FARRAGUT 138 PLYMTHST 138 1 · $12/MWh',
  );
  const record = {
    id: 'line:1',
    kv: 115,
    sub_1: 'VINE TAP',
    sub_2: 'NORTH HAYS',
    constraint: spp,
    position: { x: 1, y: 2, z: 3 },
  };
  const { details } = lineCardCopy(record);
  assert.equal(details.at(-1), constraintCopy(spp));
  assert.equal(constraintColor(spp), '#ff1744');
  assert.notEqual(constraintColor({ shadowPrice: -20 }), '#ff1744');
  assert.equal(createLineDetailEntry(record).accent, '#ff1744');
  assert.equal(
    createLineDetailEntry({ ...record, constraint: null }).accent,
    '#9e9e9e',
  );
  assert.equal(constraintLegend({ matched: 3, total: 80 })[0].count, 3);
  assert.match(constraintLegend({ matched: 3, total: 80 })[0].blurb, /3 of 80/);
});

test('a line under a NYISO outage lists each circuit; a constrained line reads its neighbourhood', () => {
  const outage = {
    ptid: '25025',
    name: 'BECK____-NIAGARA__230_PA27',
    kind: 'line',
    from: 'BECK',
    to: 'NIAGARA',
    kv: 230,
    circuit: 'PA27',
    since: '09/14/2026 08:49:00',
  };
  const record = {
    id: 'line:9',
    kv: 230,
    sub_1: 'BECK',
    sub_2: 'NIAGARA',
    outages: [outage],
    position: { x: 1, y: 2, z: 3 },
  };
  const { details } = lineCardCopy(record);
  assert.equal(
    details.at(-1),
    'Outage: BECK-NIAGARA 230 PA27 · since 14 Sep 08:49 ET',
  );
  assert.equal(createLineDetailEntry(record).accent, OUTAGE_COLOR);
  const constrained = {
    ...record,
    outages: undefined,
    constraint: {
      iso: 'nyiso',
      name: 'NIAGARA 230 PACKARD 230 1',
      shadowPrice: -40,
    },
    nearbyOutages: [{ ...outage, distanceKm: 0 }],
    nuclearNearby: {
      date: '14 Sep',
      units: [{ unit: 'FitzPatrick', pct: 0, distanceKm: 12 }],
    },
  };
  const copy = lineCardCopy(constrained);
  assert.deepEqual(copy.details.slice(-2), [
    'Outages nearby: 1 · BECK-NIAGARA 230 PA27 (since 14 Sep 08:49 ET)',
    'Nuclear nearby: FitzPatrick 0% (NRC 14 Sep)',
  ]);
  assert.deepEqual(outageLegend({ matched: 0, total: 0 }), []);
  assert.equal(outageLegend({ matched: 12, total: 80 })[0].count, 12);
  assert.match(outageLegend({ matched: 12, total: 80 })[0].blurb, /12 of 80/);
});

test('a line frames as one sphere over every part, centred on the surface', () => {
  const sphere = lineBoundingSphere([
    [
      [-79.03, 43.14],
      [-78.9, 43.1],
    ],
    [
      [-78.9, 43.1],
      [-78.7, 43.0],
    ],
  ]);
  assert.ok(
    sphere.radius > 12000 && sphere.radius < 16000,
    `radius ${sphere.radius}`,
  );
  const height = Cesium.Cartographic.fromCartesian(sphere.center).height;
  assert.ok(Math.abs(height) < 1, `centre height ${height}`);
  assert.equal(lineBoundingSphere([[[-79, 43]]]), null);
});
