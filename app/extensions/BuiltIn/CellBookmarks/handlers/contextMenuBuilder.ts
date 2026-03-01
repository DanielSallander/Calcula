//! FILENAME: app/extensions/BuiltIn/CellBookmarks/handlers/contextMenuBuilder.ts
// PURPOSE: Registers bookmark items in the grid right-click context menu.
// CONTEXT: Adds context-aware "Add Bookmark" / "Remove Bookmark" / "Edit Bookmark" items.

import {
  gridExtensions,
  GridMenuGroups,
  showToast,
  showOverlay,
  type GridMenuContext,
} from "../../../../src/api";
import {
  addBookmark,
  removeBookmark,
  hasBookmarkAt,
} from "../lib/bookmarkStore";

const EDIT_OVERLAY_ID = "bookmark-editor";

/**
 * Register bookmark context menu items for the grid right-click menu.
 */
export function registerBookmarkContextMenuItems(): void {
  gridExtensions.registerContextMenuItems([
    {
      id: "bookmarks.context.add",
      label: "Add Bookmark",
      group: GridMenuGroups.EDIT,
      order: 90,
      visible: (context: GridMenuContext) => {
        const cell = context.clickedCell;
        if (!cell) return false;
        return !hasBookmarkAt(cell.row, cell.col, context.sheetIndex);
      },
      onClick: (context: GridMenuContext) => {
        const cell = context.clickedCell;
        if (!cell) return;
        const bookmark = addBookmark(cell.row, cell.col, context.sheetIndex, context.sheetName);
        showToast(`Bookmark added: ${bookmark.label}`, { variant: "success" });
      },
    },
    {
      id: "bookmarks.context.remove",
      label: "Remove Bookmark",
      group: GridMenuGroups.EDIT,
      order: 91,
      visible: (context: GridMenuContext) => {
        const cell = context.clickedCell;
        if (!cell) return false;
        return hasBookmarkAt(cell.row, cell.col, context.sheetIndex);
      },
      onClick: (context: GridMenuContext) => {
        const cell = context.clickedCell;
        if (!cell) return;
        removeBookmark(cell.row, cell.col, context.sheetIndex);
        showToast("Bookmark removed", { variant: "info" });
      },
    },
    {
      id: "bookmarks.context.edit",
      label: "Edit Bookmark...",
      group: GridMenuGroups.EDIT,
      order: 92,
      visible: (context: GridMenuContext) => {
        const cell = context.clickedCell;
        if (!cell) return false;
        return hasBookmarkAt(cell.row, cell.col, context.sheetIndex);
      },
      separatorAfter: true,
      onClick: (context: GridMenuContext) => {
        const cell = context.clickedCell;
        if (!cell) return;
        showOverlay(EDIT_OVERLAY_ID, {
          data: { row: cell.row, col: cell.col, sheetIndex: context.sheetIndex },
        });
      },
    },
  ]);
}
