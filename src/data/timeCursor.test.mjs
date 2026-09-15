import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HOUR_MS,
  CURSOR_PAST_HOURS,
  CURSOR_FUTURE_HOURS,
  clampCursor,
  createTimeCursor,
  decodeCursorParam,
  encodeCursorParam,
  formatCursorEt,
  snapToHour,
} from './timeCursor.js';

const NOW = Date.UTC(2026, 8, 15, 20, 47, 13); // 2026-09-15 20:47:13Z

test('snapToHour floors to the hour and rejects junk', () => {
  assert.equal(snapToHour(NOW), Date.UTC(2026, 8, 15, 20));
  assert.equal(snapToHour('x'), null);
  assert.equal(snapToHour(NaN), null);
});

test('clampCursor keeps the window at -7d..+2d and passes null through', () => {
  const now = snapToHour(NOW);
  assert.equal(clampCursor(null, NOW), null);
  assert.equal(clampCursor(NOW, NOW), now);
  assert.equal(
    clampCursor(NOW - 30 * 24 * HOUR_MS, NOW),
    now - CURSOR_PAST_HOURS * HOUR_MS,
  );
  assert.equal(
    clampCursor(NOW + 30 * 24 * HOUR_MS, NOW),
    now + CURSOR_FUTURE_HOURS * HOUR_MS,
  );
});

test('hash param round-trips as epoch hours; malformed reads as LIVE', () => {
  const ms = Date.UTC(2026, 8, 14, 15);
  const raw = encodeCursorParam(ms);
  assert.equal(raw, String(ms / HOUR_MS));
  assert.equal(decodeCursorParam(raw, NOW), ms);
  assert.equal(encodeCursorParam(null), null);
  assert.equal(decodeCursorParam(null, NOW), null);
  assert.equal(decodeCursorParam('abc', NOW), null);
  assert.equal(decodeCursorParam('-5', NOW), null);
  assert.equal(decodeCursorParam('', NOW), null);
});

test('formatCursorEt renders Eastern wall clock', () => {
  // 2026-09-14 19:00Z is 15:00 EDT.
  assert.equal(formatCursorEt(Date.UTC(2026, 8, 14, 19)), 'Sep 14 15:00 ET');
  assert.equal(formatCursorEt(null), 'LIVE');
});

test('store snaps, clamps, steps, notifies and reference-counts availability', () => {
  let clock = NOW;
  const cursor = createTimeCursor({ now: () => clock });
  const seen = [];
  const off = cursor.subscribe((v) => seen.push(v));

  assert.equal(cursor.isLive(), true);
  assert.equal(cursor.set(NOW - 90 * 60 * 1000), true);
  assert.equal(cursor.get(), snapToHour(NOW) - HOUR_MS); // 19:00Z
  assert.equal(cursor.set(NOW - 90 * 60 * 1000), false); // no move, no notify
  assert.equal(cursor.step(2), true);
  assert.equal(cursor.get(), snapToHour(NOW) + HOUR_MS);
  assert.equal(cursor.live(), true);
  assert.equal(cursor.get(), null);
  // Stepping from LIVE starts at the current hour.
  cursor.step(-1);
  assert.equal(cursor.get(), snapToHour(NOW) - HOUR_MS);
  assert.deepEqual(seen, [
    snapToHour(NOW) - HOUR_MS,
    snapToHour(NOW) + HOUR_MS,
    null,
    snapToHour(NOW) - HOUR_MS,
  ]);

  seen.length = 0;
  assert.equal(cursor.isAvailable(), false);
  cursor.setAvailable(true);
  cursor.setAvailable(true);
  cursor.setAvailable(false);
  assert.equal(cursor.isAvailable(), true);
  cursor.setAvailable(false);
  assert.equal(cursor.isAvailable(), false);
  // Only the two transitions notified.
  assert.equal(seen.length, 2);

  off();
  cursor.set(null);
  assert.equal(seen.length, 2);
  clock += HOUR_MS;
  assert.equal(cursor.range().now, snapToHour(clock));
});
