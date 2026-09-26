//! FILENAME: app/extensions/Controls/lib/controlHitTest.ts
// PURPOSE: The ONE hit test for on-grid controls — the dispatcher Core calls
//          through the overlay registration, plus the client-coordinate entry
//          point the extension's own capture-phase listeners use.
// CONTEXT: There must be exactly one predicate answering "is this pixel on a
//          control?". The right-click menu needs the answer from a `MouseEvent`
//          on `window`, while Core's overlay plumbing supplies an
//          `OverlayHitTestContext` — two callers, one rule. A second
//          hand-rolled bounds test would drift the day a control type grows a
//          non-rectangular hit area (a rotated shape is the obvious next one),
//          and the symptom would be a right-click that selects nothing while
//          left-click works.

import {
  getGridRegions,
  floatingHitOrder,
  type GridRegion,
  type OverlayHitTestContext,
} from "@api/gridOverlays";
import { getGridStateSnapshot, resolveHeaderSizes, paintedDisplayHeadings } from "@api/grid";
import { hitTestFloatingShape } from "../Shape/shapeRenderer";
import { hitTestFloatingImage } from "../Image/imageRenderer";
import { hitTestFloatingButton } from "../Button/floatingRenderer";

/** The `GridRegion.type` every floating control publishes (see floatingStore). */
export const FLOATING_CONTROL_REGION_TYPE = "floating-control";

/**
 * Route a hit test to the renderer that owns the control type.
 *
 * Registered as the overlay `hitTest` in index.ts AND used by
 * `floatingControlRegionAtClientPoint` below, so the mouse and the menu can
 * never disagree about what the pointer is over.
 */
export function hitTestFloatingControl(hitCtx: OverlayHitTestContext): boolean {
  const controlType = hitCtx.region.data?.controlType;
  if (controlType === "shape") {
    return hitTestFloatingShape(hitCtx);
  } else if (controlType === "image") {
    return hitTestFloatingImage(hitCtx);
  } else {
    return hitTestFloatingButton(hitCtx);
  }
}

/**
 * Client (mouse) coordinates -> zoom-corrected logical canvas coordinates, the
 * basis every overlay bound is expressed in. Null when the grid is not mounted.
 */
function clientToCanvas(
  clientX: number,
  clientY: number,
): { x: number; y: number } | null {
  const layer = document.querySelector("[data-grid-canvas-layer]");
  if (!layer) return null;
  const rect = layer.getBoundingClientRect();
  const zoom = getGridStateSnapshot()?.zoom ?? 1;
  return { x: (clientX - rect.left) / zoom, y: (clientY - rect.top) / zoom };
}

/**
 * The canvas bounds of a floating region — the same arithmetic Core's
 * `getFloatingCanvasBounds` does, with the gutters Core PAINTED: a canvas
 * never shows headings (and View > Headings off collapses them) while the
 * stored config still carries 22 x 20, so the raw config put the hit box one
 * gutter right of and below the painted control (the BUG-0139 class).
 */
function floatingCanvasBounds(
  region: GridRegion,
): { x: number; y: number; width: number; height: number } | null {
  if (!region.floating) return null;
  const state = getGridStateSnapshot();
  if (!state) return null;
  const { rowHeaderWidth, colHeaderHeight } = resolveHeaderSizes(
    state.config,
    paintedDisplayHeadings(state.surface, state.displayHeadings),
  );
  return {
    x: rowHeaderWidth + region.floating.x - state.viewport.scrollX,
    y: colHeaderHeight + region.floating.y - state.viewport.scrollY,
    width: region.floating.width,
    height: region.floating.height,
  };
}

/**
 * The topmost floating CONTROL region under a client point, or null.
 *
 * Walks `floatingHitOrder` (@api/gridOverlays) — topmost first, the same order
 * Core's `findFloatingRegionAt` uses — so the object the menu opens for is the
 * object the user sees on top. Controls are tested with their own precise
 * hit test (a shape is not its rectangle); an object of ANOTHER family whose
 * rectangle covers the point stops the walk, because a control underneath it
 * is not what the user right-clicked (that family owns its own menu).
 */
export function floatingControlRegionAtClientPoint(
  clientX: number,
  clientY: number,
): GridRegion | null {
  const point = clientToCanvas(clientX, clientY);
  if (!point) return null;

  for (const region of floatingHitOrder(getGridRegions())) {
    const bounds = floatingCanvasBounds(region);
    if (!bounds) continue;
    if (region.type !== FLOATING_CONTROL_REGION_TYPE) {
      const covers =
        point.x >= bounds.x &&
        point.x <= bounds.x + bounds.width &&
        point.y >= bounds.y &&
        point.y <= bounds.y + bounds.height;
      if (covers) return null;
      continue;
    }
    const hit = hitTestFloatingControl({
      region,
      canvasX: point.x,
      canvasY: point.y,
      // Row/col are meaningless for a pixel-positioned control; the renderers'
      // hit tests read `floatingCanvasBounds` and never touch these.
      row: 0,
      col: 0,
      floatingCanvasBounds: bounds,
    });
    if (hit) return region;
  }
  return null;
}
