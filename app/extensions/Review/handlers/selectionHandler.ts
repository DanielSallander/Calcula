//! FILENAME: app/extensions/Review/handlers/selectionHandler.ts
// PURPOSE: Selection change handler for the Review extension.
// CONTEXT: Tracks the active cell for keyboard shortcuts and menu actions.
//          Closes open overlays when selection moves to a different cell.

import { hideOverlay } from "../../../src/api";
import type { Selection } from "../../../src/api";
import { setActiveCellForKeyboard } from "./keyboardHandler";
import { setCurrentSelectionForMenu } from "../handlers/reviewMenuBuilder";
import { hidePreview } from "./hoverHandler";

// ============================================================================
// State
// ============================================================================

let previousCell: { row: number; col: number } | null = null;

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle selection change events.
 * Updates the active cell tracking for keyboard shortcuts and menus,
 * and closes open annotation overlays when the selection moves.
 */
export function handleSelectionChange(
  selection: Selection | null
): void {
  if (!selection) {
    previousCell = null;
    setActiveCellForKeyboard(null);
    setCurrentSelectionForMenu(null);
    return;
  }

  // Determine the active cell (the end of the selection range)
  const activeRow = selection.endRow;
  const activeCol = selection.endCol;
  const activeCell = { row: activeRow, col: activeCol };

  // Update keyboard and menu tracking
  setActiveCellForKeyboard(activeCell);
  setCurrentSelectionForMenu(activeCell);

  // If selection moved to a different cell, close open overlays
  if (
    previousCell &&
    (previousCell.row !== activeRow || previousCell.col !== activeCol)
  ) {
    // Hide hover preview
    hidePreview();

    // Close open editors (they handle their own save-on-close)
    hideOverlay("note-editor");
    hideOverlay("comment-panel");
  }

  previousCell = { row: activeRow, col: activeCol };
}
