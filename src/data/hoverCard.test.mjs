import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createHoverCardController,
  createHoverCardEntry,
  HOVER_RELEASE_MS,
} from './hoverCard.js';

function harness({ pickResult = () => null } = {}) {
  const calls = [];
  const actions = new Map();
  const overlayHost = {
    setEntries: (source, entries) => calls.push(['set', source, entries]),
    setVisible: (source, visible) => calls.push(['visible', source, visible]),
    clearSource: (source) => calls.push(['clear', source]),
  };
  const viewer = {
    isDestroyed: () => false,
    scene: { canvas: { style: {} }, pick: (pos) => pickResult(pos) },
    camera: { moveStart: new Cesium.Event(), moveEnd: new Cesium.Event() },
  };
  const controller = createHoverCardController({
    ownerId: 'test-layer',
    sourceId: 'test-cards',
    isPickId: (id) => id.startsWith('t:'),
    resolve: (picked) => (picked?.id?.id ? picked.id : null),
    entryFor: (record, { pinned }) =>
      createHoverCardEntry({
        id: record.id,
        position: record.position,
        title: record.title,
        details: [],
        accent: '#fff',
        pinned,
      }),
    overlayHost,
    handlerFactory: () => ({
      setInputAction: (fn, type) => actions.set(type, fn),
      destroy() {},
      isDestroyed: () => false,
    }),
  });
  const fire = (type, event) => actions.get(type)?.(event);
  const T = Cesium.ScreenSpaceEventType;
  return {
    controller,
    viewer,
    calls,
    move: (x, y) => fire(T.MOUSE_MOVE, { endPosition: { x, y } }),
    click: (x, y) => {
      fire(T.LEFT_DOWN, { position: { x, y } });
      fire(T.LEFT_UP, { position: { x, y } });
      fire(T.LEFT_CLICK, { position: { x, y } });
    },
    last: () => calls[calls.length - 1],
  };
}

const RECORD = { id: 't:1', title: 'One', position: { x: 1, y: 2, z: 3 } };

test('hover publishes a card, unhover releases it after the linger', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  t.after(() => t.mock.timers.reset());
  let picked = { id: RECORD };
  const h = harness({ pickResult: () => picked });
  h.controller.install(h.viewer);
  h.controller.setEnabled(true);
  h.move(10, 10);
  assert.equal(h.last()[0], 'set');
  assert.equal(h.last()[2][0].variant, 'card');
  assert.equal(h.viewer.scene.canvas.style.cursor, 'pointer');
  picked = null;
  t.mock.timers.tick(200);
  h.move(20, 20);
  assert.equal(h.viewer.scene.canvas.style.cursor, '');
  assert.equal(h.last()[0], 'set', 'card lingers');
  t.mock.timers.tick(HOVER_RELEASE_MS);
  assert.deepEqual(h.last(), ['clear', 'test-cards']);
  assert.equal(h.controller.hovered(), null);
});

test('a clean click pins the card as selected; empty space unpins', () => {
  let picked = { id: RECORD };
  const h = harness({ pickResult: () => picked });
  h.controller.install(h.viewer);
  h.controller.setEnabled(true);
  h.click(5, 5);
  assert.equal(h.last()[2][0].variant, 'selected');
  assert.equal(h.last()[2][0].paintLane, 'selected');
  assert.equal(h.controller.pinned(), RECORD);
  picked = null;
  h.click(50, 50);
  assert.deepEqual(h.last(), ['clear', 'test-cards']);
  assert.equal(h.controller.pinned(), null);
});

test('sync re-resolves records and drops vanished ones; disable clears', () => {
  const h = harness({ pickResult: () => ({ id: RECORD }) });
  h.controller.install(h.viewer);
  h.controller.setEnabled(true);
  h.click(5, 5);
  const fresh = { ...RECORD, title: 'Fresh' };
  h.controller.sync(() => fresh);
  assert.equal(h.last()[2][0].title, 'Fresh');
  h.controller.sync(() => null);
  assert.deepEqual(h.last(), ['clear', 'test-cards']);
  h.controller.setEnabled(false);
  assert.deepEqual(h.last(), ['visible', 'test-cards', false]);
});
