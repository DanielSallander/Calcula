//! FILENAME: app/extensions/Sorting/handlers/dataMenuBuilder.ts
// PURPOSE: Registers sort-related items in the Data menu.
// CONTEXT: Uses ExtensionContext to register menu items and show dialogs.

import type { ExtensionContext } from "@api/contract";
import {
  detectDataRegion,
  sortRangeByColumn,
} from "@api/lib";
import type { SortRangeResult } from "@api";
import { IconSortAZ, IconSortZA, IconCustomSort } from "@api";
import { alertAsync } from "@api/dialogs";
import { refuseIfSelectionOwned } from "@api/selectionOwner";

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
  // Sorts the data region around Core's active cell, which is HIDDEN while
  // something else owns the selection (a floating grid's selected cell):
  // refuse, once (D4, BUG-0185 class).
  if (refuseIfSelectionOwned(ascending ? "Sort A to Z" : "Sort Z to A")) return;
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
      if (result.error) void alertAsync(result.error);
    }
  } catch (err) {
    // sort_range rejects outright on a protected range, so a console-only
    // failure would make the A-Z / Z-A menu item look broken.
    console.error("[Sorting] Quick sort error:", err);
    const msg = typeof err === "string" ? err : (err as Error)?.message;
    if (msg) void alertAsync(msg);
  }
}

// ============================================================================
// Menu Registration
// ============================================================================

/**
 * Register sort items in the Data menu.
 * Assumes the "data" menu was already created by AutoFilter.
 *
 * Returns the cleanup for deactivation: it takes back this extension's OWN
 * items, never the shared Data menu (wave E, Y14).
 */
export function registerSortMenuItems(context: ExtensionContext): () => void {
  // Separator before sort items
  context.ui.menus.registerItem("data", {
    id: "data:sort:separator",
    label: "",
    separator: true,
  });

  // Sort A to Z (quick ascending)
  context.ui.menus.registerItem("data", {
    id: "data:sort:ascending",
    label: "Sort A to Z",
    icon: IconSortAZ,
    action: () => quickSort(true),
  });

  // Sort Z to A (quick descending)
  context.ui.menus.registerItem("data", {
    id: "data:sort:descending",
    label: "Sort Z to A",
    icon: IconSortZA,
    action: () => quickSort(false),
  });

  // Custom Sort (opens dialog)
  context.ui.menus.registerItem("data", {
    id: "data:sort:custom",
    label: "Custom Sort...",
    icon: IconCustomSort,
    action: () => {
      // The dialog sorts the region around Core's active cell: refuse while a
      // selection owner holds the selection (see quickSort).
      if (refuseIfSelectionOwned("Custom Sort")) return;
      const sel = currentSelection;
      context.ui.dialogs.show("sort-dialog", {
        activeRow: sel?.activeRow ?? 0,
        activeCol: sel?.activeCol ?? 0,
      });
    },
  });

  return () => {
    for (const id of ["data:sort:separator", "data:sort:ascending", "data:sort:descending", "data:sort:custom"]) {
      context.ui.menus.unregisterItem("data", id);
    }
  };
}
