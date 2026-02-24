//! FILENAME: app/extensions/Sorting/handlers/dataMenuBuilder.ts
// PURPOSE: Registers sort-related items in the Data menu.
// CONTEXT: Uses registerMenuItem to append to the existing "data" menu.

import { registerMenuItem, DialogExtensions } from "../../../src/api";
import {
  detectDataRegion,
  sortRangeByColumn,
} from "../../../src/api/lib";
import type { SortRangeResult } from "../../../src/core/types";

// ============================================================================
// State
// ============================================================================

let currentSelection: {
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  activeRow: number;
  activeCol: number;
} | null = null;

export function setCurrentSelection(
  sel: {
    startRow: number;
    endRow: number;
    startCol: number;
    endCol: number;
    activeRow: number;
    activeCol: number;
  } | null,
): void {
  currentSelection = sel;
}

// ============================================================================
// Quick Sort Helpers
// ============================================================================

/**
 * Perform a quick single-column sort (A-Z or Z-A).
 * Auto-detects the data region from the active cell.
 */
async function quickSort(ascending: boolean): Promise<void> {
  const sel = currentSelection;
  if (!sel) return;

  try {
    // Use active cell position to detect data region
    const region = await detectDataRegion(sel.activeRow, sel.activeCol);
    if (!region) {
      console.warn("[Sorting] No data region detected for quick sort.");
      return;
    }

    const [startRow, startCol, endRow, endCol] = region;

    // Sort by the column the cursor is in, assume headers
    const result = await sortRangeByColumn<SortRangeResult>(
      startRow,
      startCol,
      endRow,
      endCol,
      sel.activeCol,
      ascending,
      true, // hasHeaders
    );

    if (result.success) {
      window.dispatchEvent(new CustomEvent("grid:refresh"));
    } else {
      console.error("[Sorting] Quick sort failed:", result.error);
    }
  } catch (err) {
    console.error("[Sorting] Quick sort error:", err);
  }
}

// ============================================================================
// Menu Registration
// ============================================================================

/**
 * Register sort items in the Data menu.
 * Assumes the "data" menu was already created by AutoFilter.
 */
export function registerSortMenuItems(): void {
  // Separator before sort items
  registerMenuItem("data", {
    id: "data:sort:separator",
    label: "",
    separator: true,
  });

  // Sort A to Z (quick ascending)
  registerMenuItem("data", {
    id: "data:sort:ascending",
    label: "Sort A to Z",
    action: () => quickSort(true),
  });

  // Sort Z to A (quick descending)
  registerMenuItem("data", {
    id: "data:sort:descending",
    label: "Sort Z to A",
    action: () => quickSort(false),
  });

  // Custom Sort (opens dialog)
  registerMenuItem("data", {
    id: "data:sort:custom",
    label: "Custom Sort...",
    action: () => {
      const sel = currentSelection;
      DialogExtensions.openDialog("sort-dialog", {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
      });
    },
  });
}
