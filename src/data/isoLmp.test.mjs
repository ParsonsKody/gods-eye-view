import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLmpRecords,
  createLmpDetailEntry,
  isLmpPickId,
  parseNyisoNodes,
} from './isoLmp.js';

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
