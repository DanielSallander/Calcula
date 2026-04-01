//! FILENAME: app/extensions/WatchWindow/index.ts
// PURPOSE: Watch Window extension entry point.
// CONTEXT: Monitors specific cell values while working elsewhere in the workbook.
//          Registers dialog, Formulas menu item, and grid context menu.

import {
  DialogExtensions,
  onAppEvent,
  AppEvents,
} from "../../src/api";
import { WatchWindowDialog } from "./components/WatchWindowDialog";
import {
  registerWatchWindowMenuItem,
  registerWatchWindowContextMenu,
} from "./handlers/menuBuilder";
import { refreshWatches, reset } from "./lib/watchStore";

// ============================================================================
// Constants
// ============================================================================

const DIALOG_ID = "watch-window";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerWatchWindowExtension(): void {
  console.log("[WatchWindow] Registering...");

  // 1. Register the dialog
  DialogExtensions.registerDialog({
    id: DIALOG_ID,
    component: WatchWindowDialog,
    priority: 55,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog(DIALOG_ID));

  // 2. Register Formulas menu item
  registerWatchWindowMenuItem();

  // 3. Register grid context menu items
  registerWatchWindowContextMenu();

  // 4. Refresh watches on data changes (even when dialog is closed)
  const unsubData = onAppEvent(AppEvents.DATA_CHANGED, () => {
    refreshWatches();
  });
  cleanupFns.push(unsubData);

  const unsubCells = onAppEvent(AppEvents.CELLS_UPDATED, () => {
    refreshWatches();
  });
  cleanupFns.push(unsubCells);

  console.log("[WatchWindow] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterWatchWindowExtension(): void {
  console.log("[WatchWindow] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[WatchWindow] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
  reset();

  console.log("[WatchWindow] Unregistered.");
}
