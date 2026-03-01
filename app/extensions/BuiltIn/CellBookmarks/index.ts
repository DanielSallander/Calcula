//! FILENAME: app/extensions/BuiltIn/CellBookmarks/index.ts
// PURPOSE: Cell Bookmarks extension module entry point.
// CONTEXT: Registers 12 distinct API surfaces to demonstrate and test the
//          extensibility architecture. Users can mark cells with colored
//          bookmarks and navigate between them.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "../../../src/api/contract";
import {
  // Cell Decorations
  registerCellDecoration,
  // Style Interceptors
  registerStyleInterceptor,
  markSheetDirty,
  // Overlays
  registerOverlay,
  unregisterOverlay,
  // Task Panes
  registerTaskPane,
  unregisterTaskPane,
  openTaskPane,
  // Status Bar
  registerStatusBarItem,
  unregisterStatusBarItem,
  // Events
  onAppEvent,
  AppEvents,
  // Selection
  ExtensionRegistry,
  // Grid state
  showToast,
  showOverlay,
  // Double-click interceptor
  registerCellDoubleClickInterceptor,
} from "../../../src/api";
import { getGridStateSnapshot } from "../../../src/api/grid";

// Internal modules
import { drawBookmarkDot } from "./rendering/bookmarkDecoration";
import { bookmarkStyleInterceptor } from "./rendering/bookmarkStyleInterceptor";
import { registerBookmarkMenuItems } from "./handlers/menuBuilder";
import { registerBookmarkContextMenuItems } from "./handlers/contextMenuBuilder";
import { BookmarkTaskPane } from "./components/BookmarkTaskPane";
import { BookmarkEditOverlay } from "./components/BookmarkEditOverlay";
import { BookmarkStatusBarWidget } from "./components/BookmarkStatusBarWidget";
import {
  addBookmark,
  removeBookmark,
  hasBookmarkAt,
  removeAllBookmarks,
  toggleHighlight,
  setCurrentSheet,
  getBookmarkCount,
  onChange,
} from "./lib/bookmarkStore";
import {
  navigateToNextBookmark,
  navigateToPrevBookmark,
} from "./lib/bookmarkNavigation";

// ============================================================================
// Constants
// ============================================================================

const DECORATION_ID = "cell-bookmarks";
const INTERCEPTOR_ID = "cell-bookmarks";
const OVERLAY_ID = "bookmark-editor";
const TASK_PANE_ID = "bookmarks-pane";
const STATUS_BAR_ID = "calcula.statusbar.bookmarks";

// ============================================================================
// State
// ============================================================================

