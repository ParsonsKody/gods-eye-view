import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchOutagesToLines,
  nearbyOutages,
  nuclearNearby,
  outageCopy,
  outageName,
  sinceText,
} from './outageLines.js';

const part = (id, sub_1, sub_2, kv, positions) => ({
  positions,
  record: { id: `line:${id}`, sub_1, sub_2, kv },
});

// Niagara area lines plus one far away.
const PARTS = [
  part(1, 'NIAGARA', 'BECK', 230, [
    [-79.03, 43.14],
    [-79.06, 43.15],
  ]),
  part(2, 'NIAGARA', 'PACKARD', 230, [
    [-79.03, 43.14],
    [-78.9, 43.0],
  ]),
  part(3, 'NIAGARA', 'ROCHESTER', 345, [
    [-79.03, 43.14],
    [-77.6, 43.15],
  ]),
  part(4, 'FARRAGUT', 'GOWANUS', 345, [
    [-73.97, 40.7],
    [-74.0, 40.67],
  ]),
];
const PARTS_BY_ID = new Map(PARTS.map((p) => [p.record.id, [p.positions]]));

const outage = (from, to, kv, circuit, since = '09/14/2026 08:49:00') => ({
  kind: 'line',
  from,
  to,
  kv,
  circuit,
  since,
  name: `${from}-${to}`,
});

test('an outage lands on the line whose ends and kV agree, in either order', () => {
  const outages = [
    outage('BECK', 'NIAGARA', 230, 'PA27'),
    outage('NIAGARA', 'PACKARD', 230, '1'),
    outage('NIAGARA', 'PACKARD', 115, '2'), // wrong kV
    outage('HUDSONP', 'FARRAGUT', 345, 'B3402'), // no such line
    { kind: 'equipment', from: 'EDIC', to: null, kv: 345, circuit: 'CAP 1' },
  ];
  const { byRecord, matched, total } = matchOutagesToLines(outages, PARTS);
  assert.equal(total, 4, 'station equipment is not a line outage');
  assert.equal(matched, 2);
  assert.deepEqual(
    byRecord.get(PARTS[0].record).map((o) => o.circuit),
    ['PA27'],
  );
  assert.deepEqual(
    byRecord.get(PARTS[1].record).map((o) => o.circuit),
    ['1'],
  );
  assert.equal(byRecord.has(PARTS[3].record), false);
  assert.deepEqual(matchOutagesToLines([], PARTS), {
    byRecord: new Map(),
    matched: 0,
    total: 0,
  });
});

test('outage copy names the circuit and the start of the outage', () => {
  const o = outage('BECK', 'NIAGARA', 230, 'PA27');
  assert.equal(outageName(o), 'BECK-NIAGARA 230 PA27');
  assert.equal(sinceText('09/14/2026 08:49:00'), '14 Sep 08:49 ET');
  assert.equal(
    outageCopy(o),
    'Outage: BECK-NIAGARA 230 PA27 · since 14 Sep 08:49 ET',
  );
});

test('a constrained line sees outages on lines that share an end or pass within 30 km', () => {
  const { byRecord } = matchOutagesToLines(
    [
      outage('BECK', 'NIAGARA', 230, 'PA27'),
      outage('FARRAGUT', 'GOWANUS', 345, 'G780'),
    ],
    PARTS,
  );
  // Niagara to Packard shares the Niagara end with the outaged Beck line.
  const near = nearbyOutages(
    PARTS[1].record,
    [PARTS[1].positions],
    byRecord,
    PARTS_BY_ID,
  );
  assert.deepEqual(
    near.map((o) => [o.circuit, o.distanceKm]),
    [['PA27', 0]],
  );
  // A line's own outage is not its neighbour.
  assert.deepEqual(
    nearbyOutages(PARTS[0].record, [PARTS[0].positions], byRecord, PARTS_BY_ID),
    [],
  );
  // Distance alone: a line 3 km from the Beck outage that shares no name.
  const nearby = { id: 'line:5', sub_1: 'LEWISTON', sub_2: 'MOSES', kv: 230 };
  const far = nearbyOutages(
    nearby,
    [
      [
        [-79.02, 43.17],
        [-79.0, 43.2],
      ],
    ],
    byRecord,
    PARTS_BY_ID,
  );
  assert.equal(far.length, 1);
  assert.ok(
    far[0].distanceKm > 1 && far[0].distanceKm < 5,
    `distance ${far[0].distanceKm}`,
  );
});

test('derated reactors within 80 km of a line are listed nearest first', () => {
  const units = [
    { unit: 'FitzPatrick', lon: -76.408, lat: 43.521 },
    { unit: 'Nine Mile Point 1', lon: -76.41, lat: 43.521 },
    { unit: 'Ginna', lon: -77.31, lat: 43.278 },
  ];
  const status = {
    reportDate: '2026-09-14',
    units: { FitzPatrick: 0, 'Nine Mile Point 1': 100, Ginna: 55 },
  };
  // A line ending at Rochester, 60 km from Ginna, 120 km from Oswego.
  const found = nuclearNearby(
    [
      [
        [-77.6, 43.15],
        [-77.9, 43.1],
      ],
    ],
    units,
    status,
  );
  assert.deepEqual(
    found.map((u) => u.unit),
    ['Ginna'],
  );
  const wide = nuclearNearby(
    [
      [
        [-77.6, 43.15],
        [-77.9, 43.1],
      ],
    ],
    units,
    status,
    { km: 200 },
  );
  assert.deepEqual(
    wide.map((u) => [u.unit, u.pct]),
    [
      ['Ginna', 55],
      ['FitzPatrick', 0],
    ],
  );
  assert.deepEqual(nuclearNearby([[[-77.6, 43.15]]], units, null), []);
});
