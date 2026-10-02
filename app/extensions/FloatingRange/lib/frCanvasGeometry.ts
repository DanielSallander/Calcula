//! FILENAME: app/extensions/FloatingRange/lib/frCanvasGeometry.ts
// PURPOSE: Where a floating range's frame is on the canvas RIGHT NOW, in the
//          logical canvas basis Core hands the overlay hooks -- for the
//          extension's own mouse paths (drag-extend, body drag, the right-click
//          menu), which run outside the overlay context and must find the frame
//          without one.
// CONTEXT: Moved out of index.ts (M7) so the gutter rule can be pinned by a test.
//
//          THE GUTTERS ARE THE PAINTED ONES. These bounds used to read
//          `rowHeaderGutter(state.config)` -- the STORED config -- while Core
//          paints and hit-tests with the effective one. On a canvas sheet (a
//          report page never shows headings, whatever the sheet's flag says)
//          and on a headings-off worksheet the stored gutter is still 22 x 20,
//          so every bound here sat one gutter right of and below the painted
//          frame: a drag-extend picked the cell one column left and one row up,
//          and a right-click near the frame's top-left edge found no object.
//          Core's own mouse layer had the same defect and resolves the flag
//          through `paintedDisplayHeadings`; so does this, exactly as the
//          shared wheel helper (_shared/lib/objectWheelScroll.ts) does.

import {
  getGridStateSnapshot,
  resolveHeaderSizes,
  paintedDisplayHeadings,
} from "@api/grid";
import {
  getAllFloatingRanges,
  getFrActiveSheetIndex,
  type FloatingRangeEntry,
} from "./floatingRangeStore";
import { frameWidth, frameHeight } from "./frDimensions";

/** Frame's logical canvas bounds from live grid state, with the gutters Core
 *  PAINTED (surface- and headings-aware). Null when grid state is not ready. */
export function frameCanvasBounds(
  entry: FloatingRangeEntry,
): { x: number; y: number; width: number; height: number } | null {
  const state = getGridStateSnapshot();
  if (!state) return null;
  const { rowHeaderWidth, colHeaderHeight } = resolveHeaderSizes(
    state.config,
    paintedDisplayHeadings(state.surface, state.displayHeadings),
  );
  return {
    x: rowHeaderWidth + entry.x - state.viewport.scrollX,
    y: colHeaderHeight + entry.y - state.viewport.scrollY,
    width: frameWidth(entry),
    height: frameHeight(entry),
  };
}

/** Client (mouse) coordinates -> zoom-corrected logical canvas coordinates —
 *  the same basis Core hands zoneAt/bodyDragStart. */
export function clientToCanvas(clientX: number, clientY: number): { x: number; y: number } | null {
  const layer = document.querySelector("[data-grid-canvas-layer]");
  if (!layer) return null;
  const rect = layer.getBoundingClientRect();
  const zoom = getGridStateSnapshot()?.zoom ?? 1;
  return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
}

/**
 * The floating range whose FRAME contains a logical-canvas point, or null.
 * Active sheet only (that is what publishes regions), last one first so the
 * topmost of two overlapping frames wins — the same order Core's own
 * `findFloatingRegionAt` walks.
 */
export function frameAtCanvasPoint(
  canvasX: number,
  canvasY: number,
): FloatingRangeEntry | null {
  const active = getAllFloatingRanges().filter(
    (e) => e.sheetIndex === getFrActiveSheetIndex(),
  );
  for (let i = active.length - 1; i >= 0; i--) {
    const entry = active[i];
    const b = frameCanvasBounds(entry);
    if (!b) continue;
    if (
      canvasX >= b.x &&
      canvasX <= b.x + b.width &&
      canvasY >= b.y &&
      canvasY <= b.y + b.height
    ) {
      return entry;
    }
  }
  return null;
}
