//! FILENAME: app/extensions/BuiltIn/CellBookmarks/handlers/contextMenuBuilder.ts
// PURPOSE: Registers bookmark items in the grid right-click context menu.
// CONTEXT: Adds context-aware "Add Bookmark" / "Remove Bookmark" / "Edit Bookmark" items.

import {
  gridExtensions,
  GridMenuGroups,
  showToast,
  showOverlay,
  type GridMenuContext,
} from "@api";
import {
  addBookmark,
  removeBookmark,
  hasBookmarkAt,
} from "../lib/bookmarkStore";

const EDIT_OVERLAY_ID = "bookmark-editor";

/** Every grid right-click item this module registers (and its cleanup removes). */
const CONTEXT_ITEM_IDS = ["bookmarks.context.add", "bookmarks.context.remove", "bookmarks.context.edit"] as const;

/**
 * Register bookmark context menu items for the grid right-click menu. Returns
 * the cleanup that removes them (a deactivated Cell Bookmarks kept offering
 * Add / Remove / Edit Bookmark; D3 review).
 */
export function registerBookmarkContextMenuItems(): () => void {
  gridExtensions.registerContextMenuItems([
    {
      id: CONTEXT_ITEM_IDS[0],
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
      id: CONTEXT_ITEM_IDS[1],
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
      id: CONTEXT_ITEM_IDS[2],
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
  return () => {
    for (const id of CONTEXT_ITEM_IDS) gridExtensions.unregisterContextMenuItem(id);
  };
}
