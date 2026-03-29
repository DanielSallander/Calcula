//! FILENAME: app/extensions/AdvancedFilter/index.ts
// PURPOSE: Advanced Filter extension entry point. Registers/unregisters all components.
// CONTEXT: Excel-style Advanced Filter with criteria range, copy-to, and unique records.

import {
  registerDialog,
  unregisterDialog,
  showDialog,
  registerMenuItem,
  ExtensionRegistry,
  detectDataRegion,
  indexToCol,
} from "../../src/api";
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
// Registration
// ============================================================================

export function registerAdvancedFilterExtension(): void {
  console.log("[AdvancedFilter] Registering...");

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
    action: () => openAdvancedFilterDialog(),
  });

  console.log("[AdvancedFilter] Registered successfully.");
}

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
// Unregistration
// ============================================================================

export function unregisterAdvancedFilterExtension(): void {
  console.log("[AdvancedFilter] Unregistering...");

  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[AdvancedFilter] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;
  currentSelection = null;

  console.log("[AdvancedFilter] Unregistered.");
}
