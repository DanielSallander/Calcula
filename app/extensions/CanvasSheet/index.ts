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
//              Escape deselects (through the object-selection seam, never a
//              synthetic mouse press),
//            - the MARQUEE: a press on the empty page deselects, and a drag
//              from there selects every object the band touches, across
//              families (lib/marquee.ts),
//            - the SELECTION CHROME of the members the canvas-wide selection
//              set holds on a single-select family's behalf (a second chart),
//              painted in the families' own frame style (lib/selectionChrome.ts),
//            - the Name Box LABEL of the selection: the object's name, or "N
//              objects" (lib/objectLabel.ts),
//            - the STACKING RESOLVER: an object's z on the active canvas is its
//              ref's index in the layout's zOrder (lib/canvasStacking.ts), so
//              Core paints and hit-tests in the order the page saved,
//            - ARRANGE: bring forward / send backward (lib/zOrderStore.ts,
//              also the page's @api/objectStacking service), align and
//              distribute (lib/arrange.ts), lock (lib/canvasLocks.ts, asked by
//              Core through the layout surface), the cross-family GROUP DRAG
//              (lib/groupDrag.ts) and the arrow-key NUDGE (lib/objectNudge.ts)
//              -- every multi-object move through @api/objectGeometry, as ONE
//              undo step,
//            - the GRIP MENU's page verbs (Bring Forward, Send Backward,
//              Lock -- lib/gripMenuItems.ts, through @api/objectPosition) and
//              Arrange's "Size & Position" (the dialog every object menu
//              opens),
//            - DELETE, COPY, PASTE and DUPLICATE of the whole selection across
//              families (lib/canvasDelete.ts, lib/canvasClipboard.ts through
//              @api/objectClipboard), each one undo step,
//            - the store that keeps all of it in step with the backend.
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
import { registerRegionStacking } from "@api/gridOverlays";
import { clearSetHeldObjects, onObjectSelectionChanged } from "@api/objectSelection";
import {
  getCanvasSheetSnapshot,
  refreshCanvasProvenance,
  refreshCanvasSheets,
  resetCanvasSheetStore,
  subscribeCanvasSheets,
} from "./lib/canvasSheetStore";
import { canvasLayoutSurfaceProvider } from "./lib/layoutSurfaceProvider";
import { paintCanvasPage } from "./lib/pagePainter";
import { installCanvasTabFollowsView, resetCanvasTab } from "./lib/canvasTab";
import { installCanvasObjectKeyboard } from "./lib/objectCycling";
import { canvasRegionZ, resetCanvasStacking } from "./lib/canvasStacking";
import { CANVAS_MARQUEE_LAYER_ID, installCanvasMarquee, paintMarquee } from "./lib/marquee";
import { CANVAS_SELECTION_CHROME_LAYER_ID, paintSelectionChrome } from "./lib/selectionChrome";
import { installCanvasObjectLabel, publishCanvasObjectLabel } from "./lib/objectLabel";
import { registerObjectStackingService } from "@api/objectStacking";
import { canvasStackingService } from "./lib/stackingService";
import { installCanvasGroupDrag } from "./lib/groupDrag";
import { installCanvasObjectNudge } from "./lib/objectNudge";
import { installCanvasObjectDelete } from "./lib/canvasDelete";
import { installCanvasObjectClipboard } from "./lib/canvasClipboard";
import { installCanvasLayoutRefs } from "./lib/layoutRefs";
import { installCanvasGripMenuItems } from "./lib/gripMenuItems";

/** The id of the page layer; one per app. */
export const CANVAS_PAGE_LAYER_ID = "canvas-sheet-page";

const cleanupFns: (() => void)[] = [];

