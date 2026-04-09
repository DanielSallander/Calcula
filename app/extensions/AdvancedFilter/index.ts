//! FILENAME: app/extensions/AdvancedFilter/index.ts
// PURPOSE: Advanced Filter extension entry point. Registers/unregisters all components.
// CONTEXT: Excel-style Advanced Filter with criteria range, copy-to, and unique records.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  registerDialog,
  unregisterDialog,
  showDialog,
  registerMenuItem,
  ExtensionRegistry,
  detectDataRegion,
  IconAdvancedFilter,
} from "@api";
import { AdvancedFilterDialog } from "./components/AdvancedFilterDialog";
import { formatRangeRef } from "./lib/advancedFilterEngine";
import type { AdvancedFilterDialogData } from "./types";

// ============================================================================
// Constants
// ============================================================================

const DIALOG_ID = "advanced-filter-dialog";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];

// ============================================================================
// Selection tracking
// ============================================================================

interface Selection {
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

let currentSelection: Selection | null = null;

// ============================================================================
// Open Dialog
// ============================================================================

async function openAdvancedFilterDialog(): Promise<void> {
  const dialogData: AdvancedFilterDialogData = {};

  // Try to pre-fill list range from current selection or detected data region
  if (currentSelection) {
    const sel = currentSelection;
    const isSingleCell = sel.startRow === sel.endRow && sel.startCol === sel.endCol;

    if (isSingleCell) {
      // Detect data region around the selected cell
      const region = await detectDataRegion(sel.startRow, sel.startCol);
      if (region) {
        dialogData.listRange = formatRangeRef(region[0], region[1], region[2], region[3]);
      }
    } else {
      // Use the selected range
      dialogData.listRange = formatRangeRef(sel.startRow, sel.startCol, sel.endRow, sel.endCol);
    }
  }

  showDialog(DIALOG_ID, dialogData as unknown as Record<string, unknown>);
}

// ============================================================================
// Lifecycle
// ============================================================================

function activate(_context: ExtensionContext): void {
  console.log("[AdvancedFilter] Activating...");

  // 1. Register dialog
  registerDialog({
    id: DIALOG_ID,
    component: AdvancedFilterDialog,
    priority: 50,
  });
  cleanupFns.push(() => unregisterDialog(DIALOG_ID));

  // 2. Track selection for pre-filling dialog
  const unsubSelection = ExtensionRegistry.onSelectionChange((sel) => {
    currentSelection = sel
      ? {
          startRow: Math.min(sel.startRow, sel.endRow),
          startCol: Math.min(sel.startCol, sel.endCol),
          endRow: Math.max(sel.startRow, sel.endRow),
          endCol: Math.max(sel.startCol, sel.endCol),
        }
      : null;
  });
  cleanupFns.push(unsubSelection);

  // 3. Register menu item in the Data menu
  registerMenuItem("data", {
    id: "data:advancedFilter",
    label: "Advanced...",
    icon: IconAdvancedFilter,
    action: () => openAdvancedFilterDialog(),
  });

  console.log("[AdvancedFilter] Activated successfully.");
}

function deactivate(): void {
  console.log("[AdvancedFilter] Deactivating...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[AdvancedFilter] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
  currentSelection = null;

  console.log("[AdvancedFilter] Deactivated.");
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.advanced-filter",
    name: "Advanced Filter",
    version: "1.0.0",
    description: "Excel-style Advanced Filter with criteria range, copy-to, and unique records.",
  },
  activate,
  deactivate,
};
export default extension;
