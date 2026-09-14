import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  createTransmissionLinesLayer,
  lineParts,
  lineStyleForFeature,
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
  assert.equal(lineStyleForFeature({ kv: 115 }).width, 1);
  assert.equal(
    lineStyleForFeature({ kv: 500, type: 'DC; OVERHEAD' }).color,
    DC_LINE_COLOR,
  );
  assert.equal(lineStyleForFeature(null).width, 1);
});

test('layer module exposes the data-layer contract without loading', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('factory must not fetch');
  });
  const layer = createTransmissionLinesLayer({ mapStackEventTarget: null });
  assert.equal(layer.id, 'eia-transmission-lines');
  assert.equal(layer.updateInterval, 0);
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
  assert.deepEqual(lineParts(null), { features: 0, parts: [] });
});
