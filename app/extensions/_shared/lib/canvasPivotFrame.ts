//! FILENAME: app/extensions/_shared/lib/canvasPivotFrame.ts
// PURPOSE: Where a new pivot's box goes on a CANVAS sheet, for every flow that
//          creates a pivot (the Pivot extension's Create dialog and the
//          Business Intelligence extension's "PivotTable from Model" flows).
// CONTEXT: A pivot on a canvas sheet is a REAL pivot written into the canvas's
//          hidden grid, shown inside a designer-sized box (the frame, logical
//          page px). The backend REQUIRES the frame for a canvas destination
//          and refuses one for a worksheet, so each create flow must answer the
//          same two questions the same way: "is the destination a canvas?" and
//          "where does the box go?". Two extensions each with its own copy of
//          the answer would drift on the first default change, so it lives here
//          (the sanctioned cross-extension code), and both ask the layout
//          surface -- the one place every floating object's geometry is
//          constrained. A worksheet has no layout surface.

import { getGridStateSnapshot } from "@api/grid";
import { clampMoveToPage, getLayoutSurface, snapValue } from "@api/layoutSurface";
import type { CanvasFrameConfig } from "@api/pivot";

/** Where on which canvas the pivot's frame goes (logical page px). */
export interface CanvasPivotPlacement {
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The frame a pivot gets when the opener did not say. */
export const CANVAS_PIVOT_DEFAULT_SIZE = { width: 480, height: 320 } as const;

/** What the default-frame maths needs to know about the view. */
export interface CanvasPivotView {
  sheetIndex: number;
  scrollX: number;
  scrollY: number;
  /** Visible area in LOGICAL px (screen px / zoom). */
  viewWidth: number;
  viewHeight: number;
}

/**
 * The frame for a pivot created on a canvas with no placement: the default size
 * (shrunk to a smaller page -- the view scrolls inside the box, so a smaller
 * box loses nothing), centred in the view, on the snap grid when snap is on,
 * and kept on the page.
 */
export function defaultCanvasPivotPlacement(view: CanvasPivotView): CanvasPivotPlacement {
  const surface = getLayoutSurface(view.sheetIndex);
  const page = surface?.page ?? null;
  const width = page ? Math.min(CANVAS_PIVOT_DEFAULT_SIZE.width, page.width) : CANVAS_PIVOT_DEFAULT_SIZE.width;
  const height = page ? Math.min(CANVAS_PIVOT_DEFAULT_SIZE.height, page.height) : CANVAS_PIVOT_DEFAULT_SIZE.height;
  let x = view.scrollX + (view.viewWidth - width) / 2;
  let y = view.scrollY + (view.viewHeight - height) / 2;
  if (surface?.snapToGrid && surface.gridSize > 0) {
    x = snapValue(x, surface.gridSize);
    y = snapValue(y, surface.gridSize);
  }
  const rect = clampMoveToPage({ x: Math.max(0, x), y: Math.max(0, y), width, height }, page);
  return { sheetIndex: view.sheetIndex, ...rect };
}

/** The wire frame for a placement. Header rows and columns stay put while the body scrolls. */
export function canvasFrameOf(placement: CanvasPivotPlacement): CanvasFrameConfig {
  return {
    x: placement.x,
    y: placement.y,
    width: placement.width,
    height: placement.height,
    frozenHeaders: true,
  };
}

/**
 * The frame a pivot created on sheet `sheetIndex` needs, or `undefined` when
 * that sheet is a worksheet (which must NOT be sent a frame). The box is
 * centred in the current view when the sheet is the active one, else in the
 * top-left of the page.
 */
export function canvasPivotFrameFor(sheetIndex: number): CanvasFrameConfig | undefined {
  if (!getLayoutSurface(sheetIndex)) return undefined;
  const s = getGridStateSnapshot();
  const zoom = s && s.zoom > 0 ? s.zoom : 1;
  const view: CanvasPivotView =
    s && s.sheetContext.activeSheetIndex === sheetIndex
      ? {
          sheetIndex,
          scrollX: s.viewport.scrollX,
          scrollY: s.viewport.scrollY,
          viewWidth: Math.max(1, s.viewportDimensions.width / zoom),
          viewHeight: Math.max(1, s.viewportDimensions.height / zoom),
        }
      : {
          sheetIndex,
          scrollX: 0,
          scrollY: 0,
          viewWidth: CANVAS_PIVOT_DEFAULT_SIZE.width,
          viewHeight: CANVAS_PIVOT_DEFAULT_SIZE.height,
        };
  return canvasFrameOf(defaultCanvasPivotPlacement(view));
}
