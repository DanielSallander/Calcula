//! FILENAME: app/extensions/CanvasSheet/lib/canvasActions.ts
// PURPOSE: What the Canvas ribbon tab DOES: change the active canvas's layout
//          through the one backend door; show the page at one of Power BI's
//          three Page Views (Fit to Page, Fit to Width, Actual Size) and say
//          which one it is shown at; and add a new report page.
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
import { CommandRegistry, CoreCommands } from "@api/commands";
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

/**
 * The zoom factor at which the page's WIDTH (plus its margin) fills a viewport
 * `viewportW` screen px wide -- Power BI's Fit to Width: the height is free
 * and scrolls. Whole percent, clamped like {@link fitPageZoom}, and never
 * below it (only one edge binds). Pure; exported for tests.
 */
export function fitWidthZoom(viewportW: number, page: { width: number; height: number }): number {
  const availW = Math.max(1, viewportW - SCROLLBAR_GUTTER_PX);
  const percent = Math.floor((availW / (page.width + LAYOUT_PAGE_MARGIN)) * 100) / 100;
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, percent));
}

/** Power BI's three Page Views (View > Page view). */
export type PageViewMode = "fitPage" | "fitWidth" | "actual";

/** The Page View chosen last this session: the tie-break when two give one zoom. */
let lastPageView: PageViewMode | null = null;

/** The active canvas's page and the grid's viewport, or null off a canvas / before layout. */
function activePageAndViewport(): {
  page: { width: number; height: number };
  width: number;
  height: number;
  zoom: number;
} | null {
  const snap = getCanvasSheetSnapshot();
  const state = getGridStateSnapshot();
  if (!snap.active || !state) return null;
  const { width, height } = state.viewportDimensions ?? { width: 0, height: 0 };
  if (!(width > 0) || !(height > 0)) return null;
  return {
    page: { width: snap.active.layout.pageWidth, height: snap.active.layout.pageHeight },
    width,
    height,
    zoom: state.zoom > 0 ? state.zoom : 1,
  };
}

/** Zoom to `zoom` and put the page's corner in view (SET_ZOOM does not re-clamp scroll). */
function showAt(zoom: number, mode: PageViewMode): void {
  lastPageView = mode;
  dispatchGridAction(setZoom(zoom));
  dispatchGridAction(scrollToPosition(0, 0));
}

/** Fit to Page: zoom so the whole page of the active canvas is in view, scrolled home. */
export function fitActiveCanvasToWindow(): void {
  const v = activePageAndViewport();
  if (!v) return;
  showAt(fitPageZoom(v.width, v.height, v.page), "fitPage");
}

/** Fit to Width: zoom so the active canvas's page fills the view's width, scrolled home. */
export function fitActiveCanvasToWidth(): void {
  const v = activePageAndViewport();
  if (!v) return;
  showAt(fitWidthZoom(v.width, v.page), "fitWidth");
}

/** Actual Size: show the active canvas at 100%. */
export function showActiveCanvasAtActualSize(): void {
  lastPageView = "actual";
  dispatchGridAction(setZoom(ZOOM_DEFAULT));
}

/**
 * Which Page View a page is shown at: the mode whose zoom equals `zoom` for
 * this viewport and page, or null for a zoom of the user's own (the zoom
 * slider, Ctrl+wheel). A Page View in Calcula is a one-shot zoom, not a
 * standing setting, so the check follows the zoom rather than a remembered
 * choice -- the menu never claims "Fit to Page" for a page the user has since
 * zoomed. When two modes give the SAME zoom (a short wide page: fit to page =
 * fit to width), `preferred` -- the mode chosen last -- keeps the check;
 * otherwise the menu's order decides. Pure; exported for tests.
 */
export function pageViewOf(
  zoom: number,
  viewportW: number,
  viewportH: number,
  page: { width: number; height: number },
  preferred: PageViewMode | null = null,
): PageViewMode | null {
  const close = (a: number, b: number): boolean => Math.abs(a - b) < 0.005;
  const matches: PageViewMode[] = [];
  if (close(zoom, fitPageZoom(viewportW, viewportH, page))) matches.push("fitPage");
  if (close(zoom, fitWidthZoom(viewportW, page))) matches.push("fitWidth");
  if (close(zoom, ZOOM_DEFAULT)) matches.push("actual");
  if (matches.length === 0) return null;
  return preferred !== null && matches.includes(preferred) ? preferred : matches[0];
}

/** The Page View the ACTIVE canvas is shown at now, or null (see {@link pageViewOf}). */
export function currentPageView(): PageViewMode | null {
  const v = activePageAndViewport();
  if (!v) return null;
  return pageViewOf(v.zoom, v.width, v.height, v.page, lastPageView);
}

/**
 * What New Page asks the public sheet command (core.sheet.insert, @api
 * CoreCommands.SHEET_INSERT) for: a CANVAS, appended at the END -- as the
 * strip's own "+" and Power BI's New page do (canvas-tab lane D3). The strip
 * owns the whole switch (the backend add, the prime, the tab, SHEET_CHANGED)
 * and the command owns the refusals (a formula being written), so the Canvas
 * tab neither calls the backend nor borrows the Shell's private
 * `sheet:requestAdd` event, which it used to (review finding 2026-10-08).
 */
export const NEW_CANVAS_PAGE_ARGS = Object.freeze({ kind: "canvas", atEnd: true } as const);

/** Pages > New Page: a blank report page -- a new canvas sheet, made active. */
export async function addBlankCanvasPage(): Promise<void> {
  await CommandRegistry.execute(CoreCommands.SHEET_INSERT, { ...NEW_CANVAS_PAGE_ARGS });
}
