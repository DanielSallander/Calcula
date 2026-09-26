//! FILENAME: app/extensions/TimelineSlicer/lib/timelineCanvasGeometry.ts
// PURPOSE: Where a timeline is on the canvas RIGHT NOW, and which timeline (if
//          any) a logical canvas point is on -- for the extension's own pointer
//          paths that run outside the overlay context: the click on mouseup,
//          the period drag, the wheel, and the right-click menu.
// CONTEXT: The Slicer's twin (Slicer/lib/slicerCanvasGeometry.ts), closing the
//          same two defects (M8):
//
//          THE GUTTERS ARE THE PAINTED ONES. These paths read the STORED
//          config's gutters, which are still 22 x 20 on a canvas (it never
//          shows headings) and on a headings-off worksheet, so every hit sat one
//          gutter right of and below the painted timeline (the BUG-0139 class).
//
//          THE TOPMOST OBJECT DECIDES. The timeline lookup walked only the
//          timelines, so a timeline covered by another object still answered a
//          right-click or a wheel through it. Core's one stacking order
//          (`topFloatingRegionAt`, @api/gridOverlays) now answers first.

import {
  getGridStateSnapshot,
  resolveHeaderSizes,
  paintedDisplayHeadings,
} from "@api/grid";
import { topFloatingRegionAt, type FloatingHitGeometry } from "@api/gridOverlays";
import { getAllTimelines, getTimelineById } from "./timelineSlicerStore";
import { TIMELINE_REGION_TYPE, timelineIdOf } from "./timelineObjectSelection";
import type { TimelineSlicer } from "./timelineSlicerTypes";

/** The live floating geometry with the gutters Core PAINTED; null before mount. */
export function timelineHitGeometry(): FloatingHitGeometry | null {
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

/** A timeline's logical canvas bounds (painted gutters); null before mount. */
export function timelineCanvasBounds(
  tl: Pick<TimelineSlicer, "x" | "y" | "width" | "height">,
): { x: number; y: number; width: number; height: number } | null {
  const geo = timelineHitGeometry();
  if (!geo) return null;
  return {
    x: geo.rowHeaderWidth + tl.x - geo.scrollX,
    y: geo.colHeaderHeight + tl.y - geo.scrollY,
    width: tl.width,
    height: tl.height,
  };
}

/**
 * The timeline a logical canvas point is on, or null.
 *
 * Core's topmost floating region decides first: a timeline region on top is
 * the answer; any OTHER object on top refuses the point. Only when no
 * published region is there does the timeline store itself answer (active
 * sheet, last first), with the same painted gutters.
 */
export function timelineAtCanvasPoint(canvasX: number, canvasY: number): TimelineSlicer | null {
  const geo = timelineHitGeometry();
  if (!geo) return null;
  const top = topFloatingRegionAt(canvasX, canvasY, geo);
  if (top) {
    if (top.type !== TIMELINE_REGION_TYPE) return null;
    const id = timelineIdOf(top);
    return id ? (getTimelineById(id) ?? null) : null;
  }
  const activeSheet = getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0;
  const timelines = getAllTimelines();
  for (let i = timelines.length - 1; i >= 0; i--) {
    const t = timelines[i];
    if (t.sheetIndex !== activeSheet) continue;
    const x = geo.rowHeaderWidth + t.x - geo.scrollX;
    const y = geo.colHeaderHeight + t.y - geo.scrollY;
    if (canvasX >= x && canvasX <= x + t.width && canvasY >= y && canvasY <= y + t.height) {
      return t;
    }
  }
  return null;
}
