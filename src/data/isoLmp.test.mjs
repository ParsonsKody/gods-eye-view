import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCursorRecords,
  buildLmpRecords,
  colorValue,
  createLmpDetailEntry,
  cursorNodeLabel,
  isLmpPickId,
  nyisoDayStampFor,
  parseNyisoNodes,
  recordColor,
} from './isoLmp.js';
import { parsePrivateSeries } from './privateData.js';
import { MCC_NEUTRAL_COLOR } from './lmpFeeds.js';

const NODES = parseNyisoNodes(
  '{"type":"Feature","geometry":{"type":"Point","coordinates":[-76.4,43.5]},"properties":{"id":"1001","name":"NINE MILE 1","zone":"CENTRL"}}\n',
);

test('records carry ISO, interval and fetch time; stale bubbles up', () => {
  const { points, constraints, intervals, stale } = buildLmpRecords(
    [
      {
        iso: 'nyiso',
        interval: '09/14/2026 11:30:00',
        fetchedAt: 5,
        stale: true,
        nodes: [
          {
            id: 'nyiso:1001',
            ptid: '1001',
            kind: 'gen',
            lmp: 48,
            mcc: 5,
            mlc: 3,
            mec: 40,
          },
          { id: 'nyiso:9', ptid: '9', kind: 'gen', lmp: 1, mcc: 0, mlc: 0 },
        ],
        constraints: [],
      },
      {
        iso: 'spp',
        interval: '2026-09-14T13:10:00.000Z',
        fetchedAt: 6,
        stale: false,
        nodes: [],
        constraints: [
          {
            id: 'spp:binding:X',
            name: 'X',
            kind: 'binding',
            lat: 38,
            lon: -99,
            shadowPrice: 12,
          },
          {
            id: 'spp:binding:NOGEO',
            name: 'NOGEO',
            kind: 'binding',
            shadowPrice: 1,
          },
        ],
      },
    ],
    NODES,
  );
  assert.equal(points.length, 1);
  assert.equal(points[0].name, 'NINE MILE 1');
  assert.equal(points[0].iso, 'nyiso');
  assert.equal(points[0].interval, '09/14/2026 11:30:00');
  assert.equal(points[0].fetchedAt, 5);
  assert.equal(constraints.length, 1);
  assert.equal(constraints[0].fetchedAt, 6);
  assert.deepEqual(intervals, {
    nyiso: '09/14/2026 11:30:00',
    spp: '2026-09-14T13:10:00.000Z',
  });
  assert.equal(stale, true);
});

test('detail entry is a card when hovered and a protected selection when pinned', () => {
  const record = {
    id: 'nyiso:1001',
    iso: 'nyiso',
    kind: 'gen',
    name: 'NINE MILE 1',
    lmp: 48,
    mcc: 5,
    mlc: 3,
    mec: 40,
    position: { x: 1, y: 2, z: 3 },
  };
  const hover = createLmpDetailEntry(record, { nowMs: 0 });
  assert.equal(hover.variant, 'card');
  assert.equal(hover.protected, true);
  assert.equal(hover.title, 'NYISO gen · NINE MILE 1');
  assert.equal(hover.details[0], 'LMP $48.00/MWh');
  const pinned = createLmpDetailEntry(record, { pinned: true, nowMs: 0 });
  assert.equal(pinned.variant, 'selected');
  assert.equal(pinned.paintLane, 'selected');
  assert.equal(pinned.priority, Number.MAX_SAFE_INTEGER);
});

test('pick ownership covers both ISO id prefixes only', () => {
  assert.equal(isLmpPickId('spp:SPPNORTH_HUB'), true);
  assert.equal(isLmpPickId('nyiso:1001'), true);
  assert.equal(isLmpPickId('flights:abc'), false);
  assert.equal(isLmpPickId(42), false);
});

