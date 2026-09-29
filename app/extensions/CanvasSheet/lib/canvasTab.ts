//! FILENAME: app/extensions/CanvasSheet/lib/canvasTab.ts
// PURPOSE: Show the contextual "Canvas" ribbon tab exactly while a canvas sheet
//          is ON SCREEN.
// CONTEXT: The first contextual tab keyed on the SHEET rather than the
//          selection. Registered once on the way onto a canvas and unregistered
//          once on the way off: a canvas-to-canvas switch keeps the same
//          registration (its sections re-render from the store), so the ribbon
//          does not flash or lose the user's scroll in the tab strip. The panel
//          carries `ribbonActivateOnRegister`, so RibbonContainer selects it on
//          arrival and restores the previously selected tab on removal.
//
//          THE SHEET ON SCREEN, not only the active one. While a formula edit
//          picks a reference on another sheet (point mode) -- a floating grid's
//          cell edit PARKED on a worksheet, or Core's own edit viewing a sheet
//          other than its source -- the grid shows that sheet, but a point-mode
//          switch (core/lib/pointModeSheetSwitch.ts) announces no
//          SHEET_CHANGED, so the store (which re-reads on SHEET_CHANGED) still
//          names the canvas. The tab stayed up over a worksheet, offering page
//          size, snap and arrange for a page nobody could see (open-items 2.af,
//          "the Canvas tab stays up"). Core announces every flip of "the grid
//          shows a foreign sheet" through `onPointModeViewChanged`
//          (@api/gridOverlays); the tab listens to it and asks which sheet is
//          VIEWED: the parked session's view index, else Core's own view index.
//
//          A FLIP is not every move. That signal is edge-triggered, so a move
//          from one foreign sheet to ANOTHER (parked on a second canvas, then a
//          click on a worksheet; Core's edit from its worksheet to a canvas to
//          another worksheet) kept the tab as it was -- up over a worksheet, or
//          missing over a canvas (wave A review). Every MOVE is announced by
//          Core's `sheet:formulaModeSwitch`, dispatched by every point-mode
//          switch -- the parked session's (core/lib/pointModeSheetSwitch.ts),
//          SheetTabs' for Core's own edit, and useEditing's return to the
//          source -- with the index it put on screen. Its detail is read
//          directly: Core's snapshot lags that dispatch until the render. (A
//          parked view that ends WITHOUT a switch -- the host deleted under a
//          parked edit -- is a flip, which the edge-triggered signal covers.)

import { registerPanel, unregisterPanel } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { isPointModeOnForeignSheet, onPointModeViewChanged } from "@api/gridOverlays";
import { getParkedViewSheetIndex } from "@api/externalEdit";
import { CanvasPanelDefinition, CANVAS_TAB_ID } from "../components/CanvasTabSections";
import { canvasAt, getCanvasSheetSnapshot, subscribeCanvasSheets } from "./canvasSheetStore";

let registered = false;

/** Register or unregister the tab so it matches `activeIsCanvas`. Idempotent. */
export function syncCanvasTab(activeIsCanvas: boolean): void {
  if (activeIsCanvas && !registered) {
    registerPanel(CanvasPanelDefinition);
    registered = true;
  } else if (!activeIsCanvas && registered) {
    unregisterPanel(CANVAS_TAB_ID);
    registered = false;
  }
}

/**
 * The sheet the grid SHOWS while point mode is on a foreign sheet, or null
 * when it is not (the active sheet is then the one on screen). A parked
 * session knows its view index at the moment it parks -- before Core's
 * dispatch renders, so the snapshot would still name the host; Core's own
 * cross-sheet edit is announced after the render that made the snapshot
 * current, so its view index is the snapshot's.
 */
function pointModeViewIndex(): number | null {
  if (!isPointModeOnForeignSheet()) return null;
  const parked = getParkedViewSheetIndex();
  if (parked !== null) return parked;
  const viewed = getGridStateSnapshot()?.sheetContext?.activeSheetIndex;
  return typeof viewed === "number" ? viewed : null;
}

/** Whether the sheet on screen is a canvas. */
export function viewedSheetIsCanvas(): boolean {
  const viewed = pointModeViewIndex();
  if (viewed !== null) return canvasAt(viewed) !== null;
  return getCanvasSheetSnapshot().active !== null;
}

/** Sync the tab to the sheet on screen. */
export function syncCanvasTabToView(): void {
  syncCanvasTab(viewedSheetIsCanvas());
}

/**
 * Core's `sheet:formulaModeSwitch`: a point-mode switch put `newSheetIndex` on
 * screen. Read from the event, not the snapshot, which still names the sheet
 * before the switch until the render.
 */
function onFormulaModeSwitch(e: Event): void {
  const index = (e as CustomEvent<{ newSheetIndex?: unknown }>).detail?.newSheetIndex;
  if (typeof index === "number") syncCanvasTab(canvasAt(index) !== null);
  else syncCanvasTabToView();
}

/**
 * Keep the tab in step with the sheet on screen: every store change (the
 * active sheet, the sheet kinds), every point-mode view flip, and every
 * point-mode switch (a move between two foreign sheets is not a flip).
 * Returns the cleanup.
 */
export function installCanvasTabFollowsView(): () => void {
  const offStore = subscribeCanvasSheets(syncCanvasTabToView);
  const offPointMode = onPointModeViewChanged(() => syncCanvasTabToView());
  window.addEventListener("sheet:formulaModeSwitch", onFormulaModeSwitch);
  syncCanvasTabToView();
  return () => {
    window.removeEventListener("sheet:formulaModeSwitch", onFormulaModeSwitch);
    offPointMode();
    offStore();
  };
}

/** Whether the tab is currently registered (tests, diagnostics). */
export function isCanvasTabRegistered(): boolean {
  return registered;
}

/** Remove the tab if present (extension deactivate). */
export function resetCanvasTab(): void {
  syncCanvasTab(false);
}