function activate(_context: ExtensionContext): void {
  // Core asks this for every floating-object gesture; a worksheet answers null.
  cleanupFns.push(registerLayoutSurfaceProvider(canvasLayoutSurfaceProvider));

  // Core's one z-order (paint AND every hit test) takes an object's z from its
  // position in the active canvas's zOrder; a worksheet has no opinion.
  cleanupFns.push(registerRegionStacking(canvasRegionZ));
  cleanupFns.push(() => resetCanvasStacking());

  // The page, painted beneath every object.
  cleanupFns.push(
    registerGridLayer({
      id: CANVAS_PAGE_LAYER_ID,
      anchor: "under-cells",
      priority: 0,
      paint: (context) => paintCanvasPage(context),
    }),
  );

  // Above every object and above Core's selection chrome: the lock mark of a
  // selected locked object (Core paints every selected object's outline and
  // handles itself, set-held members included -- BUG-0258 design phase 3),
  // then the marquee band.
  cleanupFns.push(
    registerGridLayer({
      id: CANVAS_SELECTION_CHROME_LAYER_ID,
      anchor: "over-selection",
      priority: 0,
      paint: (context) => paintSelectionChrome(context),
    }),
  );
  cleanupFns.push(
    registerGridLayer({
      id: CANVAS_MARQUEE_LAYER_ID,
      anchor: "over-selection",
      priority: 1,
      paint: (context) => paintMarquee(context),
    }),
  );
  cleanupFns.push(...installCanvasMarquee());

  // The set's own changes (a member held for a single-select family) repaint
  // the chrome; a family's own changes already repaint its objects.
  cleanupFns.push(onObjectSelectionChanged(() => requestOverlayRedraw()));
  cleanupFns.push(...installCanvasObjectLabel());

  // Every store change: Core re-reads the surface (snap, page extent), and
  // the page repaints -- and with it the
  // objects, in the zOrder the store now holds. This is the redraw a
  // CANVAS_LAYOUT_CHANGED gets: the event re-reads the layout below and the
  // redraw follows the refreshed store (a redraw on the bare event would
  // repaint the OLD order). A change of ACTIVE sheet also drops what the
  // selection set held on the page being left (each family clears its own).
  let lastActiveIndex = getCanvasSheetSnapshot().activeIndex;
  cleanupFns.push(
    subscribeCanvasSheets(() => {
      const snapshot = getCanvasSheetSnapshot();
      if (snapshot.activeIndex !== lastActiveIndex) {
        lastActiveIndex = snapshot.activeIndex;
        clearSetHeldObjects();
      }
      notifyLayoutSurfaceChanged();
      requestOverlayRedraw();
      publishCanvasObjectLabel();
    }),
  );

  // The contextual tab follows the sheet ON SCREEN: every store change, and
  // every point-mode view flip (a formula edit picking a reference on another
  // sheet announces no SHEET_CHANGED; lib/canvasTab.ts).
  cleanupFns.push(installCanvasTabFollowsView());

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

  // ARRANGE. A family's own restack command (Controls' "Order" submenu) asks
  // the page first: on a canvas the layout's zOrder is THE order.
  cleanupFns.push(registerObjectStackingService(canvasStackingService));
  // Dragging one member of a multi-selection moves the others -- across
  // families -- as ONE undo step (lib/groupDrag.ts).
  cleanupFns.push(...installCanvasGroupDrag());
  // The arrow keys nudge the selection; a burst is one undo step.
  cleanupFns.push(...installCanvasObjectNudge(extension.manifest.id));
  // Delete / Backspace on a multi-selection delete every selected object, as
  // one undo step (lib/canvasDelete.ts).
  cleanupFns.push(...installCanvasObjectDelete(extension.manifest.id));
  // Ctrl+C / Ctrl+V / Ctrl+D copy, paste and duplicate every selected object,
  // across families, through the object clipboard -- a paste or duplicate of
  // several is one undo step (lib/canvasClipboard.ts).
  cleanupFns.push(...installCanvasObjectClipboard(extension.manifest.id));
  // The identities the layout still names (locked / zOrder, live or dead):
  // a family that RECYCLES ids (Controls' anchors) never hands a new object
  // a dead one's lock and paint slot (lib/layoutRefs.ts).
  cleanupFns.push(installCanvasLayoutRefs());
  // The grip's menu (BUG-0258 phase 5b): under its "Size and Position...",
  // Bring Forward, Send Backward and Lock for the object whose grip was
  // clicked -- the Arrange group's own commands (lib/gripMenuItems.ts).
  cleanupFns.push(...installCanvasGripMenuItems());

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
