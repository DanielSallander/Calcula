//! FILENAME: app/extensions/FloatingRange/lib/frView.ts
// PURPOSE: The LIVE view of a floating range -- its content extent (frExtent)
//          with its session scroll (frScroll), clamped -- plus the two things
//          that move the scroll: keeping the active cell in view, and the wheel.
// CONTEXT: M7. Every consumer that turns a pixel into a cell or a cell into a
//          pixel (the renderer, the hit router in index.ts, the cell editor's
//          layout) reads the view through `getFrView`, so the paint and the
//          click can never disagree about which cell is where.
//
//          The wheel goes through the SHARED helper
//          (_shared/lib/objectWheelScroll.ts) -- its one capture-phase window
//          listener, surface-aware gutters and topmost-object rule -- exactly as
//          the canvas pivot box does. No listener of this extension's own.

import type { GridRegion } from "@api/gridOverlays";
import type { ObjectWheelTarget } from "../../_shared/lib/objectWheelScroll";
import { FLOATING_RANGE_REGION_TYPE, getFloatingRangeById, type FloatingRangeEntry } from "./floatingRangeStore";
import {
  FR_DEFAULT_ROW_H,
  clampFrScrollTo,
  contentHeight,
  contentWidth,
  frMaxScroll,
  frScrollToReveal,
  type FrView,
} from "./frDimensions";
import { frContentExtent, isFrExtentKnown } from "./frExtent";
import { getFrScroll, setFrScroll } from "./frScroll";

/**
 * The range's view now: extent + scroll, the scroll clamped into the extent.
 * Pure read -- the stored scroll is left alone (the paint writes the clamp
 * back once the extent is known; see `commitFrViewClamp`).
 */
export function getFrView(entry: FloatingRangeEntry): FrView {
  const extent = frContentExtent(entry);
  const s = getFrScroll(entry.id);
  const clamped = clampFrScrollTo(entry, extent.rows, extent.cols, s.left, s.top);
  return {
    scrollLeft: clamped.left,
    scrollTop: clamped.top,
    rows: extent.rows,
    cols: extent.cols,
  };
}

/**
 * Store the clamped scroll of a painted view, so a scroll left past the end by
 * a shrink (a smaller extent, a bigger window) does not come back when the
 * content grows again -- a worksheet's scroll behaves the same. Only once the
 * extent is KNOWN: before the first used-range read the extent is the bare
 * window, and clamping to it would throw away a scroll the session kept across
 * a sheet switch.
 */
export function commitFrViewClamp(entry: FloatingRangeEntry, view: FrView): void {
  if (!isFrExtentKnown(entry.id)) return;
  const s = getFrScroll(entry.id);
  if (s.left !== view.scrollLeft || s.top !== view.scrollTop) {
    setFrScroll(entry.id, view.scrollLeft, view.scrollTop);
  }
}

/**
 * Scroll so local cell (row, col) is fully inside the cell viewport. Returns
 * true when the scroll moved. The caller repaints (it already does for the
 * selection move that asked).
 */
export function ensureFrCellVisible(entry: FloatingRangeEntry, row: number, col: number): boolean {
  const view = getFrView(entry);
  const next = frScrollToReveal(entry, view, row, col);
  if (next.left === view.scrollLeft && next.top === view.scrollTop) return false;
  setFrScroll(entry.id, next.left, next.top);
  return true;
}

/** The floating-range id a published region carries, or null. */
function frIdOf(region: GridRegion): string | null {
  const id = region.data?.frId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

/**
 * The wheel target for floating ranges. The viewport is the cell area (the
 * WINDOW's cells); the content is the extent. A range whose extent has not
 * been read yet answers null and the wheel passes through -- it has not been
 * painted, so there is nothing under the pointer to scroll. A range with no
 * overflow on the wheeled axis gets max 0 there, and the helper then passes
 * the wheel to the page.
 *
 * A page-mode delta (deltaMode 2) is one CELL AREA (`pageSize`): the title
 * bar and the headers do not scroll, and a page sized by the whole frame
 * skipped the rows under them (W16).
 */
export function createFrWheelTarget(): ObjectWheelTarget {
  return {
    types: [FLOATING_RANGE_REGION_TYPE],
    // One wheel "line" is one default row.
    lineSize: FR_DEFAULT_ROW_H,

    getScroll(region: GridRegion) {
      const frId = frIdOf(region);
      const entry = frId ? getFloatingRangeById(frId) : null;
      if (!entry || !isFrExtentKnown(entry.id)) return null;
      const view = getFrView(entry);
      const { maxLeft, maxTop } = frMaxScroll(entry, view.rows, view.cols);
      return { left: view.scrollLeft, top: view.scrollTop, maxLeft, maxTop };
    },

    setScroll(region: GridRegion, left: number, top: number) {
      const frId = frIdOf(region);
      if (!frId) return;
      setFrScroll(frId, left, top);
    },

    pageSize(region: GridRegion) {
      const frId = frIdOf(region);
      const entry = frId ? getFloatingRangeById(frId) : null;
      const f = region.floating;
      if (!entry) return { width: f?.width ?? 0, height: f?.height ?? 0 };
      return { width: contentWidth(entry), height: contentHeight(entry) };
    },
  };
}
