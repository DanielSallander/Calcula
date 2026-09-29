//! FILENAME: app/extensions/Sparklines/handlers/selectionHandler.ts
// PURPOSE: Handles selection changes to show/hide the contextual Sparkline panel.
// CONTEXT: When the user selects a cell within a sparkline location range, we show the
//          "Sparkline" design panel (ribbon-placed by default). When they move outside,
//          we hide it. Follows the same pattern as Pivot's selectionHandler.ts.

import { registerPanel, unregisterPanel } from "@api/ui";
import { getGridStateSnapshot } from "@api/grid";
import { isSelectionOwned } from "@api/selectionOwner";
import { hasSparkline } from "../store";
import { SparklineDesignPanelDefinition, SPARKLINE_DESIGN_TAB_ID } from "../manifest";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Whether the design panel is currently registered. */
let designTabRegistered = false;

/** Track last checked selection to avoid redundant checks. */
let lastCheckedSelection: { row: number; col: number } | null = null;

/** The last active cell Core announced to this handler. Unlike the dedupe
 *  cache above, ensureDesignTabRegistered never clears it. */
let lastCoreCell: { row: number; col: number } | null = null;

/**
 * Core's active cell NOW: the grid's own state, else the last cell Core
 * announced here. Never the dedupe cache alone -- a create clears that
 * (ensureDesignTabRegistered), and an extension activated after Core's
 * selection was set never filled it (wave C review of W22).
 */
function coreActiveCell(): { row: number; col: number } | null {
  const sel = getGridStateSnapshot()?.selection;
  if (sel) return { row: sel.endRow, col: sel.endCol };
  return lastCoreCell;
}

/**
 * Show or hide the design panel. Shown for a sparkline under Core's ACTIVE
 * cell -- never while something else owns the selection (a floating grid's
 * selected cell, @api/selectionOwner): that cell is hidden under the owner,
 * and the tab's buttons would act on a group nobody can see (W22).
 */
function showDesignTab(show: boolean): void {
  if (show && !isSelectionOwned()) {
    if (!designTabRegistered) {
      registerPanel(SparklineDesignPanelDefinition);
      designTabRegistered = true;
    }
  } else if (designTabRegistered) {
    unregisterPanel(SPARKLINE_DESIGN_TAB_ID);
    designTabRegistered = false;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the design panel is registered.
 * Can be called externally (e.g., after creating a sparkline) to show the panel
 * immediately without waiting for the selection handler.
 */
export function ensureDesignTabRegistered(): void {
  showDesignTab(true);
  // Clear cached selection so the handler re-evaluates on next move
  lastCheckedSelection = null;
}

/**
 * Handle selection change to show/hide the sparkline design panel.
 * Called by the ExtensionRegistry.onSelectionChange subscription.
 */
export function handleSelectionChange(
  selection: { endRow: number; endCol: number } | null,
): void {
  if (!selection) return;

  const row = selection.endRow;
  const col = selection.endCol;
  lastCoreCell = { row, col };

  // Skip if we already checked this exact cell
  if (
    lastCheckedSelection &&
    lastCheckedSelection.row === row &&
    lastCheckedSelection.col === col
  ) {
    return;
  }

  lastCheckedSelection = { row, col };

  showDesignTab(hasSparkline(row, col));
}

/**
 * Re-derive the design panel after a selection owner's claim started or ended
 * (@api/selectionOwner onSelectionOwnershipChanged): Core's selection did not
 * move, so the handler was never asked -- ask it again for Core's active cell
 * (W22). Not for the cell it checked last: a create empties that cache, so a
 * tab a create had shown stayed hidden after the claim ended (wave C review).
 */
export function syncDesignTabToSelectionOwner(): void {
  const cell = coreActiveCell();
  lastCheckedSelection = null;
  if (cell) {
    handleSelectionChange({ endRow: cell.row, endCol: cell.col });
  } else if (isSelectionOwned()) {
    showDesignTab(false);
  }
}

/**
 * Reset the selection handler state.
 * Called when the extension is unloaded.
 */
export function resetSelectionHandlerState(): void {
  lastCheckedSelection = null;
  lastCoreCell = null;
  if (designTabRegistered) {
    unregisterPanel(SPARKLINE_DESIGN_TAB_ID);
    designTabRegistered = false;
  }
}
