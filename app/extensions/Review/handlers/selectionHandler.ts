//! FILENAME: app/extensions/Review/handlers/selectionHandler.ts
// PURPOSE: Selection change handler for the Review extension.
// CONTEXT: Tracks the active cell for keyboard shortcuts and menu actions.
//          Closes an open annotation editor when the selection leaves the cell
//          THAT EDITOR IS ANCHORED TO.

import { hideOverlay, OverlayExtensions } from "@api";
import type { Selection } from "@api";
import { setActiveCellForKeyboard } from "./keyboardHandler";
import { setCurrentSelectionForMenu } from "../handlers/reviewMenuBuilder";
import { hidePreview } from "./hoverHandler";

// ============================================================================
// Constants
// ============================================================================

/** The two overlays that edit an annotation, each anchored to one cell. */
const ANNOTATION_EDITOR_IDS = ["note-editor", "comment-panel"] as const;

// ============================================================================
// State
// ============================================================================

let previousCell: { row: number; col: number } | null = null;

// ============================================================================
// Internal
// ============================================================================

/**
 * The cell an annotation editor is currently showing, or null when it is not
 * open (or is open without a cell in its data, which no opener does).
 *
 * READ FROM THE OVERLAY'S OWN STATE rather than from a second copy kept here.
 * Every opener — the click interceptor, the context menu, the keyboard
 * shortcuts, the comments sidebar — already puts `row`/`col` in the overlay
 * data, so this cannot drift from what is on screen the way a local mirror
 * would on the first opener that forgets to update it.
 */
function editorAnchorCell(overlayId: string): { row: number; col: number } | null {
  let entry;
  try {
    entry = OverlayExtensions.getVisibleOverlays().find(
      (o) => o.definition.id === overlayId
    );
  } catch {
    return null;
  }
  if (!entry) return null;
  const data = entry.state?.data as { row?: unknown; col?: unknown } | undefined;
  if (typeof data?.row !== "number" || typeof data?.col !== "number") return null;
  return { row: data.row, col: data.col };
}

/**
 * Close any annotation editor that is no longer looking at the active cell.
 *
 * WHY THIS IS NOT "the selection changed, so close everything". The gesture
 * that OPENS a note editor is a click on the annotated cell, and that same
 * click also moves the selection onto that cell — the interceptor deliberately
 * returns false so the cell still selects, exactly as Excel does. A handler
 * that closed on any change therefore closed the editor the click had just
 * opened, one React commit later: the editor flashed and vanished, and clicking
 * a noted cell had no visible effect at all (BUG-0042). The comments sidebar's
 * "click a note to open it" hit the same wall, because it navigates to the
 * note's cell and then shows the editor.
 *
 * Comparing against the editor's OWN anchor cell is order-independent: whether
 * the selection lands before or after the overlay is shown, an editor anchored
 * to the active cell stays and one anchored elsewhere goes.
 */
function closeEditorsAnchoredAwayFrom(active: { row: number; col: number }): void {
  for (const id of ANNOTATION_EDITOR_IDS) {
    const anchor = editorAnchorCell(id);
    if (!anchor) continue;
    if (anchor.row !== active.row || anchor.col !== active.col) {
      hideOverlay(id);
    }
  }
}

// ============================================================================
// Handler
// ============================================================================

/**
 * Handle selection change events.
 * Updates the active cell tracking for keyboard shortcuts and menus,
 * and closes annotation editors the selection has moved away from.
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

  // The hover preview belongs to the cell the pointer was resting on; any move
  // of the selection invalidates it.
  if (
    previousCell &&
    (previousCell.row !== activeRow || previousCell.col !== activeCol)
  ) {
    hidePreview();
  }

  // Editors close per ANCHOR, not per change — see closeEditorsAnchoredAwayFrom.
  closeEditorsAnchoredAwayFrom(activeCell);

  previousCell = { row: activeRow, col: activeCol };
}

/** Test seam: forget the last selection this handler saw. */
export function resetSelectionHandlerState(): void {
  previousCell = null;
}