let isActivated = false;
const cleanupFns: (() => void)[] = [];

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[CellBookmarks] Already activated, skipping.");
    return;
  }

  console.log("[CellBookmarks] Activating...");

  // ---- 1. Cell Decoration (colored dot in bookmarked cells) ----
  const unregDecoration = registerCellDecoration(DECORATION_ID, drawBookmarkDot, 20);
  cleanupFns.push(unregDecoration);

  // ---- 2. Style Interceptor (background tint when highlight enabled) ----
  const unregInterceptor = registerStyleInterceptor(INTERCEPTOR_ID, bookmarkStyleInterceptor, 50);
  cleanupFns.push(unregInterceptor);

  // ---- 3. Overlay (bookmark editor popover) ----
  registerOverlay({
    id: OVERLAY_ID,
    component: BookmarkEditOverlay,
    layer: "popover",
  });
  cleanupFns.push(() => unregisterOverlay(OVERLAY_ID));

  // ---- 4. Task Pane (bookmarks panel) ----
  registerTaskPane({
    id: TASK_PANE_ID,
    title: "Bookmarks",
    component: BookmarkTaskPane,
    contextKeys: ["always"],
    priority: 10,
    closable: true,
  });
  cleanupFns.push(() => unregisterTaskPane(TASK_PANE_ID));

  // ---- 5. Status Bar (bookmark count indicator) ----
  registerStatusBarItem({
    id: STATUS_BAR_ID,
    component: BookmarkStatusBarWidget,
    alignment: "right",
    priority: 50,
  });
  cleanupFns.push(() => unregisterStatusBarItem(STATUS_BAR_ID));

  // ---- 6. Commands ----
  context.commands.register("bookmarks.add", () => {
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
  });

  context.commands.register("bookmarks.remove", () => {
    const state = getGridStateSnapshot();
    if (!state?.selection) return;
    const { startRow, startCol } = state.selection;
    const { activeSheetIndex } = state.sheetContext;
    if (removeBookmark(startRow, startCol, activeSheetIndex)) {
      showToast("Bookmark removed", { variant: "info" });
    }
  });

  context.commands.register("bookmarks.next", () => {
    const target = navigateToNextBookmark();
    if (!target) {
      showToast("No bookmarks", { variant: "info" });
    }
  });

  context.commands.register("bookmarks.prev", () => {
    const target = navigateToPrevBookmark();
    if (!target) {
      showToast("No bookmarks", { variant: "info" });
    }
  });

  context.commands.register("bookmarks.removeAll", () => {
    const count = getBookmarkCount();
    if (count === 0) {
      showToast("No bookmarks to remove", { variant: "info" });
      return;
    }
    removeAllBookmarks();
    showToast(`Removed ${count} bookmark${count > 1 ? "s" : ""}`, { variant: "info" });
  });

  context.commands.register("bookmarks.toggleHighlight", () => {
    const enabled = toggleHighlight();
    markSheetDirty();
    showToast(enabled ? "Bookmark highlighting on" : "Bookmark highlighting off", { variant: "info" });
  });

  context.commands.register("bookmarks.showPanel", () => {
    openTaskPane(TASK_PANE_ID);
  });

  context.commands.register("bookmarks.editAtSelection", () => {
    const state = getGridStateSnapshot();
    if (!state?.selection) return;
    const { startRow, startCol } = state.selection;
    const { activeSheetIndex } = state.sheetContext;
    showOverlay(OVERLAY_ID, {
      data: { row: startRow, col: startCol, sheetIndex: activeSheetIndex },
    });
  });

  // ---- 7. Menu Items (Insert > Bookmarks) ----
  registerBookmarkMenuItems();

  // ---- 8. Context Menu Items (grid right-click) ----
  registerBookmarkContextMenuItems();

  // ---- 9. Selection Change (track current selection for navigation) ----
  const unregSelection = ExtensionRegistry.onSelectionChange(() => {
    // Selection change handled by navigation module reading grid state directly
  });
  cleanupFns.push(unregSelection);

  // ---- 10. Event: Sheet Changed (update current sheet in store) ----
  const unregSheetChanged = onAppEvent(AppEvents.SHEET_CHANGED, (e: CustomEvent) => {
    const detail = e.detail as { index?: number } | undefined;
    if (detail?.index !== undefined) {
      setCurrentSheet(detail.index);
    }
  });
  cleanupFns.push(unregSheetChanged);

  // ---- 11. Double-click interceptor (edit bookmark on double-click) ----
  const unregDblClick = registerCellDoubleClickInterceptor(async (row, col, _event) => {
    if (!hasBookmarkAt(row, col)) {
      return false; // Don't intercept
    }
    showOverlay(OVERLAY_ID, {
      data: { row, col, sheetIndex: getGridStateSnapshot()?.sheetContext.activeSheetIndex ?? 0 },
    });
    return true; // Intercept: prevent default editing
  });
  cleanupFns.push(unregDblClick);

  // ---- 12. Keyboard shortcuts ----
  const handleKeyDown = (e: KeyboardEvent) => {
    // Ctrl+Shift+B: Toggle add/remove bookmark
    if (e.ctrlKey && e.shiftKey && e.key === "B") {
      e.preventDefault();
      const state = getGridStateSnapshot();
      if (!state?.selection) return;
      const { startRow, startCol } = state.selection;
      const { activeSheetIndex, activeSheetName } = state.sheetContext;
      if (hasBookmarkAt(startRow, startCol)) {
        removeBookmark(startRow, startCol, activeSheetIndex);
        showToast("Bookmark removed", { variant: "info" });
      } else {
        addBookmark(startRow, startCol, activeSheetIndex, activeSheetName);
        showToast("Bookmark added", { variant: "success" });
      }
    }

    // Ctrl+]: Next bookmark
    if (e.ctrlKey && !e.shiftKey && e.key === "]") {
      e.preventDefault();
      const target = navigateToNextBookmark();
      if (!target) {
        showToast("No bookmarks", { variant: "info" });
      }
    }

    // Ctrl+[: Previous bookmark
    if (e.ctrlKey && !e.shiftKey && e.key === "[") {
      e.preventDefault();
      const target = navigateToPrevBookmark();
      if (!target) {
        showToast("No bookmarks", { variant: "info" });
      }
    }
  };

  window.addEventListener("keydown", handleKeyDown);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown));

  // ---- Trigger grid repaint when bookmarks change ----
  const unregOnChange = onChange(() => {
    markSheetDirty();
  });
  cleanupFns.push(unregOnChange);

  isActivated = true;
  console.log("[CellBookmarks] Activated successfully.");
}

function deactivate(): void {
  if (!isActivated) return;

  console.log("[CellBookmarks] Deactivating...");

  // Clean up in reverse order
  for (let i = cleanupFns.length - 1; i >= 0; i--) {
    try {
      cleanupFns[i]();
    } catch (error) {
      console.error("[CellBookmarks] Error during cleanup:", error);
    }
  }
  cleanupFns.length = 0;

  isActivated = false;
  console.log("[CellBookmarks] Deactivated.");
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.builtin.cell-bookmarks",
    name: "Cell Bookmarks",
    version: "1.0.0",
    description:
      "Mark, navigate, and manage cell bookmarks with color coding. " +
      "Exercises 12 distinct API surfaces to validate the extensibility architecture.",
  },
  activate,
  deactivate,
};

export default extension;
