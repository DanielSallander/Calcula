//! FILENAME: app/extensions/CanvasSheet/index.ts
// PURPOSE: CANVAS SHEETS -- the report-page sheet kind. A canvas has no cells;
//          it holds floating objects (charts, slicers, shapes, floating grids,
//          pivots) on a fixed page with an optional snap grid, the way a Power
//          BI report page does.
// CONTEXT: What this extension owns (everything else about a canvas is Core or
//          backend):
//            - the LAYOUT-SURFACE PROVIDER Core asks while an object is dragged
//              or resized (snap pitch, page bounds, editable),
//            - the PAGE PAINTER (page, background, snap dots, page edge), one
//              grid layer at the bottom of the stack,
//            - the contextual "Canvas" RIBBON TAB,
//            - the canvas KEYBOARD: Tab / Shift+Tab step through the objects,
//              Escape and a press on the empty page deselect (through the
//              object-selection seam, never a synthetic mouse press),
//            - the store that keeps all three in step with the backend.
//
//          Core already knows the active sheet's SURFACE (it refuses cell
//          selection, editing and cell painting on a canvas), and the backend
//          refuses every cell write. This extension never touches cells.
//
//          Refresh triggers. The store re-reads `get_sheets` whenever the sheet
//          collection or the active sheet may have changed, and whenever a
//          layout was written by any route (CANVAS_LAYOUT_CHANGED, bridged
//          from the backend). SHEET_CHANGED's payload is not trusted -- its
//          shape differs between emitters and is empty on undo -- so the
//          backend's own active index is used instead.

import type { ExtensionContext, ExtensionModule } from "@api/contract";
import { AppEvents, onAppEvent, registerGridLayer, requestOverlayRedraw } from "@api";
import { notifyLayoutSurfaceChanged, registerLayoutSurfaceProvider } from "@api/layoutSurface";
import {
  getCanvasSheetSnapshot,
  refreshCanvasProvenance,
  refreshCanvasSheets,
  resetCanvasSheetStore,
  subscribeCanvasSheets,
} from "./lib/canvasSheetStore";
import { canvasLayoutSurfaceProvider } from "./lib/layoutSurfaceProvider";
import { paintCanvasPage } from "./lib/pagePainter";
import { resetCanvasTab, syncCanvasTab } from "./lib/canvasTab";
import { installCanvasObjectKeyboard } from "./lib/objectCycling";

/** The id of the page layer; one per app. */
export const CANVAS_PAGE_LAYER_ID = "canvas-sheet-page";

const cleanupFns: (() => void)[] = [];

function activate(_context: ExtensionContext): void {
  // Core asks this for every floating-object gesture; a worksheet answers null.
  cleanupFns.push(registerLayoutSurfaceProvider(canvasLayoutSurfaceProvider));

  // The page, painted beneath every object.
  cleanupFns.push(
    registerGridLayer({
      id: CANVAS_PAGE_LAYER_ID,
      anchor: "under-cells",
      priority: 0,
      paint: (context) => paintCanvasPage(context),
    }),
  );

  // Every store change: the tab follows the active sheet's kind, Core re-reads
  // the surface (snap, page extent), and the page repaints.
  cleanupFns.push(
    subscribeCanvasSheets(() => {
      syncCanvasTab(getCanvasSheetSnapshot().active !== null);
      notifyLayoutSurfaceChanged();
      requestOverlayRedraw();
    }),
  );

  const refresh = (): void => {
    void refreshCanvasSheets();
  };
  const refreshAll = (): void => {
    void refreshCanvasSheets();
    void refreshCanvasProvenance();
  };
  // SHEET_CHANGED re-reads provenance too: some detach routes (the
  // Subscription Manager's "Detach all") announce only a sheet change, and a
  // canvas that stayed marked subscribed would stay read-only after it.
  cleanupFns.push(onAppEvent(AppEvents.SHEET_CHANGED, refreshAll));
  for (const event of [
    AppEvents.SHEET_ADDED,
    AppEvents.SHEET_DELETED,
    AppEvents.SHEET_RENAMED,
    AppEvents.CANVAS_LAYOUT_CHANGED,
  ]) {
    cleanupFns.push(onAppEvent(event, refresh));
  }
  // A document swap or a pull/refresh/detach can change which sheets are
  // subscribed as well as which are canvases.
  for (const event of [AppEvents.AFTER_OPEN, AppEvents.AFTER_NEW, AppEvents.PACKAGE_UPDATED]) {
    cleanupFns.push(onAppEvent(event, refreshAll));
  }

  cleanupFns.push(...installCanvasObjectKeyboard(extension.manifest.id));

  cleanupFns.push(() => resetCanvasTab());
  cleanupFns.push(() => resetCanvasSheetStore());
  refreshAll();
}

function deactivate(): void {
  for (let i = cleanupFns.length - 1; i >= 0; i--) {
    try {
      cleanupFns[i]();
    } catch (err) {
      console.error("[CanvasSheet] cleanup failed:", err);
    }
  }
  cleanupFns.length = 0;
}

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.canvas-sheet",
    name: "Canvas Sheets",
    version: "1.0.0",
    description:
      "Canvas sheets: report pages that hold charts, slicers, shapes and floating grids on a fixed page with a snap grid",
  },
  activate,
  deactivate,
};

export default extension;
