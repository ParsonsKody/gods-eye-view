import test from 'node:test';
import assert from 'node:assert/strict';
import {
  distanceToPartKm,
  facilityEnds,
  matchConstraintsToLines,
  namesMatch,
} from './constraintLines.js';

const part = (id, sub_1, sub_2, kv, positions) => ({
  positions,
  record: { id: `line:${id}`, sub_1, sub_2, kv },
});

// Four lines meeting at a Hays, KS substation (38.88, -99.32), one far away.
const PARTS = [
  part(1, 'NORTH HAYS', 'VINE TAP', 115, [[-99.32, 38.88], [-99.1, 38.95]]),
  part(2, 'NORTH HAYS', 'UNKNOWN1', 115, [[-99.32, 38.88], [-99.5, 38.7]]),
  part(3, 'HAYS', 'POST ROCK', 230, [[-99.321, 38.881], [-98.9, 39.1]]),
  part(4, 'FARRAGUT', 'PLYMOUTH STREET', 138, [[-73.97, 40.7], [-73.98, 40.71]]),
  part(5, 'FARRAGUT', 'GOWANUS', 345, [[-73.97, 40.7], [-74.0, 40.67]]),
  part(6, 'FAR AWAY', 'NOWHERE', 345, [[-100.5, 40.0], [-100.4, 40.1]]),
];

test('name match: normalised equality or a 4+ character prefix', () => {
  assert.equal(namesMatch('NORTH HAYS', 'north_hays'), true);
  assert.equal(namesMatch('VINETAP3', 'VINE TAP'), true);
  assert.equal(namesMatch('NHAYS', 'NORTH HAYS'), false);
  assert.equal(namesMatch('VINE', 'VINE TAP'), true);
  assert.equal(namesMatch('N', 'NORTH HAYS'), false);
  assert.equal(namesMatch('', 'X'), false);
});

test('facility strings parse to end names and kV per ISO', () => {
  assert.deepEqual(facilityEnds({ iso: 'spp', monitored: 'LN VINETAP3 - NHAYS' }), {
    ends: ['VINETAP3', 'NHAYS'],
    kv: null,
    element: 'LN',
  });
  assert.deepEqual(facilityEnds({ iso: 'spp', monitored: 'XFMR BROOK_LN - BROOK_LN' }), {
    ends: [],
    kv: null,
    element: 'XFMR',
  });
  assert.deepEqual(facilityEnds({ iso: 'spp', monitored: 'Multi-Element Constraint' }), {
    ends: [],
    kv: null,
    element: null,
  });
  assert.deepEqual(
    facilityEnds({ iso: 'nyiso', name: 'FARRAGUT 138 PLYMTHST 138 1' }),
    { ends: ['FARRAGUT', 'PLYMTHST'], kv: 138, element: 'LN' },
  );
});

test('distance to a polyline in km', () => {
  const d = distanceToPartKm(-99.32, 38.9, [[-99.32, 38.88], [-99.1, 38.95]]);
  assert.ok(d > 1.5 && d < 2.5, String(d));
  assert.equal(distanceToPartKm(-99.32, 38.88, [[-99.32, 38.88], [-99.1, 38.95]]), 0);
});

test('an SPP constraint marks the lines at its substation, narrowed by a matching end name', () => {
  const cluster = {
    iso: 'spp',
    name: 'BRKXF2',
    monitored: 'XFMR HAYS - HAYS',
    shadowPrice: -500,
    lat: 38.88,
    lon: -99.32,
  };
  const { byRecord, matched, total } = matchConstraintsToLines([cluster], PARTS);
  assert.equal(matched, 1);
  assert.equal(total, 1);
  assert.deepEqual(
    [...byRecord.keys()].map((r) => r.id).sort(),
    ['line:1', 'line:2', 'line:3'],
  );
  const named = {
    ...cluster,
    name: 'VINHAYKNOXFR',
    monitored: 'LN VINETAP3 - NHAYS',
    shadowPrice: -1486,
  };
  const narrowed = matchConstraintsToLines([named], PARTS).byRecord;
  assert.deepEqual([...narrowed.keys()].map((r) => r.id), ['line:1']);
  // Both constraints touch line 1: the larger |shadow price| wins there.
  const both = matchConstraintsToLines([cluster, named], PARTS).byRecord;
  assert.equal(both.get(PARTS[0].record).name, 'VINHAYKNOXFR');
  assert.equal(both.get(PARTS[1].record).name, 'BRKXF2');
  assert.equal(both.get(PARTS[2].record).name, 'BRKXF2');
});

test('a NYISO constraint with no point matches by end name and kV only', () => {
  const nyiso = {
    iso: 'nyiso',
    name: 'FARRAGUT 138 PLYMTHST 138 1',
    monitored: 'FARRAGUT 138 PLYMTHST 138 1',
    shadowPrice: -12,
  };
  const { byRecord, matched } = matchConstraintsToLines([nyiso], PARTS);
  assert.equal(matched, 1);
  assert.deepEqual([...byRecord.keys()].map((r) => r.id), ['line:4']);
  const miss = matchConstraintsToLines(
    [{ iso: 'nyiso', name: 'MEYER    230 MEYER      1 1', shadowPrice: -1 }],
    PARTS,
  );
  assert.equal(miss.matched, 0);
  assert.equal(matchConstraintsToLines([], PARTS).total, 0);
  assert.equal(matchConstraintsToLines([nyiso], []).matched, 0);
});
