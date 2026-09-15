/**
 * Global hour cursor for the energy layers.
 *
 * `null` means LIVE: every layer paints the newest interval it has, as it
 * always did. A number is an epoch millisecond snapped to the top of an
 * hour; layers that know how to look back (ISO day-ahead archives) or
 * forward (a forecast series from the private data seam) paint that hour
 * instead. The window is fixed at seven days back and two days ahead of
 * the wall clock so the slider stays readable.
 *
 * Layers publish `setAvailable(true)` while they can honour a cursor; the
 * time bar shows only while at least one layer has done so. Nothing here
 * touches Cesium or the DOM.
 */

export const HOUR_MS = 3_600_000;
export const CURSOR_PAST_HOURS = 7 * 24;
export const CURSOR_FUTURE_HOURS = 2 * 24;
/** Share-link hash parameter: epoch hours as an integer. */
export const CURSOR_HASH_PARAM = 't';

/** Floor a millisecond timestamp to the top of its hour. */
export function snapToHour(ms) {
  if (ms === null || ms === undefined) return null;
  const v = Number(ms);
  if (!Number.isFinite(v)) return null;
  return Math.floor(v / HOUR_MS) * HOUR_MS;
}

/**
 * The slider window around `nowMs`.
 * @param {number} nowMs
 * @returns {{min:number, max:number, now:number}}
 */
export function cursorRange(nowMs) {
  const now = snapToHour(nowMs);
  return {
    min: now - CURSOR_PAST_HOURS * HOUR_MS,
    max: now + CURSOR_FUTURE_HOURS * HOUR_MS,
    now,
  };
}

/** Snap and clamp a requested cursor into the window; null stays null. */
export function clampCursor(ms, nowMs) {
  if (ms === null || ms === undefined) return null;
  const snapped = snapToHour(ms);
  if (snapped === null) return null;
  const { min, max } = cursorRange(nowMs);
  return Math.min(max, Math.max(min, snapped));
}

/** Hash value for a cursor: epoch hours, or null for LIVE. */
export function encodeCursorParam(ms) {
  const snapped = snapToHour(ms);
  return snapped === null ? null : String(snapped / HOUR_MS);
}

/** Cursor from a hash value; anything malformed reads as LIVE. */
export function decodeCursorParam(raw, nowMs = Date.now()) {
  if (typeof raw !== 'string' || !/^\d{1,8}$/.test(raw)) return null;
  return clampCursor(Number(raw) * HOUR_MS, nowMs);
}

/**
 * Cursor stamp as Eastern wall clock, the ISO convention the LMP layer
 * already uses: `Sep 14 15:00 ET`.
 */
export function formatCursorEt(ms) {
  const snapped = snapToHour(ms);
  if (snapped === null) return 'LIVE';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(snapped));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('month')} ${get('day')} ${hour}:${get('minute')} ET`;
}

/**
 * @param {{now?: () => number}} [options] Clock seam for tests.
 */
export function createTimeCursor({ now = () => Date.now() } = {}) {
  /** @type {number|null} */
  let hourMs = null;
  let available = 0;
  const listeners = new Set();

  function notify() {
    for (const fn of listeners) {
      try {
        fn(hourMs);
      } catch (err) {
        console.warn('[timeCursor] listener failed:', err?.message || err);
      }
    }
  }

  const cursor = {
    get() {
      return hourMs;
    },
    isLive() {
      return hourMs === null;
    },
    /** Returns true when the cursor actually moved. */
    set(ms) {
      const next = clampCursor(ms, now());
      if (next === hourMs) return false;
      hourMs = next;
      notify();
      return true;
    },
    live() {
      return cursor.set(null);
    },
    /** Move by whole hours from the cursor, or from the current hour when live. */
    step(hours) {
      const base = hourMs ?? snapToHour(now());
      return cursor.set(base + Math.trunc(Number(hours) || 0) * HOUR_MS);
    },
    range() {
      return cursorRange(now());
    },
    /** Reference-counted: each layer that can honour the cursor holds one. */
    setAvailable(on) {
      const before = available > 0;
      available = Math.max(0, available + (on ? 1 : -1));
      if (before !== available > 0) notify();
    },
    isAvailable() {
      return available > 0;
    },
    subscribe(fn) {
      if (typeof fn !== 'function') return () => {};
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
  return cursor;
}

/** The one cursor the app shares. */
export const timeCursor = createTimeCursor();
