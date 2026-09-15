import {
  CURSOR_FUTURE_HOURS,
  CURSOR_PAST_HOURS,
  HOUR_MS,
  formatCursorEt,
  timeCursor as defaultCursor,
} from '../data/timeCursor.js';

/**
 * The time bar: LIVE, one hour back, a slider over the cursor window, one
 * hour forward, and the Eastern stamp. Mounted once by the application
 * shell; it shows itself while any layer has told the cursor it can honour
 * an hour (`timeCursor.setAvailable`). Keyboard: the slider is a native
 * range input, so arrow keys step it.
 *
 * @param {{host?: HTMLElement, cursor?: object}} [options]
 * @returns {{element: HTMLElement, destroy: () => void}}
 */
export function mountTimeCursorBar({
  host = document.body,
  cursor = defaultCursor,
} = {}) {
  const steps = CURSOR_PAST_HOURS + CURSOR_FUTURE_HOURS;
  const el = document.createElement('div');
  el.id = 'time-cursor-bar';
  el.hidden = true;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', 'Time cursor');
  el.innerHTML = `
    <button type="button" class="tc-live" data-tc="live" title="Back to live data">LIVE</button>
    <button type="button" class="tc-step" data-tc="back" aria-label="One hour back" title="One hour back">&lsaquo;</button>
    <input type="range" class="tc-range" data-tc="range" min="0" max="${steps}" step="1" value="${CURSOR_PAST_HOURS}" aria-label="Hour" />
    <button type="button" class="tc-step" data-tc="fwd" aria-label="One hour forward" title="One hour forward">&rsaquo;</button>
    <span class="tc-stamp" data-tc="stamp" aria-live="polite">LIVE</span>
  `;
  const range = el.querySelector('[data-tc="range"]');
  const stamp = el.querySelector('[data-tc="stamp"]');
  const live = el.querySelector('[data-tc="live"]');

  function sync() {
    el.hidden = !cursor.isAvailable();
    const value = cursor.get();
    const { min } = cursor.range();
    const isLive = value === null;
    range.value = String(
      isLive ? CURSOR_PAST_HOURS : Math.round((value - min) / HOUR_MS),
    );
    stamp.textContent = formatCursorEt(value);
    el.classList.toggle('is-live', isLive);
    live.setAttribute('aria-pressed', isLive ? 'true' : 'false');
    range.setAttribute('aria-valuetext', formatCursorEt(value));
  }

  const onInput = () => {
    const { min } = cursor.range();
    cursor.set(min + Number(range.value) * HOUR_MS);
  };
  const onClick = (event) => {
    const button = event.target?.closest?.('[data-tc]');
    if (!button) return;
    const action = button.dataset.tc;
    if (action === 'live') cursor.live();
    else if (action === 'back') cursor.step(-1);
    else if (action === 'fwd') cursor.step(1);
  };
  range.addEventListener('input', onInput);
  el.addEventListener('click', onClick);
  const unsubscribe = cursor.subscribe(sync);
  host.appendChild(el);
  sync();

  return {
    element: el,
    destroy() {
      unsubscribe();
      range.removeEventListener('input', onInput);
      el.removeEventListener('click', onClick);
      el.remove();
    },
  };
}
