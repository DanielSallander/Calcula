//! FILENAME: app/extensions/CanvasSheet/lib/canvasActions.ts
// PURPOSE: What the Canvas ribbon tab DOES: change the active canvas's layout
//          through the one backend door, and zoom the page to fit or to 100%.
// CONTEXT: Every layout change goes to `set_canvas_layout`, which validates the
//          merged result and announces it (CANVAS_LAYOUT_CHANGED). The returned
//          layout is applied to the store at once so the ribbon and the snap
//          grid answer the click without waiting for the announcement round
//          trip; the announcement then re-reads the same value.
//
//          A value the ribbon can already tell is out of range is refused here
//          with the same message the backend would give (`checkCanvasLayoutPatch`
//          mirrors the Rust ranges and is pinned against them), so the user
//          hears about a typo immediately and nothing is sent.

import {
  setCanvasLayout,
  setZoom,
  scrollToPosition,
  dispatchGridAction,
  ZOOM_DEFAULT,
  ZOOM_MIN,
  ZOOM_MAX,
} from "@api";
import type { CanvasLayoutPatch } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { alertAsync } from "@api/dialogs";
import { checkCanvasLayoutPatch } from "@api/canvasSheet";
import { LAYOUT_PAGE_MARGIN, GRID_SCROLLBAR_GUTTER_PX } from "@api/layoutSurface";
import { applyCanvasLayout, getCanvasSheetSnapshot, refreshCanvasSheets } from "./canvasSheetStore";

/**
 * The scrollbar gutter the grid area reserves on its right and bottom edge, in
 * screen px -- Core's own constant, so fit-to-page and the scrollbar can never
 * disagree about where the page's far edge must stop.
 */
const SCROLLBAR_GUTTER_PX = GRID_SCROLLBAR_GUTTER_PX;

/**
 * Patch the ACTIVE canvas's layout. Resolves true when the backend accepted
 * it. A refusal (a local range check, or the backend's) is told to the user
 * and resolves false; nothing is half-applied.
 */
export async function patchActiveCanvasLayout(patch: CanvasLayoutPatch): Promise<boolean> {
  const snap = getCanvasSheetSnapshot();
  if (!snap.active) return false;
  const local = checkCanvasLayoutPatch(patch);
  if (local) {
    void alertAsync(local, { title: "Canvas" });
    return false;
  }
  try {
    const layout = await setCanvasLayout(patch, snap.active.index);
    applyCanvasLayout(snap.active.index, layout);
    return true;
  } catch (err) {
    // The store may be stale (a script moved the sheet); re-read before the
    // user tries again.
    void refreshCanvasSheets();
    void alertAsync(String(err), { title: "Canvas" });
    return false;
  }
}

/**
 * The zoom factor that shows the whole page (plus its margin) in a viewport of
 * `viewportW x viewportH` screen px. Pure; exported for tests.
 */
export function fitPageZoom(
  viewportW: number,
  viewportH: number,
  page: { width: number; height: number },
): number {
  const availW = Math.max(1, viewportW - SCROLLBAR_GUTTER_PX);
  const availH = Math.max(1, viewportH - SCROLLBAR_GUTTER_PX);
  const fit = Math.min(
    availW / (page.width + LAYOUT_PAGE_MARGIN),
    availH / (page.height + LAYOUT_PAGE_MARGIN),
  );
  // Whole percent, clamped to the grid's range.
  const percent = Math.floor(fit * 100) / 100;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, percent));
}

/** Zoom so the whole page of the active canvas is in view, scrolled home. */
export function fitActiveCanvasToWindow(): void {
  const snap = getCanvasSheetSnapshot();
  const state = getGridStateSnapshot();
  if (!snap.active || !state) return;
  const { width, height } = state.viewportDimensions;
  if (width <= 0 || height <= 0) return;
  const zoom = fitPageZoom(width, height, {
    width: snap.active.layout.pageWidth,
    height: snap.active.layout.pageHeight,
  });
  dispatchGridAction(setZoom(zoom));
  // SET_ZOOM does not re-clamp scroll: put the page's corner in view.
  dispatchGridAction(scrollToPosition(0, 0));
}

/** Show the active canvas at 100%. */
export function showActiveCanvasAtActualSize(): void {
  dispatchGridAction(setZoom(ZOOM_DEFAULT));
}
