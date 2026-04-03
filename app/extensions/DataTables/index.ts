//! FILENAME: app/extensions/DataTables/index.ts
// PURPOSE: Data Tables extension entry point.
// CONTEXT: Registers the dialog and Data menu items for What-If Data Tables.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import { ExtensionRegistry } from "@api";
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
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[DataTables] Activating...");

  context.ui.dialogs.register({
    id: "data-table",
    component: DataTableDialog,
    priority: 100,
  });
  cleanupFns.push(() => context.ui.dialogs.unregister("data-table"));

  registerDataTableMenuItems(context);

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

  console.log("[DataTables] Activated successfully.");
}

function deactivate(): void {
  console.log("[DataTables] Deactivating...");
  for (const fn of cleanupFns) {
    try { fn(); } catch (err) { console.error("[DataTables] Cleanup error:", err); }
  }
  cleanupFns.length = 0;
  console.log("[DataTables] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.data-tables",
    name: "Data Tables",
    version: "1.0.0",
    description: "What-If Data Tables for sensitivity analysis.",
  },
  activate,
  deactivate,
};

export default extension;
