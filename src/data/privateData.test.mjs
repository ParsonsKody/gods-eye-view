import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPrivateSeriesLoader,
  nodeSnapshot,
  parsePrivateSeries,
  rebaseSeriesToNow,
  resolvePrivateDataRequest,
  seriesValueAt,
  trailingMae,
} from './privateData.js';
import { HOUR_MS } from './timeCursor.js';

const H0 = Date.UTC(2026, 8, 14, 0);
const hours = Array.from({ length: 6 }, (_, i) => new Date(H0 + i * HOUR_MS).toISOString());

const DOC = {
  version: 1,
  generated: '2026-09-15T02:00:00Z',
  iso: 'spp',
  source: 'test',
  hours,
  nodes: {
    'spp:HUB': { name: 'Hub', lat: 41.2, lon: -96.99, kind: 'hub' },
    'spp:NOWHERE': { name: 'no coords' },
  },
  series: {
    da_forecast: { 'spp:HUB': [30, 32, 34, 36, 38, 40] },
    da_actual: { 'spp:HUB': [31, 30, null, 40, 'x', 43] },
    rt_actual: { 'spp:HUB': [29, 35] },
  },
};

test('route resolver whitelists names and needs the directory', () => {
  assert.deepEqual(resolvePrivateDataRequest({ dir: 'C:/x', urlPath: '/series.json' }), {
    status: 200,
    name: 'series',
  });
  assert.equal(resolvePrivateDataRequest({ dir: 'C:/x', urlPath: '/series.json?x=1' }).status, 200);
  assert.equal(resolvePrivateDataRequest({ dir: '', urlPath: '/series.json' }).status, 204);
  assert.equal(resolvePrivateDataRequest({ dir: null, urlPath: '/series.json' }).status, 204);
  assert.equal(resolvePrivateDataRequest({ dir: 'C:/x', urlPath: '/../.env' }).status, 404);
  assert.equal(resolvePrivateDataRequest({ dir: 'C:/x', urlPath: '/secrets.json' }).status, 404);
  assert.equal(resolvePrivateDataRequest({ dir: 'C:/x', urlPath: '/series' }).status, 404);
});

test('parser indexes hours, drops nodes without coordinates, pads rows', () => {
  const parsed = parsePrivateSeries(DOC);
  assert.equal(parsed.iso, 'spp');
  assert.equal(parsed.hours.length, 6);
  assert.equal(parsed.nodes.size, 1);
  assert.equal(parsed.nodes.get('spp:HUB').kind, 'hub');
  assert.deepEqual(parsed.series.rt_actual.get('spp:HUB'), [29, 35, null, null, null, null]);
  assert.deepEqual(parsed.series.da_actual.get('spp:HUB'), [31, 30, null, 40, null, 43]);
  assert.equal(seriesValueAt(parsed, 'da_forecast', 'spp:HUB', H0 + 2 * HOUR_MS + 1234), 34);
  assert.equal(seriesValueAt(parsed, 'da_forecast', 'spp:HUB', H0 - HOUR_MS), null);
  assert.equal(seriesValueAt(parsed, 'da_forecast', 'spp:OTHER', H0), null);
});

test('parser rejects the wrong version, bad stamps and unsorted hours', () => {
  assert.throws(() => parsePrivateSeries({ ...DOC, version: 2 }), /version 2/);
  assert.throws(() => parsePrivateSeries({ ...DOC, hours: ['nope'] }), /bad hour/);
  assert.throws(
    () => parsePrivateSeries({ ...DOC, hours: [hours[1], hours[0]] }),
    /ascending/,
  );
  assert.throws(() => parsePrivateSeries({ ...DOC, hours: [] }), /no hours/);
});

test('snapshot and trailing MAE skip hours missing either side', () => {
  const parsed = parsePrivateSeries(DOC);
  assert.deepEqual(nodeSnapshot(parsed, 'spp:HUB', H0 + 3 * HOUR_MS), {
    forecast: 36,
    daActual: 40,
    rtActual: null,
    forecastMcc: null,
    daActualMcc: null,
    error: -4,
  });
  assert.equal(nodeSnapshot(parsed, 'spp:HUB', H0 + 2 * HOUR_MS).error, null);
  // Hours 0..3 within the window ending at hour 3: errors 1, 2, (skip), 4.
  assert.deepEqual(trailingMae(parsed, 'spp:HUB', H0 + 3 * HOUR_MS, 24), {
    mae: 2.33,
    n: 3,
  });
  assert.deepEqual(trailingMae(parsed, 'spp:HUB', H0 + 3 * HOUR_MS, 1), { mae: 4, n: 1 });
  assert.deepEqual(trailingMae(parsed, 'spp:NONE', H0, 24), { mae: null, n: 0 });
});

test('rebase shifts every hour so the anchor lands on the current hour', () => {
  const now = Date.UTC(2026, 9, 1, 13, 25);
  const shifted = rebaseSeriesToNow({ ...DOC, demo_now_index: 2 }, now);
  assert.equal(shifted.hours[2], new Date(Date.UTC(2026, 9, 1, 13)).toISOString());
  assert.equal(shifted.hours[0], new Date(Date.UTC(2026, 9, 1, 11)).toISOString());
  assert.equal(DOC.hours[2], hours[2]); // input untouched
  assert.equal(rebaseSeriesToNow(DOC, now), DOC); // no anchor, no change
});

test('loader takes the private file, falls back to the fixture only on 404', async () => {
  const calls = [];
  const respond = (status, body) => ({
    ok: status === 200,
    status,
    json: async () => body,
  });
  const loader = createPrivateSeriesLoader({
    fixtureUrl: '/fixture.json',
    now: () => H0 + 5 * HOUR_MS,
    fetchImpl: async (url) => {
      calls.push(url);
      if (url === '/api/private/series.json') return respond(204, null);
      return respond(200, { ...DOC, demo_now_index: 1 });
    },
  });
  const out = await loader();
  assert.equal(out.source, 'fixture');
  assert.equal(out.data.demo, true);
  assert.equal(out.data.hours[1], H0 + 5 * HOUR_MS);
  assert.deepEqual(calls, ['/api/private/series.json', '/fixture.json']);

  const direct = createPrivateSeriesLoader({
    fixtureUrl: '/fixture.json',
    fetchImpl: async () => respond(200, DOC),
  });
  assert.equal((await direct()).source, 'private');

  const broken = createPrivateSeriesLoader({
    fixtureUrl: '/fixture.json',
    fetchImpl: async () => respond(500, null),
  });
  await assert.rejects(broken(), /HTTP 500/);
});
