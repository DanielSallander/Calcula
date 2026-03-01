//! FILENAME: app/extensions/Review/lib/navigationHelper.ts
// PURPOSE: Navigate between comments/notes on the current sheet.
// CONTEXT: Used by Review menu "Next Comment" / "Previous Comment" actions.

import {
  emitAppEvent,
  AppEvents,
  showOverlay,
  getComment,
  getNote,
} from "../../../src/api";
import {
  getAllCommentIndicatorsCached,
  getAllNoteIndicatorsCached,
} from "./annotationStore";

// ============================================================================
// Types
// ============================================================================

interface CellPosition {
  row: number;
  col: number;
}

// ============================================================================
// State
// ============================================================================

let currentNavigationIndex = -1;

// ============================================================================
// Helpers
// ============================================================================

function sortByPosition(positions: CellPosition[]): CellPosition[] {
  return positions.sort((a, b) => a.row - b.row || a.col - b.col);
}

function findIndexAfter(
  sorted: CellPosition[],
  row: number,
  col: number
): number {
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].row > row || (sorted[i].row === row && sorted[i].col > col)) {
      return i;
    }
  }
  return 0; // Wrap around to first
}

function findIndexBefore(
  sorted: CellPosition[],
  row: number,
  col: number
): number {
  for (let i = sorted.length - 1; i >= 0; i--) {
    if (sorted[i].row < row || (sorted[i].row === row && sorted[i].col < col)) {
      return i;
    }
  }
  return sorted.length - 1; // Wrap around to last
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Navigate to the next comment after the current cell.
 */
export async function navigateNextComment(
  currentRow: number,
  currentCol: number
): Promise<void> {
  const indicators = getAllCommentIndicatorsCached();
  if (indicators.length === 0) return;

  const sorted = sortByPosition(
    indicators.map((i) => ({ row: i.row, col: i.col }))
  );

  const index = findIndexAfter(sorted, currentRow, currentCol);
  const target = sorted[index];

  emitAppEvent(AppEvents.NAVIGATE_TO_CELL, { row: target.row, col: target.col });

  const comment = await getComment(target.row, target.col);
  if (comment) {
    showOverlay("comment-panel", {
      data: {
        row: target.row,
        col: target.col,
        commentId: comment.id,
        mode: "edit",
      },
      anchorRect: { x: 0, y: 0, width: 0, height: 0 },
    });
  }
}

/**
 * Navigate to the previous comment before the current cell.
 */
export async function navigatePreviousComment(
  currentRow: number,
  currentCol: number
): Promise<void> {
  const indicators = getAllCommentIndicatorsCached();
  if (indicators.length === 0) return;

  const sorted = sortByPosition(
    indicators.map((i) => ({ row: i.row, col: i.col }))
  );

  const index = findIndexBefore(sorted, currentRow, currentCol);
  const target = sorted[index];

  emitAppEvent(AppEvents.NAVIGATE_TO_CELL, { row: target.row, col: target.col });

  const comment = await getComment(target.row, target.col);
  if (comment) {
    showOverlay("comment-panel", {
      data: {
        row: target.row,
        col: target.col,
        commentId: comment.id,
        mode: "edit",
      },
      anchorRect: { x: 0, y: 0, width: 0, height: 0 },
    });
  }
}

/**
 * Navigate to the next note after the current cell.
 */
export async function navigateNextNote(
  currentRow: number,
  currentCol: number
): Promise<void> {
  const indicators = getAllNoteIndicatorsCached();
  if (indicators.length === 0) return;

  const sorted = sortByPosition(
    indicators.map((i) => ({ row: i.row, col: i.col }))
  );

  const index = findIndexAfter(sorted, currentRow, currentCol);
  const target = sorted[index];

  emitAppEvent(AppEvents.NAVIGATE_TO_CELL, { row: target.row, col: target.col });

  const note = await getNote(target.row, target.col);
  if (note) {
    showOverlay("note-editor", {
      data: {
        row: target.row,
        col: target.col,
        noteId: note.id,
        mode: "edit",
      },
      anchorRect: { x: 0, y: 0, width: 0, height: 0 },
    });
  }
}
