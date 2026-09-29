//! FILENAME: app/extensions/BuiltIn/CellBookmarks/handlers/menuBuilder.ts
// PURPOSE: Registers bookmark-related items in the Insert menu.
// CONTEXT: Adds Insert > Bookmarks submenu with navigation and management commands.

import {
  registerMenuItem,
  unregisterMenuItem,
  showToast,
  showOverlay,
  openTaskPane,
  IconBookmarks,
  IconBookmarkAdd,
  IconBookmarkRemove,
  IconNext,
  IconPrev,
  IconSave,
  IconHighlight,
  IconDeleteAll,
} from "@api";
import {
  removeAllBookmarks,
  toggleHighlight,
  getBookmarkCount,
} from "../lib/bookmarkStore";
import { navigateToNextBookmark, navigateToPrevBookmark } from "../lib/bookmarkNavigation";
import { addBookmarkAtSelection, removeBookmarkAtSelection } from "../lib/bookmarkAtSelection";

const TASK_PANE_ID = "bookmarks-pane";
const VIEW_BOOKMARK_CREATE_OVERLAY_ID = "view-bookmark-creator";

/** The Insert menu item that holds every bookmark item (its submenu). */
const INSERT_BOOKMARKS_ITEM_ID = "insert.bookmarks";

/**
 * Register bookmark menu items under the Insert menu. Returns the cleanup that
 * removes them: registerMenuItem returns none, and without one a DEACTIVATED
 * Cell Bookmarks kept Insert > Bookmarks, whose Add Bookmark still wrote to a
 * store nothing painted or persisted any more (D3 review).
 */
export function registerBookmarkMenuItems(): () => void {
  registerMenuItem("insert", {
    id: INSERT_BOOKMARKS_ITEM_ID,
    label: "Bookmarks",
    icon: IconBookmarks,
    children: [
      {
        id: "insert.bookmarks.add",
        label: "Add Bookmark",
        icon: IconBookmarkAdd,
        shortcut: "Ctrl+Shift+B",
        // The same action as the bookmarks.add command: it refuses while a
        // selection owner holds the selection (lib/bookmarkAtSelection.ts).
        action: addBookmarkAtSelection,
      },
      {
        id: "insert.bookmarks.remove",
        label: "Remove Bookmark",
        icon: IconBookmarkRemove,
        action: removeBookmarkAtSelection,
      },
      {
        id: "insert.bookmarks.separator1",
        label: "",
        separator: true,
      },
      {
        id: "insert.bookmarks.next",
        label: "Next Bookmark",
        icon: IconNext,
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
        icon: IconPrev,
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
        icon: IconHighlight,
        action: () => {
          const enabled = toggleHighlight();
          showToast(enabled ? "Bookmark highlighting on" : "Bookmark highlighting off", { variant: "info" });
        },
      },
      {
        id: "insert.bookmarks.removeAll",
        label: "Remove All Bookmarks",
        icon: IconDeleteAll,
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
        id: "insert.bookmarks.saveView",
        label: "Save Current View...",
        icon: IconSave,
        shortcut: "Ctrl+Shift+V",
        action: () => {
          showOverlay(VIEW_BOOKMARK_CREATE_OVERLAY_ID, {});
        },
      },
      {
        id: "insert.bookmarks.separator4",
        label: "",
        separator: true,
      },
      {
        id: "insert.bookmarks.showPanel",
        label: "Show Bookmarks Panel",
        icon: IconBookmarks,
        action: () => {
          openTaskPane(TASK_PANE_ID);
        },
      },
    ],
  });
  return () => unregisterMenuItem("insert", INSERT_BOOKMARKS_ITEM_ID);
}
