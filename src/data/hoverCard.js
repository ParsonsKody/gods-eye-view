import * as Cesium from 'cesium';
import {
  clearOverlaySource,
  setOverlayEntries,
  setOverlaySourceVisible,
} from '../overlays/worldOverlay.js';
import {
  bindTrackingClickGesture,
  isTrackingClickGesture,
} from './trackingClickGesture.js';
import { registerPickOwner, unregisterPickOwner } from './pickRegistry.js';

/**
 * Hover-and-pin detail card shared by the picked-primitive layers (ISO
 * congestion, power plants, transmission lines).
 *
 * The CCTV hover pattern: a leading-edge throttled scene.pick on MOUSE_MOVE,
 * nothing while the camera flies, a short linger before an unhovered card
 * is released, and a clean click that pins the card (a second click on it,
 * or a click on empty space, unpins). One overlay source per controller
 * holds at most one entry, published in the protected `selected` lane when
 * pinned and the `ambient-card` lane while hovered.
 */

/** Leading-edge throttle for hover picks while the pointer moves. */
export const HOVER_PICK_THROTTLE_MS = 120;
/** Linger before an unhovered card is released. */
export const HOVER_RELEASE_MS = 1000;

export const DEFAULT_OVERLAY_HOST = Object.freeze({
  setEntries: setOverlayEntries,
  setVisible: setOverlaySourceVisible,
  clearSource: clearOverlaySource,
});

/**
 * Build the overlay entry every hover card shares; callers supply copy,
 * accent and position.
 * @param {object} input
 * @param {string} input.id Record id.
 * @param {Cesium.Cartesian3} input.position World anchor.
 * @param {string} input.title
 * @param {string[]} input.details
 * @param {Array<[string, string]>} [input.rows] Label and value table
 *   drawn under the details.
 * @param {string} input.accent CSS colour.
 * @param {boolean} [input.pinned]
 * @returns {object}
 */
export function createHoverCardEntry({
  id,
  position,
  title,
  details,
  rows = [],
  accent,
  pinned = false,
}) {
  return {
    id: String(id),
    position,
    variant: pinned ? 'selected' : 'card',
    selected: pinned,
    protected: true,
    paintLane: pinned ? 'selected' : 'ambient-card',
    collisionGroup: 'ambient-card',
    priority: Number.MAX_SAFE_INTEGER,
    zIndex: 40,
    title,
    details,
    rows,
    accent,
    interactive: false,
    verticalOnly: true,
    placement: 'above',
    edgeFade: 'keyhole',
    horizonCull: true,
    terrainOcclusion: false,
  };
}

/**
 * @param {object} options
 * @param {string} options.ownerId Pick-registry owner id (the layer id).
 * @param {string} options.sourceId Overlay source that holds the card.
 * @param {(id:string)=>boolean} options.isPickId Pick ids this layer owns.
 * @param {(picked:object|null, windowPosition:object)=>object|null} options.resolve
 *   Maps a scene.pick() result to a record with a string `id`, or null.
 * @param {(record:object, options:{pinned:boolean})=>object} options.entryFor
 *   Overlay entry for a record (see createHoverCardEntry).
 * @param {(record:object|null)=>void} [options.onChange] Called after every
 *   publish with the record now carrying the card (pinned over hovered), so
 *   a layer can drop its own ambient label for that record.
 * @param {object} [options.overlayHost]
 * @param {number} [options.pickThrottleMs]
 * @param {number} [options.releaseMs]
 * @param {(canvas:object)=>object} [options.handlerFactory] Test seam.
 * @returns {{install:function, remove:function, setEnabled:function, sync:function, hovered:function, pinned:function}}
 */
