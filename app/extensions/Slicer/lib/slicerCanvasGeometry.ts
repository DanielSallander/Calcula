//! FILENAME: app/extensions/Slicer/lib/slicerCanvasGeometry.ts
// PURPOSE: Where a slicer is on the canvas RIGHT NOW, and which slicer (if
//          any) a logical canvas point is on -- for the extension's own pointer
//          paths that run outside the overlay context: the item click on
//          mouseup, the wheel, and the right-click menu.
// CONTEXT: Two defects closed here (M8):
//
//          THE GUTTERS ARE THE PAINTED ONES. These paths read
//          `gridState.config.rowHeaderWidth` -- the STORED config -- while Core
//          paints and hit-tests with the effective one. On a canvas sheet (a
//          report page never shows headings) and on a headings-off worksheet
//          the stored gutter is still 22 x 20, so a right-click near a slicer's
//          top-left edge found nothing, a wheel scrolled the slicer from one
//          gutter away, and an item click toggled the item above the one under
//          the pointer. The same defect BUG-0139 fixed in Core's mouse layer
//          and M7 fixed in FloatingRange (lib/frCanvasGeometry.ts).
//
//          THE TOPMOST OBJECT DECIDES. The slicer lookup used to walk only the
//          slicers, so a slicer covered by a chart (or a shape, or another
//          family's object) still answered a right-click or a wheel through
//          the object on top -- and because the Slicer's menu listener calls
//          stopImmediatePropagation, the object the user actually clicked got
//          no menu at all. Core's one stacking order (`topFloatingRegionAt`,
//          @api/gridOverlays) now answers first: another family's object on
//          top refuses the point; a slicer on top is THE slicer.

import {
  getGridStateSnapshot,
  resolveHeaderSizes,
  paintedDisplayHeadings,
} from "@api/grid";
import { topFloatingRegionAt, type FloatingHitGeometry } from "@api/gridOverlays";
import { getAllSlicers, getSlicerById } from "./slicerStore";
import { SLICER_REGION_TYPE, slicerIdOf } from "./slicerObjectSelection";
import type { Slicer } from "./slicerTypes";

/** The live floating geometry with the gutters Core PAINTED; null before mount. */
export function slicerHitGeometry(): FloatingHitGeometry | null {
  const state = getGridStateSnapshot();
  if (!state) return null;
  const { rowHeaderWidth, colHeaderHeight } = resolveHeaderSizes(
    state.config,
    paintedDisplayHeadings(state.surface, state.displayHeadings),
  );
  return {
    rowHeaderWidth,
    colHeaderHeight,
    scrollX: state.viewport.scrollX,
    scrollY: state.viewport.scrollY,
  };
}

/** A slicer's logical canvas bounds (painted gutters); null before mount. */
export function slicerCanvasBounds(
  slicer: Pick<Slicer, "x" | "y" | "width" | "height">,
): { x: number; y: number; width: number; height: number } | null {
  const geo = slicerHitGeometry();
  if (!geo) return null;
  return {
    x: geo.rowHeaderWidth + slicer.x - geo.scrollX,
    y: geo.colHeaderHeight + slicer.y - geo.scrollY,
    width: slicer.width,
    height: slicer.height,
  };
}

/**
 * The slicer a logical canvas point is on, or null.
 *
 * Core's topmost floating region decides first: a slicer region on top is the
 * answer; any OTHER object on top refuses the point (it is that object's
 * gesture). Only when no published region is there does the slicer store
 * itself answer (active sheet, last first), with the same painted gutters.
 */
export function slicerAtCanvasPoint(canvasX: number, canvasY: number): Slicer | null {
  const geo = slicerHitGeometry();
  if (!geo) return null;
  const top = topFloatingRegionAt(canvasX, canvasY, geo);
  if (top) {
    if (top.type !== SLICER_REGION_TYPE) return null;
    const id = slicerIdOf(top);
    return id ? (getSlicerById(id) ?? null) : null;
  }
  const activeSheet = getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0;
  const slicers = getAllSlicers();
  for (let i = slicers.length - 1; i >= 0; i--) {
    const s = slicers[i];
    if (s.sheetIndex !== activeSheet) continue;
    const x = geo.rowHeaderWidth + s.x - geo.scrollX;
    const y = geo.colHeaderHeight + s.y - geo.scrollY;
    if (canvasX >= x && canvasX <= x + s.width && canvasY >= y && canvasY <= y + s.height) {
      return s;
    }
  }
  return null;
}
