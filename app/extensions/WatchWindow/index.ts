//! FILENAME: app/extensions/WatchWindow/index.ts
// PURPOSE: Watch Window extension entry point.
// CONTEXT: Monitors specific cell values while working elsewhere in the workbook.
//          Registers dialog, Formulas menu item, and grid context menu.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { AppEvents } from "@api";
import { WatchWindowDialog } from "./components/WatchWindowDialog";
import {
  registerWatchWindowMenuItem,
  registerWatchWindowContextMenu,
} from "./handlers/menuBuilder";
import { applySheetRenumbering, applyStructuralStep, refreshWatches, reset } from "./lib/watchStore";
import { followSheetRenumbering, followStructuralEdits } from "@api/structuralFollow";

// ============================================================================
// Constants
// ============================================================================

const DIALOG_ID = "watch-window";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[WatchWindow] Activating...");

  // 1. Register the dialog
  context.ui.dialogs.register({
    id: DIALOG_ID,
    component: WatchWindowDialog,
    priority: 55,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister(DIALOG_ID));

  // 2. Register Formulas menu item
  cleanupFns.push(registerWatchWindowMenuItem());

  // 3. Register grid context menu items
  cleanupFns.push(registerWatchWindowContextMenu());

  // 4. Refresh watches on data changes (even when dialog is closed)
  const unsubData = context.events.on(AppEvents.DATA_CHANGED, () => {
    refreshWatches();
  });
  cleanupFns.push(unsubData);

  const unsubCells = context.events.on(AppEvents.CELLS_UPDATED, () => {
    refreshWatches();
  });
  cleanupFns.push(unsubCells);

  // 5. Watches follow inserted and deleted rows and columns, Insert / Delete
  //    Cells and cut-pasted cells on every sheet, and their undo and redo
  //    (BUG-0614; see applyStructuralStep).
  cleanupFns.push(
    followStructuralEdits(
      (step) => {
        if (applyStructuralStep(step)) void refreshWatches();
      },
      { subscribe: (eventName, cb) => context.events.on(eventName, cb), moves: true },
    ),
  );

  // 6. Watches follow their SHEET: renumbered at once when sheets are moved,
  //    inserted or deleted, then re-checked by the sheet's stable id (a watch
  //    on a deleted sheet goes, as Excel's does).
  cleanupFns.push(
    followSheetRenumbering((renumber) => {
      if (applySheetRenumbering(renumber)) void refreshWatches();
    }),
  );
  for (const eventName of [AppEvents.SHEET_ADDED, AppEvents.SHEET_DELETED, AppEvents.SHEET_RENAMED]) {
    cleanupFns.push(context.events.on(eventName, () => void refreshWatches()));
  }

  console.log("[WatchWindow] Activated successfully.");
}

function deactivate(): void {
  console.log("[WatchWindow] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[WatchWindow] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
  reset();

  console.log("[WatchWindow] Deactivated.");
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.watch-window",
    name: "Watch Window",
    version: "1.0.0",
    description: "Monitors specific cell values while working elsewhere in the workbook.",
  },
  activate,
  deactivate,
};
export default extension;
