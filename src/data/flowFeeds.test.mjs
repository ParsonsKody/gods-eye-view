import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FLOW_BAND_COLORS,
  flowBand,
  flowCardCopy,
  flowLabel,
  flowLegend,
  flowUtilization,
  parseNyisoInterfaceFlows,
} from './flowFeeds.js';
import { NYISO_INTERFACES, nyisoInterface } from './nyisoInterfaces.js';
import { buildFlowRecords, flowScale } from './interfaceFlows.js';

const SAMPLE = [
  'Timestamp,Interface Name,Point ID,Flow (MWH),Positive Limit (MWH),Negative Limit (MWH)',
  '09/14/2026 10:25,SCH - PJ - NY,23316,1500,1950,-1050',
  '09/14/2026 10:30,CENTRAL EAST - VC,23330,883.9,2495,-9999',
  '09/14/2026 10:30,SCH - HQ - NY,23324,-940,940,-940',
  '09/14/2026 10:30,SCH - HQ_IMPORT_EXPORT,325376,-940,1310,-9999',
  '09/14/2026 10:30,SCH - PJ - NY,23316,1586.1,1950,-1050',
  '09/14/2026 10:30,WEST CENTRAL,23312,161.3,9999,-9999',
  '',
].join('\r\n');

test('parser keeps the latest interval and nulls the 9999 sentinels', () => {
  const { interval, flows } = parseNyisoInterfaceFlows(SAMPLE);
  assert.equal(interval, '09/14/2026 10:30');
  assert.equal(flows.length, 5);
  const pj = flows.find((f) => f.name === 'SCH - PJ - NY');
  assert.deepEqual(pj, {
    name: 'SCH - PJ - NY',
    ptid: '23316',
    flowMw: 1586.1,
    posLimitMw: 1950,
    negLimitMw: -1050,
  });
  const central = flows.find((f) => f.name === 'CENTRAL EAST - VC');
  assert.equal(central.negLimitMw, null);
  const west = flows.find((f) => f.name === 'WEST CENTRAL');
  assert.equal(west.posLimitMw, null);
  assert.deepEqual(parseNyisoInterfaceFlows(''), { interval: null, flows: [] });
  assert.deepEqual(parseNyisoInterfaceFlows('a,b\n1,2'), {
    interval: null,
    flows: [],
  });
});

test('utilization follows the direction of flow and its own limit', () => {
  assert.equal(
    Math.round(
      flowUtilization({ flowMw: 1586.1, posLimitMw: 1950, negLimitMw: -1050 }) *
        100,
    ),
    81,
  );
  assert.equal(
    flowUtilization({ flowMw: -940, posLimitMw: 940, negLimitMw: -940 }),
    1,
  );
  assert.equal(
    flowUtilization({ flowMw: 161, posLimitMw: null, negLimitMw: null }),
    null,
  );
  assert.equal(
    flowUtilization({ flowMw: -100, posLimitMw: 500, negLimitMw: null }),
    null,
  );
  assert.equal(flowBand(0.2), 'low');
  assert.equal(flowBand(0.6), 'mid');
  assert.equal(flowBand(0.95), 'high');
  assert.equal(flowBand(null), 'none');
  assert.equal(flowScale(1), 1.5);
  assert.equal(flowScale(0), 0.75);
});

test('every feed interface except the HQ aggregate has a map row', () => {
  const { flows } = parseNyisoInterfaceFlows(SAMPLE);
  const records = buildFlowRecords({
    iso: 'nyiso',
    interval: '09/14/2026 10:30',
    fetchedAt: 1,
    flows,
  });
  assert.deepEqual(
    records.map((r) => r.id).sort(),
    [
      'flow:nyiso:CENTRAL EAST - VC',
      'flow:nyiso:SCH - HQ - NY',
      'flow:nyiso:SCH - PJ - NY',
      'flow:nyiso:WEST CENTRAL',
    ],
  );
  assert.equal(nyisoInterface('SCH - HQ_IMPORT_EXPORT'), null);
  for (const row of NYISO_INTERFACES) {
    assert.ok(row.bearingDeg >= 0 && row.bearingDeg < 360, row.name);
    assert.ok(row.lat > 40 && row.lat < 45.5 && row.lon > -80 && row.lon < -71.5, row.name);
    assert.ok(row.label && row.forward && row.reverse);
  }
  assert.equal(new Set(NYISO_INTERFACES.map((r) => r.name)).size, 18);
});

test('card copy reads the flow, its share of the limit and the interval', () => {
  const record = {
    ...nyisoInterface('SCH - PJ - NY'),
    flowMw: 1586.1,
    posLimitMw: 1950,
    negLimitMw: -1050,
    interval: '09/14/2026 10:30',
    fetchedAt: 1000,
  };
  assert.deepEqual(flowCardCopy(record, { nowMs: 1000 + 3 * 60000 }), {
    title: 'PJM to NY',
    details: [
      '1,586 MW into NY · 81% of 1,950 MW',
      'Limits +1,950 MW / -1,050 MW',
      '10:30 ET interval · updated 3m ago',
    ],
  });
  assert.equal(flowLabel(record), 'PJM to NY · 81%');
  const exporting = flowCardCopy({
    ...nyisoInterface('SCH - HQ - NY'),
    flowMw: -940,
    posLimitMw: 940,
    negLimitMw: -940,
  });
  assert.equal(exporting.details[0], '940 MW out to Quebec · 100% of 940 MW');
  const open = flowCardCopy({
    ...nyisoInterface('WEST CENTRAL'),
    flowMw: 161.3,
    posLimitMw: null,
    negLimitMw: null,
  });
  assert.deepEqual(open.details, ['161 MW eastbound · no limit posted this way']);
  assert.equal(flowLabel({ label: 'West Central', flowMw: 161.3 }), 'West Central · 161 MW');
});

test('legend counts interfaces per band', () => {
  const legend = flowLegend([
    { flowMw: 100, posLimitMw: 1000 },
    { flowMw: 950, posLimitMw: 1000 },
    { flowMw: 5, posLimitMw: null },
  ]);
  assert.deepEqual(
    legend.map((l) => [l.label, l.count]),
    [
      ['90% of limit and over', 1],
      ['60 to 90% of limit', 0],
      ['under 60% of limit', 1],
      ['no limit posted', 1],
    ],
  );
  assert.equal(legend[0].color, FLOW_BAND_COLORS.high);
});
