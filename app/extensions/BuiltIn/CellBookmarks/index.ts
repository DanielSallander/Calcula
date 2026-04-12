//! FILENAME: app/extensions/BuiltIn/CellBookmarks/index.ts
// PURPOSE: Cell Bookmarks extension module entry point.
// CONTEXT: Registers 12 distinct API surfaces to demonstrate and test the
//          extensibility architecture. Users can mark cells with colored
//          bookmarks and navigate between them.
// NOTE: Default exports an ExtensionModule object per the contract.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
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
} from "@api";
import { getGridStateSnapshot } from "@api/grid";

// Internal modules — Cell Bookmarks
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

// Internal modules — View Bookmarks
import { ViewBookmarkCreateOverlay } from "./components/ViewBookmarkCreateOverlay";
import { ViewBookmarkEditOverlay } from "./components/ViewBookmarkEditOverlay";
import {
  addViewBookmark,
  activateViewBookmark,
  removeViewBookmark,
  removeAllViewBookmarks,
  getViewBookmarkCount,
  onViewBookmarkChange,
  setScriptRunner,
} from "./lib/viewBookmarkStore";
import { DEFAULT_VIEW_DIMENSIONS } from "./lib/viewBookmarkTypes";

// Internal modules — Persistence
import { saveBookmarks, loadBookmarks } from "./lib/bookmarkPersistence";

// Internal modules — Script integration
import { processBookmarkMutations } from "./lib/scriptMutationHandler";

// ============================================================================
// Constants
// ============================================================================

const DECORATION_ID = "cell-bookmarks";
const INTERCEPTOR_ID = "cell-bookmarks";
const OVERLAY_ID = "bookmark-editor";
const VIEW_CREATE_OVERLAY_ID = "view-bookmark-creator";
const VIEW_EDIT_OVERLAY_ID = "view-bookmark-editor";
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

  // ---- 3. Overlay (cell bookmark editor popover) ----
  registerOverlay({
    id: OVERLAY_ID,
    component: BookmarkEditOverlay,
    layer: "popover",
  });
  cleanupFns.push(() => unregisterOverlay(OVERLAY_ID));

  // ---- 3b. Overlay (view bookmark create) ----
  registerOverlay({
    id: VIEW_CREATE_OVERLAY_ID,
    component: ViewBookmarkCreateOverlay,
    layer: "popover",
  });
  cleanupFns.push(() => unregisterOverlay(VIEW_CREATE_OVERLAY_ID));

  // ---- 3c. Overlay (view bookmark edit) ----
  registerOverlay({
    id: VIEW_EDIT_OVERLAY_ID,
    component: ViewBookmarkEditOverlay,
    layer: "popover",
  });
  cleanupFns.push(() => unregisterOverlay(VIEW_EDIT_OVERLAY_ID));

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

  // ---- 6b. View Bookmark Commands ----
  context.commands.register("bookmarks.saveView", () => {
    showOverlay(VIEW_CREATE_OVERLAY_ID, {});
  });

  context.commands.register("bookmarks.activateView", async (args?: { id?: string }) => {
    if (!args?.id) return;
    const success = await activateViewBookmark(args.id);
    if (success) {
      showToast("View activated", { variant: "success" });
    } else {
      showToast("View bookmark not found", { variant: "warning" });
    }
  });

  context.commands.register("bookmarks.deleteView", (args?: { id?: string }) => {
    if (!args?.id) return;
    if (removeViewBookmark(args.id)) {
      showToast("View bookmark removed", { variant: "info" });
    }
  });

  context.commands.register("bookmarks.editView", (args?: { id?: string }) => {
    if (!args?.id) return;
    showOverlay(VIEW_EDIT_OVERLAY_ID, { data: { viewBookmarkId: args.id } });
  });

  context.commands.register("bookmarks.removeAllViews", () => {
    const count = getViewBookmarkCount();
    if (count === 0) {
      showToast("No view bookmarks to remove", { variant: "info" });
      return;
    }
    removeAllViewBookmarks();
    showToast(`Removed ${count} view bookmark${count > 1 ? "s" : ""}`, { variant: "info" });
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

    // Ctrl+Shift+V: Save current view
    if (e.ctrlKey && e.shiftKey && e.key === "V") {
      e.preventDefault();
      showOverlay(VIEW_CREATE_OVERLAY_ID, {});
    }
  };

  window.addEventListener("keydown", handleKeyDown);
  cleanupFns.push(() => window.removeEventListener("keydown", handleKeyDown));

  // ---- 12b. Persistence: save/load bookmarks with workbook ----
  const unregBeforeSave = onAppEvent(AppEvents.BEFORE_SAVE, async () => {
    try {
      await saveBookmarks();
    } catch (error) {
      console.error("[CellBookmarks] Failed to save bookmarks:", error);
    }
  });
  cleanupFns.push(unregBeforeSave);

  const unregAfterOpen = onAppEvent(AppEvents.AFTER_OPEN, async () => {
    try {
      await loadBookmarks();
    } catch (error) {
      console.error("[CellBookmarks] Failed to load bookmarks:", error);
    }
  });
  cleanupFns.push(unregAfterOpen);

  // ---- 12c. Script bookmark mutations listener ----
  const handleScriptMutations = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (Array.isArray(detail)) {
      processBookmarkMutations(detail);
    }
  };
  window.addEventListener("script:bookmark-mutations", handleScriptMutations);
  cleanupFns.push(() => window.removeEventListener("script:bookmark-mutations", handleScriptMutations));

  // Also listen for cross-window mutations from the Monaco editor
  // (Tauri events are handled separately via listenTauriEvent)
  let unlistenTauriBookmarks: (() => void) | null = null;
  import("@api/backend").then(({ listenTauriEvent }) => {
    listenTauriEvent<{ mutations: unknown[] }>(
      "script-editor:bookmark-mutations",
      (payload) => {
        if (payload.mutations && Array.isArray(payload.mutations)) {
          processBookmarkMutations(payload.mutations as Parameters<typeof processBookmarkMutations>[0]);
        }
      }
    ).then((unlisten) => {
      unlistenTauriBookmarks = unlisten;
    });
  });
  cleanupFns.push(() => unlistenTauriBookmarks?.());

  // ---- 13. Script runner for view bookmark onActivate ----
  setScriptRunner(async (scriptId: string) => {
    const { invokeBackend } = await import("@api/backend");
    const script = await invokeBackend<{ id: string; name: string; source: string }>(
      "get_script",
      { id: scriptId }
    );
    if (script) {
      const result = await invokeBackend<{ success: boolean; error?: string }>(
        "run_script",
        { request: { source: script.source, filename: script.name || "bookmark-script.js" } }
      );
      if (!result.success && result.error) {
        showToast(`Script error: ${result.error}`, { variant: "error" });
      }
    }
  });
  cleanupFns.push(() => setScriptRunner(null));

  // ---- Trigger grid repaint when bookmarks change ----
  const unregOnChange = onChange(() => {
    markSheetDirty();
  });
  cleanupFns.push(unregOnChange);

  const unregViewChange = onViewBookmarkChange(() => {
    markSheetDirty();
  });
  cleanupFns.push(unregViewChange);

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
    name: "Bookmarks",
    version: "2.0.0",
    description:
      "Cell bookmarks for marking and navigating cells. " +
      "View bookmarks for capturing and restoring application state (filters, zoom, scroll, etc.). " +
      "Scripts can create bookmarks and view bookmarks can trigger scripts on activation.",
  },
  activate,
  deactivate,
};

export default extension;
