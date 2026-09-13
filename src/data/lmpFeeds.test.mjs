import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseNyisoRealtimeTail,
  normalizeSppFeatures,
  mccColor,
  mccPixelSize,
  nodeLabel,
  MCC_NEUTRAL_COLOR,
  MCC_POSITIVE_COLOR,
  MCC_NEGATIVE_COLOR,
} from './lmpFeeds.js';

const NYISO_TAIL = [
  '55,0.66,0.00',
  '"09/13/2026 15:55:00","ALPHA_GEN",1001,40.10,1.00,-2.50',
  '"09/13/2026 15:55:00","BETA_GEN",1002,41.00,1.10,0.00',
  '"09/13/2026 16:00:00","ALPHA_GEN",1001,42.00,1.20,3.75',
  '"09/13/2026 16:00:00","BETA, THE",1002,39.50,0.90,-1.25',
  '',
].join('\n');

test('NYISO tail parser returns the last complete interval only', () => {
  const parsed = parseNyisoRealtimeTail(NYISO_TAIL);
  assert.equal(parsed.interval, '09/13/2026 16:00:00');
  assert.deepEqual(parsed.rows, [
    { id: '1001', name: 'ALPHA_GEN', lmp: 42, mlc: 1.2, mcc: 3.75 },
    { id: '1002', name: 'BETA, THE', lmp: 39.5, mlc: 0.9, mcc: -1.25 },
  ]);
});

test('NYISO tail parser refuses a window that may start inside the last interval', () => {
  const single = [
    'partial',
    '"09/13/2026 16:00:00","ALPHA_GEN",1001,42.00,1.20,3.75',
  ].join('\n');
  assert.equal(parseNyisoRealtimeTail(single), null);
  assert.equal(parseNyisoRealtimeTail(''), null);
  const full = [
    '"Time Stamp","Name","PTID","LBMP ($/MWHr)","Marginal Cost Losses ($/MWHr)","Marginal Cost Congestion ($/MWHr)"',
    '"09/13/2026 16:00:00","ALPHA_GEN",1001,42.00,1.20,3.75',
  ].join('\n');
  assert.equal(
    parseNyisoRealtimeTail(full, { partialHead: false }).rows.length,
    1,
  );
});

test('SPP normalizer splits priced nodes from constraints and keeps the interval', () => {
  const byLayer = {
    2: {
      features: [
        {
          attributes: {
            SETTLEMENT_LOCATION: 'SPPNORTH_HUB',
            PNODE: 'SPPNORTH_H',
            LMP: 16.02,
            MLC: 0.01,
            MCC: -6.52,
            MEC: 22.53,
            GMTINTERVALEND: 1789321500000,
          },
          geometry: { x: -96.99, y: 41.2 },
        },
      ],
    },
    5: {
      features: [
        {
          attributes: {
            CONSTRAINT_NAME: 'VINHAYKNOXFR',
            STATE: 'ACTIVATED',
            SHADOW_PRICE: 12.5,
            MONITORED_FACILITY: 'LN VINETAP3 - NHAYS',
            CONTINGENT_FACILITY: 'MIDW:KNOLL1',
            GMTINTERVALEND: 1789321200000,
          },
          geometry: { x: -99.3, y: 38.83 },
        },
        { attributes: { CONSTRAINT_NAME: 'NO_GEOMETRY' }, geometry: null },
      ],
    },
  };
  const out = normalizeSppFeatures(byLayer);
  assert.equal(out.interval, new Date(1789321500000).toISOString());
  assert.deepEqual(out.nodes, [
    {
      id: 'spp:SPPNORTH_HUB',
      name: 'SPPNORTH_HUB',
      kind: 'hub',
      lat: 41.2,
      lon: -96.99,
      lmp: 16.02,
      mcc: -6.52,
      mlc: 0.01,
      mec: 22.53,
    },
  ]);
  assert.equal(out.constraints.length, 1);
  assert.equal(out.constraints[0].kind, 'binding');
  assert.equal(out.constraints[0].shadowPrice, 12.5);
});

test('congestion colour diverges and saturates; size and label follow MCC', () => {
  assert.equal(mccColor(0), MCC_NEUTRAL_COLOR);
  assert.equal(mccColor(NaN), MCC_NEUTRAL_COLOR);
  assert.equal(mccColor(50), MCC_POSITIVE_COLOR);
  assert.equal(mccColor(-50), MCC_NEGATIVE_COLOR);
  assert.notEqual(mccColor(5), MCC_NEUTRAL_COLOR);
  assert.equal(mccPixelSize(0), 5);
  assert.equal(mccPixelSize(-40), 14);
  assert.equal(nodeLabel({ lmp: 42.4, mcc: 3.75 }), '$42 (+4)');
  assert.equal(nodeLabel({ lmp: 39.5, mcc: -1.25 }), '$40 (-1)');
});
