//! FILENAME: app/extensions/Charts/lib/chartPointer.ts
// PURPOSE: Turn a mouse event's CLIENT point into the logical canvas point
//          chart geometry is measured in.
// CONTEXT: BUG-0156. Chart geometry -- a chart's region, its cached hit
//          geometry, `getChartLocalCoords`, `findChartAtCanvasPos` -- is in
//          LOGICAL (unzoomed) px, the units of `GridRegion.floating`. The
//          renderer scales by the zoom when it paints. Core's own press path
//          divides the pointer by the zoom, and so does every other family's
//          (Slicer, Timeline, `topFloatingRegionAtClient`), but Charts' hover
//          and right-click paths used `clientX - rect.left` as is. At any zoom
//          but 100% the tooltip, the hover highlight, the sub-selection
//          ladder's pending click (it reuses the last hover point) and the
//          right-click target all resolved against the wrong point -- and
//          could disagree with the occlusion check, which is zoom-corrected.
//
//          ONE conversion, here, used by both paths.

import { getGridStateSnapshot } from "@api/grid";

/** The grid's zoom factor now (1 before the grid mounts). */
export function currentGridZoom(): number {
  const z = getGridStateSnapshot()?.zoom;
  return typeof z === "number" && z > 0 && Number.isFinite(z) ? z : 1;
}

/**
 * The logical canvas point of a client point: relative to the grid element's
 * box, divided by the zoom. Pure; `zoom` defaults to the live zoom.
 */
export function clientToChartCanvas(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  zoom: number = currentGridZoom(),
): { x: number; y: number } {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  return { x: (clientX - rect.left) / z, y: (clientY - rect.top) / z };
}

/**
 * The inverse: the CLIENT (screen) point of a logical canvas point, for
 * anchoring a DOM popup (a pivot field button's filter menu, the quick-access
 * panel) at a place measured in chart geometry.
 */
export function chartCanvasToClient(
  canvasX: number,
  canvasY: number,
  rect: { left: number; top: number } | null | undefined,
  zoom: number = currentGridZoom(),
): { x: number; y: number } {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  return { x: (rect?.left ?? 0) + canvasX * z, y: (rect?.top ?? 0) + canvasY * z };
}

/**
 * Whether a logical canvas point lies inside the grid element's box, whose
 * `width`/`height` are SCREEN px (so they are divided by the zoom too).
 */
export function insideChartCanvas(
  point: { x: number; y: number },
  rect: { width: number; height: number },
  zoom: number = currentGridZoom(),
): boolean {
  const z = zoom > 0 && Number.isFinite(zoom) ? zoom : 1;
  return point.x >= 0 && point.y >= 0 && point.x <= rect.width / z && point.y <= rect.height / z;
}