test('buildCursorRecords paints the day-ahead column and merges private rows', () => {
  const hour = Date.UTC(2026, 8, 14, 19);
  const day = {
    fetchedAt: 7,
    hours: [hour - 3_600_000, hour],
    nodes: [
      { id: 'nyiso:1001', ptid: '1001', name: 'x', lmp: [30, 44], mcc: [0, 6], mlc: [1, 2], mec: [29, 36] },
      { id: 'nyiso:9', ptid: '9', name: 'unmapped', lmp: [1, 1], mcc: [0, 0], mlc: [0, 0], mec: [1, 1] },
    ],
  };
  const privateData = parsePrivateSeries({
    version: 1,
    iso: 'spp',
    source: 'unit test',
    hours: [new Date(hour - 3_600_000).toISOString(), new Date(hour).toISOString()],
    nodes: {
      'spp:HUB': { name: 'Hub', lat: 41.2, lon: -96.9, kind: 'hub' },
      'nyiso:1001': { name: 'nine mile', lat: 43.5, lon: -76.4 },
      'spp:EMPTY': { name: 'nothing here', lat: 40, lon: -95 },
    },
    series: {
      da_forecast: { 'spp:HUB': [40, 50], 'nyiso:1001': [41, 47] },
      da_actual: { 'spp:HUB': [38, 46], 'nyiso:1001': [30, 44] },
      da_actual_mcc: { 'spp:HUB': [2, 5] },
    },
  });
  const { points } = buildCursorRecords({
    hourMs: hour,
    nowMs: hour + 3_600_000,
    day,
    nyisoNodes: NODES,
    privateData,
    privateSource: 'private',
  });
  assert.deepEqual(
    points.map((p) => p.id),
    ['nyiso:1001', 'spp:HUB'],
  );
  const ny = points[0];
  assert.equal(ny.source, 'da');
  assert.equal(ny.name, 'NINE MILE 1');
  assert.equal(ny.lmp, 44);
  assert.equal(ny.mcc, 6);
  assert.equal(ny.forecast, 47);
  assert.equal(ny.error, 3);
  assert.equal(ny.mae, 7); // |41-30| and |47-44| over two hours
  assert.equal(ny.hourMs, hour);
  const hub = points[1];
  assert.equal(hub.source, 'private');
  assert.equal(hub.lmp, 46); // past hour: DA actual wins
  assert.equal(hub.mcc, 5);
  assert.equal(hub.error, 4);
  assert.equal(hub.seriesSource, 'unit test');
  assert.equal(hub.demo, false);

  // Future hour: the forecast is the price, no error yet.
  const future = buildCursorRecords({
    hourMs: hour,
    nowMs: hour - 3_600_000,
    day: null,
    nyisoNodes: NODES,
    privateData,
  }).points;
  const hubFuture = future.find((p) => p.id === 'spp:HUB');
  assert.equal(hubFuture.lmp, 50);
  assert.equal(hubFuture.mcc, null);
  assert.equal(hubFuture.error, 4); // an actual exists in this test data
  assert.equal(future.find((p) => p.id === 'nyiso:1001').source, 'private');
});

test('cursor labels and colour follow the colour mode', () => {
  const record = { lmp: 44.4, mcc: 6, error: -3.2 };
  assert.equal(cursorNodeLabel(record, 'congestion'), '$44 (+6)');
  assert.equal(cursorNodeLabel(record, 'error'), '-$3');
  assert.equal(cursorNodeLabel({ lmp: 44.4, mcc: null }, 'congestion'), '$44');
  assert.equal(cursorNodeLabel({ lmp: 44.4 }, 'error'), '$44');
  assert.equal(colorValue(record, 'error'), -3.2);
  assert.equal(colorValue({ lmp: 1 }, 'error'), null);
  assert.equal(recordColor({ error: null }, 'error'), MCC_NEUTRAL_COLOR);
  assert.notEqual(recordColor({ error: 5 }, 'error'), MCC_NEUTRAL_COLOR);
});

test('nyisoDayStampFor uses the Eastern calendar day', () => {
  assert.equal(nyisoDayStampFor(Date.UTC(2026, 8, 15, 3, 30)), '20260914');
  assert.equal(nyisoDayStampFor(Date.UTC(2026, 8, 15, 4, 0)), '20260915');
});
