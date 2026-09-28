//! FILENAME: app/extensions/FloatingRange/lib/frMove.ts
// PURPOSE: How a POINTER move of a floating range reaches the document: Core's
//          `floatingObject:movePreview` frames only SHOW the new position, and
//          `floatingObject:moveComplete` is the one write -- one undo step per
//          drag, however long the user pauses in the middle of it.
// CONTEXT: Core owns the gesture (snap, page clamp, the lock, consume mode --
//          overlayMoveHandlers.ts) and dispatches already-final coordinates;
//          this module only decides WHEN they are persisted.
//
//          Preview frames used to persist through the store's 300 ms debounce.
//          A drag with a pause longer than that wrote one "Move floating range"
//          undo entry per pause: invisible to a test driver's fast mouse, and
//          an everyday gesture for a person once the title bar moved a range
//          without Design Mode (owner decision 2026-09-27).
//
//          The write joins the frontend's open undo transaction when there is
//          one (the canvas GROUP drag opens it at the first preview frame and
//          commits once everything has landed), and is otherwise a single
//          write that records its own step. A refusal is reported by the store
//          flush (toast) and the range put back where the backend has it.
//
//          A preview with NO completion -- on a worksheet Core previews pointer
//          jitter below its 3px click threshold and then completes nothing --
//          is put back at mouseup, so the store never keeps a position the
//          backend does not have.

import { AppEvents, emitAppEvent } from "@api/events";
import { requestOverlayRedraw } from "@api/gridOverlays";
import { joinUndoTransaction } from "@api/objectGeometry";
import {
  FLOATING_RANGE_REGION_TYPE,
  flushPendingFloatingRangeSaves,
  getFloatingRangeById,
  moveFloatingRange,
  previewFloatingRangePosition,
  syncFloatingRangeRegions,
} from "./floatingRangeStore";

interface MoveDetail {
  regionType?: unknown;
  data?: { frId?: unknown } | null;
  x?: unknown;
  y?: unknown;
}

function moveTarget(e: Event): { frId: string; x: number; y: number } | null {
  const detail = ((e as CustomEvent).detail ?? {}) as MoveDetail;
  if (detail.regionType !== FLOATING_RANGE_REGION_TYPE) return null;
  const frId = detail.data?.frId;
  if (typeof frId !== "string") return null;
  const x = detail.x;
  const y = detail.y;
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  if (typeof y !== "number" || !Number.isFinite(y)) return null;
  return { frId, x, y };
}

/**
 * Wire the move persistence. Returns the cleanup. Exported for the unit tier
 * (frMovePersistence.test.ts), which drives it with Core's own events.
 */
export function installFrMovePersistence(): () => void {
  /** Where each range stood when its current drag's first preview arrived. */
  const origins = new Map<string, { x: number; y: number }>();
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  /** The mouseup watch is SESSION-SCOPED: armed by a drag's first preview. */
  let watchingMouseUp = false;

  const repaint = () => {
    syncFloatingRangeRegions();
    requestOverlayRedraw();
    emitAppEvent(AppEvents.GRID_REFRESH);
  };

  // A preview that no completion followed: put it back. Deferred past the
  // mouseup's own dispatch, because Core completes the move from a window
  // mouseup listener too (and may replay a latched mouseup a frame later --
  // a completion that arrives after this still sets and persists the final
  // position, so the worst case is one frame at the origin).
  const settle = () => {
    settleTimer = null;
    if (origins.size === 0) return;
    for (const [frId, origin] of origins) {
      previewFloatingRangePosition(frId, origin.x, origin.y);
    }
    origins.clear();
    repaint();
  };
  const onMouseUp = () => {
    stopWatchingMouseUp();
    if (origins.size === 0) return;
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 0);
  };
  function stopWatchingMouseUp(): void {
    if (!watchingMouseUp) return;
    watchingMouseUp = false;
    window.removeEventListener("mouseup", onMouseUp, true);
  }

  const onPreview = (e: Event) => {
    const t = moveTarget(e);
    if (!t) return;
    const entry = getFloatingRangeById(t.frId);
    if (!entry) return;
    if (!origins.has(t.frId)) origins.set(t.frId, { x: entry.x, y: entry.y });
    if (!watchingMouseUp) {
      watchingMouseUp = true;
      window.addEventListener("mouseup", onMouseUp, true);
    }
    previewFloatingRangePosition(t.frId, t.x, t.y);
    repaint();
  };

  const onComplete = (e: Event) => {
    const t = moveTarget(e);
    if (!t) return;
    origins.delete(t.frId);
    if (origins.size === 0) stopWatchingMouseUp();
    moveFloatingRange(t.frId, t.x, t.y);
    repaint();
    // Land it NOW (not after the debounce): the undo entry exists by the time
    // the user can press Ctrl+Z, and a group drag's transaction tracks it.
    void joinUndoTransaction(() => flushPendingFloatingRangeSaves());
  };

  window.addEventListener("floatingObject:movePreview", onPreview);
  window.addEventListener("floatingObject:moveComplete", onComplete);
  return () => {
    window.removeEventListener("floatingObject:movePreview", onPreview);
    window.removeEventListener("floatingObject:moveComplete", onComplete);
    stopWatchingMouseUp();
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
    origins.clear();
  };
}
