//! FILENAME: app/extensions/CanvasSheet/lib/canvasTab.ts
// PURPOSE: Show the contextual "Canvas" ribbon tab exactly while a canvas sheet
//          is active.
// CONTEXT: The first contextual tab keyed on the SHEET rather than the
//          selection. Registered once on the way onto a canvas and unregistered
//          once on the way off: a canvas-to-canvas switch keeps the same
//          registration (its sections re-render from the store), so the ribbon
//          does not flash or lose the user's scroll in the tab strip. The panel
//          carries `ribbonActivateOnRegister`, so RibbonContainer selects it on
//          arrival and restores the previously selected tab on removal.

import { registerPanel, unregisterPanel } from "@api";
import { CanvasPanelDefinition, CANVAS_TAB_ID } from "../components/CanvasTabSections";

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

/** Whether the tab is currently registered (tests, diagnostics). */
export function isCanvasTabRegistered(): boolean {
  return registered;
}

/** Remove the tab if present (extension deactivate). */
export function resetCanvasTab(): void {
  syncCanvasTab(false);
}
