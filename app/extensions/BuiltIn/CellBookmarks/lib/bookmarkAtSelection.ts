//! FILENAME: app/extensions/BuiltIn/CellBookmarks/lib/bookmarkAtSelection.ts
// PURPOSE: The bookmark actions that act on Core's ACTIVE CELL -- add, toggle,
//          remove, edit -- ONCE, for every door: the Insert > Bookmarks menu,
//          the bookmarks.* commands (the keybinding registry's Ctrl+Shift+B
//          runs bookmarks.toggle), and scripts that execute them.
// CONTEXT: D4 (BUG-0185 class). While something other than Core's grid owns
//          the selection -- a floating grid's selected cell -- Core's selection
//          is a cell HIDDEN under it, and Add Bookmark bookmarked THAT cell.
//          Each action asks @api/selectionOwner first and refuses with one
//          toast. The menu used to carry its own copy of add/remove; one copy
//          per door is how a door misses a check.
//          The grid context menu is NOT routed here: it acts on the cell the
//          user right-clicked, which is explicit and visible.

import { showToast, showOverlay } from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { refuseIfSelectionOwned } from "@api/selectionOwner";
import { addBookmark, removeBookmark, hasBookmarkAt } from "./bookmarkStore";

/** The cell bookmark editor overlay (registered by index.ts). */
export const BOOKMARK_EDIT_OVERLAY_ID = "bookmark-editor";

interface ActiveCell {
  row: number;
  col: number;
  sheetIndex: number;
  sheetName: string;
}

/** Core's active cell, or null when there is no selection. */
function activeCell(): ActiveCell | null {
  const state = getGridStateSnapshot();
  if (!state?.selection) return null;
  return {
    row: state.selection.startRow,
    col: state.selection.startCol,
    sheetIndex: state.sheetContext.activeSheetIndex,
    sheetName: state.sheetContext.activeSheetName,
  };
}

/** Add a bookmark on the active cell (warns when it already has one). */
export function addBookmarkAtSelection(): void {
  if (refuseIfSelectionOwned("Add Bookmark")) return;
  const cell = activeCell();
  if (!cell) return;
  if (hasBookmarkAt(cell.row, cell.col)) {
    showToast("Cell already bookmarked", { variant: "warning" });
    return;
  }
  addBookmark(cell.row, cell.col, cell.sheetIndex, cell.sheetName);
  showToast("Bookmark added", { variant: "success" });
}

/** Add or remove the bookmark on the active cell. */
export function toggleBookmarkAtSelection(): void {
  if (refuseIfSelectionOwned("Toggle Bookmark")) return;
  const cell = activeCell();
  if (!cell) return;
  if (hasBookmarkAt(cell.row, cell.col)) {
    removeBookmark(cell.row, cell.col, cell.sheetIndex);
    showToast("Bookmark removed", { variant: "info" });
  } else {
    addBookmark(cell.row, cell.col, cell.sheetIndex, cell.sheetName);
    showToast("Bookmark added", { variant: "success" });
  }
}

/** Remove the bookmark on the active cell, if it has one. */
export function removeBookmarkAtSelection(): void {
  if (refuseIfSelectionOwned("Remove Bookmark")) return;
  const cell = activeCell();
  if (!cell) return;
  if (removeBookmark(cell.row, cell.col, cell.sheetIndex)) {
    showToast("Bookmark removed", { variant: "info" });
  }
}

/** Open the bookmark editor on the active cell. */
export function editBookmarkAtSelection(): void {
  if (refuseIfSelectionOwned("Edit Bookmark")) return;
  const cell = activeCell();
  if (!cell) return;
  showOverlay(BOOKMARK_EDIT_OVERLAY_ID, {
    data: { row: cell.row, col: cell.col, sheetIndex: cell.sheetIndex },
  });
}