export function createHoverCardController({
  ownerId,
  sourceId,
  isPickId,
  resolve,
  entryFor,
  onChange = null,
  overlayHost = DEFAULT_OVERLAY_HOST,
  pickThrottleMs = HOVER_PICK_THROTTLE_MS,
  releaseMs = HOVER_RELEASE_MS,
  handlerFactory = (canvas) => new Cesium.ScreenSpaceEventHandler(canvas),
}) {
  let _viewer = null;
  let _handler = null;
  let _enabled = false;
  let _hover = null;
  let _pinned = null;
  let _lastPickAt = 0;
  let _releaseTimer = 0;
  let _cameraMoving = false;
  let _removeMoveStart = null;
  let _removeMoveEnd = null;

  function setCursor(pointer) {
    const canvas = _viewer?.scene?.canvas;
    if (canvas?.style) canvas.style.cursor = pointer ? 'pointer' : '';
  }

  function publish() {
    const record = _pinned || _hover;
    if (!_enabled || !record) {
      overlayHost.clearSource(sourceId);
      onChange?.(null);
      return;
    }
    overlayHost.setEntries(
      sourceId,
      [entryFor(record, { pinned: record === _pinned })],
      { cohortLimit: 1, collisionCapacity: 1, moving: false },
    );
    onChange?.(record);
  }

  function cancelRelease() {
    if (_releaseTimer) {
      clearTimeout(_releaseTimer);
      _releaseTimer = 0;
    }
  }

  function scheduleRelease() {
    if (_releaseTimer) return;
    _releaseTimer = setTimeout(() => {
      _releaseTimer = 0;
      _hover = null;
      publish();
    }, releaseMs);
  }

  function clearHover() {
    cancelRelease();
    _hover = null;
    _lastPickAt = 0;
    setCursor(false);
  }

  function pick(position) {
    if (!position) return null;
    try {
      return resolve(_viewer.scene.pick(position), position);
    } catch {
      return null;
    }
  }

  function onMouseMove(position) {
    if (!_enabled || _cameraMoving || !position) return;
    if (!_viewer || _viewer.isDestroyed()) return;
    const now = Date.now();
    if (now - _lastPickAt < pickThrottleMs) return;
    _lastPickAt = now;
    const record = pick(position);
    setCursor(Boolean(record));
    if (record) {
      cancelRelease();
      if (record.id !== _hover?.id) {
        _hover = record;
        publish();
      }
    } else if (_hover) {
      scheduleRelease();
    }
  }

  function onClick(click, gesture) {
    if (!_enabled || !_viewer || _viewer.isDestroyed()) return;
    if (!isTrackingClickGesture(gesture)) return;
    const record = pick(click?.position);
    if (record) {
      _pinned = _pinned?.id === record.id ? null : record;
    } else if (_pinned) {
      _pinned = null;
    } else {
      return;
    }
    publish();
  }

  return {
    install(viewer) {
      if (_handler || !viewer?.scene?.canvas) return;
      _viewer = viewer;
      _handler = handlerFactory(viewer.scene.canvas);
      bindTrackingClickGesture(_handler, onClick, {
        onMouseMove: (event) => onMouseMove(event?.endPosition),
      });
      _removeMoveStart = viewer.camera.moveStart.addEventListener(() => {
        _cameraMoving = true;
      });
      _removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
        _cameraMoving = false;
      });
      registerPickOwner(ownerId, isPickId);
      overlayHost.setVisible(sourceId, _enabled);
    },

    remove() {
      this.setEnabled(false);
      unregisterPickOwner(ownerId);
      if (_removeMoveStart) _removeMoveStart();
      if (_removeMoveEnd) _removeMoveEnd();
      _removeMoveStart = null;
      _removeMoveEnd = null;
      if (_handler && !_handler.isDestroyed?.()) _handler.destroy?.();
      _handler = null;
      _viewer = null;
    },

    /** Show or hide the card source; hiding also drops hover and pin. */
    setEnabled(enabled) {
      _enabled = Boolean(enabled);
      if (!_enabled) {
        clearHover();
        _pinned = null;
        overlayHost.clearSource(sourceId);
      }
      overlayHost.setVisible(sourceId, _enabled);
    },

    /**
     * Re-resolve the hovered and pinned records after the layer's data
     * changed: `lookup(id)` returns the fresh record or null to drop it.
     */
    sync(lookup) {
      if (_hover) _hover = lookup(_hover.id) || null;
      if (_pinned) _pinned = lookup(_pinned.id) || null;
      publish();
    },

    hovered: () => _hover,
    pinned: () => _pinned,
  };
}
