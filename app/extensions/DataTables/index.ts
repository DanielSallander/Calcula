//! FILENAME: app/extensions/DataTables/index.ts
// PURPOSE: Data Tables extension entry point.
// CONTEXT: Registers the dialog and Data menu items for What-If Data Tables.

import {
  DialogExtensions,
  ExtensionRegistry,
} from "../../src/api";
import { DataTableDialog } from "./components/DataTableDialog";
import {
  registerDataTableMenuItems,
  setCurrentSelection,
} from "./handlers/dataMenuBuilder";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Registration
// ============================================================================

export function registerDataTablesExtension(): void {
  console.log("[DataTables] Registering...");

  DialogExtensions.registerDialog({
    id: "data-table",
    component: DataTableDialog,
    priority: 100,
  });
  cleanupFns.push(() => DialogExtensions.unregisterDialog("data-table"));

  registerDataTableMenuItems();

  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    setCurrentSelection(
      sel
        ? {
            activeRow: sel.startRow,
            activeCol: sel.startCol,
            endRow: sel.endRow,
            endCol: sel.endCol,
          }
        : null,
    );
  });
  cleanupFns.push(unsubSelection);

  console.log("[DataTables] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterDataTablesExtension(): void {
  console.log("[DataTables] Unregistering...");
  for (const fn of cleanupFns) {
    try { fn(); } catch (err) { console.error("[DataTables] Cleanup error:", err); }
  }
  cleanupFns.length = 0;
  console.log("[DataTables] Unregistered.");
}
