//! FILENAME: app/extensions/Pivot/lib/pivotVisualScroll.ts
// PURPOSE: The session scroll origin of each canvas pivot box, and the wheel
//          target that lets the shared object-wheel helper scroll it.
// CONTEXT: Scroll is a VIEWING state, like a worksheet's scroll position: it is
//          never persisted and never enters the undo stack. It is kept per
//          pivot id for the session (switching sheets and back keeps it) and
//          re-clamped on every paint, so a smaller box after a resize or a
//          shorter view after a refilter can never leave it past the end.

import type { GridRegion } from "@api/gridOverlays";
import type { ObjectWheelTarget } from "../../_shared/lib/objectWheelScroll";
import type { PivotVisualScroll } from "../rendering/pivotVisualRenderer";
import { maxScrollOf } from "../rendering/pivotVisualRenderer";
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
      const { maxLeft, maxTop } = maxScrollOf(record.geometry, region.floating.width, region.floating.height);
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
