//! FILENAME: app/extensions/BuiltIn/CellBookmarks/handlers/menuBuilder.ts
// PURPOSE: Registers bookmark-related items in the Insert menu.
// CONTEXT: Adds Insert > Bookmarks submenu with navigation and management commands.

import {
  registerMenuItem,
  showToast,
  openTaskPane,
} from "../../../../src/api";
import { getGridStateSnapshot } from "../../../../src/api/grid";
import {
  addBookmark,
  removeBookmark,
  hasBookmarkAt,
  removeAllBookmarks,
  toggleHighlight,
  getBookmarkCount,
} from "../lib/bookmarkStore";
import { navigateToNextBookmark, navigateToPrevBookmark } from "../lib/bookmarkNavigation";

const TASK_PANE_ID = "bookmarks-pane";

/**
 * Register bookmark menu items under the Insert menu.
 * Returns no cleanup because registerMenuItem does not return one.
 */
export function registerBookmarkMenuItems(): void {
  registerMenuItem("insert", {
    id: "insert.bookmarks",
    label: "Bookmarks",
    children: [
      {
        id: "insert.bookmarks.add",
        label: "Add Bookmark",
        shortcut: "Ctrl+Shift+B",
        action: () => {
          const state = getGridStateSnapshot();
          if (!state?.selection) return;
          const { startRow, startCol } = state.selection;
          const { activeSheetIndex, activeSheetName } = state.sheetContext;
          if (hasBookmarkAt(startRow, startCol)) {
            showToast("Cell already bookmarked", { variant: "warning" });
            return;
          }
          addBookmark(startRow, startCol, activeSheetIndex, activeSheetName);
          showToast("Bookmark added", { variant: "success" });
        },
      },
      {
        id: "insert.bookmarks.remove",
        label: "Remove Bookmark",
        action: () => {
          const state = getGridStateSnapshot();
          if (!state?.selection) return;
          const { startRow, startCol } = state.selection;
          const { activeSheetIndex } = state.sheetContext;
          if (removeBookmark(startRow, startCol, activeSheetIndex)) {
            showToast("Bookmark removed", { variant: "info" });
          }
        },
      },
      {
        id: "insert.bookmarks.separator1",
        label: "",
        separator: true,
      },
      {
        id: "insert.bookmarks.next",
        label: "Next Bookmark",
        shortcut: "Ctrl+]",
        action: () => {
          const target = navigateToNextBookmark();
          if (!target) {
            showToast("No bookmarks", { variant: "info" });
          }
        },
      },
      {
        id: "insert.bookmarks.prev",
        label: "Previous Bookmark",
        shortcut: "Ctrl+[",
        action: () => {
          const target = navigateToPrevBookmark();
          if (!target) {
            showToast("No bookmarks", { variant: "info" });
          }
        },
      },
      {
        id: "insert.bookmarks.separator2",
        label: "",
        separator: true,
      },
      {
        id: "insert.bookmarks.toggleHighlight",
        label: "Toggle Highlight",
        action: () => {
          const enabled = toggleHighlight();
          showToast(enabled ? "Bookmark highlighting on" : "Bookmark highlighting off", { variant: "info" });
        },
      },
      {
        id: "insert.bookmarks.removeAll",
        label: "Remove All Bookmarks",
        action: () => {
          const count = getBookmarkCount();
          if (count === 0) {
            showToast("No bookmarks to remove", { variant: "info" });
            return;
          }
          removeAllBookmarks();
          showToast(`Removed ${count} bookmark${count > 1 ? "s" : ""}`, { variant: "info" });
        },
      },
      {
        id: "insert.bookmarks.separator3",
        label: "",
        separator: true,
      },
      {
        id: "insert.bookmarks.showPanel",
        label: "Show Bookmarks Panel",
        action: () => {
          openTaskPane(TASK_PANE_ID);
        },
      },
    ],
  });
}
