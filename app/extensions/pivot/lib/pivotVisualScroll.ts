//! FILENAME: app/extensions/Pivot/lib/pivotVisualScroll.ts
// PURPOSE: The session scroll origin of each canvas pivot box, the wheel
//          target that lets the shared object-wheel helper scroll it, and the
//          scroll that keeps a cell the keyboard moved to in sight
//          (`ensurePivotCellVisible`, D-CELLS).
// CONTEXT: Scroll is a VIEWING state, like a worksheet's scroll position: it is
//          never persisted and never enters the undo stack. It is kept per
//          pivot id for the session (switching sheets and back keeps it) and
//          re-clamped on every paint, so a smaller box after a resize or a
//          shorter view after a refilter can never leave it past the end.

import type { GridRegion } from "@api/gridOverlays";
import type { ObjectWheelTarget } from "../../_shared/lib/objectWheelScroll";
import type { PivotVisualScroll } from "../rendering/pivotVisualRenderer";
import { clampVisualScroll, frozenExtent, maxScrollOf } from "../rendering/pivotVisualRenderer";
import { DEFAULT_PIVOT_CELL_HEIGHT } from "../rendering/pivot";
import { PIVOT_VISUAL_REGION_TYPE, pivotIdOfVisual } from "./pivotVisualRegions";
import { getPivotVisualRecord } from "./pivotVisualHits";

const scrolls = new Map<string, PivotVisualScroll>();

/** The box's scroll origin (0,0 until it is scrolled). */
export function getPivotVisualScroll(pivotId: string): PivotVisualScroll {
  return scrolls.get(pivotId) ?? { left: 0, top: 0 };
}

export function setPivotVisualScroll(pivotId: string, s: PivotVisualScroll): void {
  if (s.left === 0 && s.top === 0) scrolls.delete(pivotId);
  else scrolls.set(pivotId, { left: s.left, top: s.top });
}

/** Forget every scroll origin (a new or opened document). */
export function resetPivotVisualScrolls(): void {
  scrolls.clear();
}

/**
 * The scroll on ONE axis that shows the span [start, end) (content px) in the
 * scrolling body, which is shown at box-local [frozenPx, boxPx): unchanged
 * when it is already in view; otherwise the least move that shows it -- its
 * near edge at the frozen band's edge when it lies before the body, its far
 * edge at the box edge when it lies past it (its near edge when it is taller
 * or wider than the body itself).
 */
function scrollToShow(start: number, end: number, scroll: number, frozenPx: number, boxPx: number): number {
  const body = boxPx - frozenPx;
  if (!(body > 0)) return scroll;
  if (start - scroll < frozenPx) return start - frozenPx;
  if (end - scroll > boxPx) return end - start > body ? start - frozenPx : end - boxPx;
  return scroll;
}

/**
 * Scroll the box's body so view cell (`viewRow`, `viewCol`) is inside the
 * part of the box the body is shown in (`box - frozen`) -- an arrow key
 * moving the box's active cell (D-CELLS) keeps it in sight. A frozen header
 * row or row-label column is always shown and moves nothing on its axis. The
 * geometry and box are the ones the box was LAST PAINTED with; a box with no
 * painted geometry (off screen, no view yet) is left alone. Returns whether
 * the scroll changed (the caller repaints).
 */
export function ensurePivotCellVisible(pivotId: string, viewRow: number, viewCol: number): boolean {
  const record = getPivotVisualRecord(pivotId);
  const g = record?.geometry;
  if (!record || !g) return false;
  const { width: boxWidth, height: boxHeight } = record.box;
  if (!(boxWidth > 0) || !(boxHeight > 0)) return false;

  const { frozenWidth, frozenHeight } = frozenExtent(g);
  const stored = getPivotVisualScroll(pivotId);
  const current = clampVisualScroll(g, boxWidth, boxHeight, stored);
  let { left, top } = current;
  if (Number.isInteger(viewRow) && viewRow >= g.frozenRowCount && viewRow < g.rowCount) {
    top = scrollToShow(g.rowOffsets[viewRow], g.rowOffsets[viewRow + 1], top, frozenHeight, boxHeight);
  }
  if (Number.isInteger(viewCol) && viewCol >= g.frozenColCount && viewCol < g.colCount) {
    left = scrollToShow(g.colOffsets[viewCol], g.colOffsets[viewCol + 1], left, frozenWidth, boxWidth);
  }
  const next = clampVisualScroll(g, boxWidth, boxHeight, { left, top });
  if (next.left === stored.left && next.top === stored.top) return false;
  setPivotVisualScroll(pivotId, next);
  return true;
}

/**
 * The wheel target for `pivot-visual` boxes. The extent comes from the
 * geometry the box was LAST PAINTED with (the view the user is looking at)
 * and the box's current size; a box that has not been painted yet answers
 * null, and the wheel passes through.
 */
export function createPivotVisualWheelTarget(): ObjectWheelTarget {
  return {
    types: [PIVOT_VISUAL_REGION_TYPE],
    // One wheel "line" is about one pivot row.
    lineSize: DEFAULT_PIVOT_CELL_HEIGHT,

    getScroll(region: GridRegion) {
      const pivotId = pivotIdOfVisual(region);
      if (!pivotId || !region.floating) return null;
      const record = getPivotVisualRecord(pivotId);
      if (!record?.geometry) return null;
      // The body scrolls inside the box's CONTENT rect (the container's
      // padding, border and title bands are not scroll room): the extent of
      // the box as last painted, the one the paint clamps to.
      const { maxLeft, maxTop } = maxScrollOf(record.geometry, record.box.width, record.box.height);
      const s = getPivotVisualScroll(pivotId);
      return {
        left: Math.min(Math.max(0, s.left), maxLeft),
        top: Math.min(Math.max(0, s.top), maxTop),
        maxLeft,
        maxTop,
      };
    },

    setScroll(region: GridRegion, left: number, top: number) {
      const pivotId = pivotIdOfVisual(region);
      if (!pivotId) return;
      setPivotVisualScroll(pivotId, { left, top });
    },
  };
}
