//! FILENAME: app/extensions/Sparklines/handlers/selectionHandler.ts
// PURPOSE: Handles selection changes to show/hide the contextual Sparkline ribbon tab.
// CONTEXT: When the user selects a cell within a sparkline location range, we show the
//          "Sparkline" Design tab. When they move outside, we hide it.
//          Follows the same pattern as Pivot's selectionHandler.ts.

import { ExtensionRegistry } from "../../../src/api";
import { hasSparkline } from "../store";
import { SparklineDesignTabDefinition, SPARKLINE_DESIGN_TAB_ID } from "../manifest";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Whether the Design ribbon tab is currently registered. */
let designTabRegistered = false;

/** Track last checked selection to avoid redundant checks. */
let lastCheckedSelection: { row: number; col: number } | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the Design ribbon tab is registered.
 * Can be called externally (e.g., after creating a sparkline) to show the tab
 * immediately without waiting for the selection handler.
 */
export function ensureDesignTabRegistered(): void {
  if (!designTabRegistered) {
    ExtensionRegistry.registerRibbonTab(SparklineDesignTabDefinition);
    designTabRegistered = true;
  }
  // Clear cached selection so the handler re-evaluates on next move
  lastCheckedSelection = null;
}

/**
 * Handle selection change to show/hide the sparkline Design ribbon tab.
 * Called by the ExtensionRegistry.onSelectionChange subscription.
 */
export function handleSelectionChange(
  selection: { endRow: number; endCol: number } | null,
): void {
  if (!selection) return;

  const row = selection.endRow;
  const col = selection.endCol;

  // Skip if we already checked this exact cell
  if (
    lastCheckedSelection &&
    lastCheckedSelection.row === row &&
    lastCheckedSelection.col === col
  ) {
    return;
  }

  lastCheckedSelection = { row, col };

  const inSparkline = hasSparkline(row, col);

  if (inSparkline && !designTabRegistered) {
    ExtensionRegistry.registerRibbonTab(SparklineDesignTabDefinition);
    designTabRegistered = true;
  } else if (!inSparkline && designTabRegistered) {
    ExtensionRegistry.unregisterRibbonTab(SPARKLINE_DESIGN_TAB_ID);
    designTabRegistered = false;
  }
}

/**
 * Reset the selection handler state.
 * Called when the extension is unloaded.
 */
export function resetSelectionHandlerState(): void {
  lastCheckedSelection = null;
  if (designTabRegistered) {
    ExtensionRegistry.unregisterRibbonTab(SPARKLINE_DESIGN_TAB_ID);
    designTabRegistered = false;
  }
}
