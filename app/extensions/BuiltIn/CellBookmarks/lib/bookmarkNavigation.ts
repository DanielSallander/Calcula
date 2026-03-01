//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/bookmarkNavigation.ts
// PURPOSE: Navigation logic for cycling through bookmarks.
// CONTEXT: Implements Next/Previous bookmark navigation with cross-sheet support.

import {
  dispatchGridAction,
  scrollToCell,
  setSelection,
  setActiveSheet,
  setActiveSheetApi,
  emitAppEvent,
  AppEvents,
} from "../../../../src/api";
import { getGridStateSnapshot } from "../../../../src/api/grid";
import { getSortedBookmarks } from "./bookmarkStore";
import type { Bookmark } from "./bookmarkTypes";

// ============================================================================
// Navigation
// ============================================================================

/**
 * Navigate to a specific bookmark. Handles cross-sheet navigation.
 */
export function navigateToBookmark(bookmark: Bookmark): void {
  const state = getGridStateSnapshot();
  if (!state) return;

  const currentSheet = state.sheetContext.activeSheetIndex;

  // Switch sheet if needed
  if (bookmark.sheetIndex !== currentSheet) {
    setActiveSheetApi(bookmark.sheetIndex);
    dispatchGridAction(setActiveSheet(bookmark.sheetIndex, bookmark.sheetName));
    emitAppEvent(AppEvents.SHEET_CHANGED, { index: bookmark.sheetIndex, name: bookmark.sheetName });
  }

  // Select the bookmarked cell and scroll to it
  dispatchGridAction(setSelection(bookmark.row, bookmark.col, bookmark.row, bookmark.col));
  dispatchGridAction(scrollToCell(bookmark.row, bookmark.col, true));
}

/**
 * Navigate to the next bookmark after the current selection.
 * Wraps around to the first bookmark if at the end.
 * Returns the bookmark navigated to, or null if no bookmarks exist.
 */
export function navigateToNextBookmark(): Bookmark | null {
  const sorted = getSortedBookmarks();
  if (sorted.length === 0) return null;

  const state = getGridStateSnapshot();
  if (!state) return sorted[0];

  const currentSheet = state.sheetContext.activeSheetIndex;
  const currentRow = state.selection?.startRow ?? 0;
  const currentCol = state.selection?.startCol ?? 0;

  // Find the next bookmark after the current position
  const nextIndex = sorted.findIndex(
    (bm) =>
      bm.sheetIndex > currentSheet ||
      (bm.sheetIndex === currentSheet && bm.row > currentRow) ||
      (bm.sheetIndex === currentSheet && bm.row === currentRow && bm.col > currentCol)
  );

  // Wrap around if at the end
  const target = nextIndex >= 0 ? sorted[nextIndex] : sorted[0];
  navigateToBookmark(target);
  return target;
}

/**
 * Navigate to the previous bookmark before the current selection.
 * Wraps around to the last bookmark if at the beginning.
 * Returns the bookmark navigated to, or null if no bookmarks exist.
 */
export function navigateToPrevBookmark(): Bookmark | null {
  const sorted = getSortedBookmarks();
  if (sorted.length === 0) return null;

  const state = getGridStateSnapshot();
  if (!state) return sorted[sorted.length - 1];

  const currentSheet = state.sheetContext.activeSheetIndex;
  const currentRow = state.selection?.startRow ?? 0;
  const currentCol = state.selection?.startCol ?? 0;

  // Find the last bookmark before the current position (search in reverse)
  let prevIndex = -1;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const bm = sorted[i];
    if (
      bm.sheetIndex < currentSheet ||
      (bm.sheetIndex === currentSheet && bm.row < currentRow) ||
      (bm.sheetIndex === currentSheet && bm.row === currentRow && bm.col < currentCol)
    ) {
      prevIndex = i;
      break;
    }
  }

  // Wrap around if at the beginning
  const target = prevIndex >= 0 ? sorted[prevIndex] : sorted[sorted.length - 1];
  navigateToBookmark(target);
  return target;
}
