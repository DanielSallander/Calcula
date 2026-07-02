//! FILENAME: app/extensions/Sparklines/handlers/selectionHandler.ts
// PURPOSE: Handles selection changes to show/hide the contextual Sparkline panel.
// CONTEXT: When the user selects a cell within a sparkline location range, we show the
//          "Sparkline" design panel (ribbon-placed by default). When they move outside,
//          we hide it. Follows the same pattern as Pivot's selectionHandler.ts.

import { registerPanel, unregisterPanel } from "@api/ui";
import { hasSparkline } from "../store";
import { SparklineDesignPanelDefinition, SPARKLINE_DESIGN_TAB_ID } from "../manifest";

// ---------------------------------------------------------------------------
// Module-level state
// ---------------------------------------------------------------------------

/** Whether the design panel is currently registered. */
let designTabRegistered = false;

/** Track last checked selection to avoid redundant checks. */
let lastCheckedSelection: { row: number; col: number } | null = null;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Ensure the design panel is registered.
 * Can be called externally (e.g., after creating a sparkline) to show the panel
 * immediately without waiting for the selection handler.
 */
export function ensureDesignTabRegistered(): void {
  if (!designTabRegistered) {
    registerPanel(SparklineDesignPanelDefinition);
    designTabRegistered = true;
  }
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
    registerPanel(SparklineDesignPanelDefinition);
    designTabRegistered = true;
  } else if (!inSparkline && designTabRegistered) {
    unregisterPanel(SPARKLINE_DESIGN_TAB_ID);
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
    unregisterPanel(SPARKLINE_DESIGN_TAB_ID);
    designTabRegistered = false;
  }
}
