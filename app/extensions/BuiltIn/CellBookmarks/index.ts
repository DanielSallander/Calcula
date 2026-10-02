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
  isKeyClaimed,
} from "@api";
import { getGridStateSnapshot } from "@api/grid";
import { isEditKeystroke } from "@api/editing";
import {
  SCRIPT_BOOKMARK_MUTATIONS_EVENT,
  getWorkbookScript,
  runWorkbookScript,
} from "@api/workbookScripts";

// Internal modules — Cell Bookmarks
import { drawBookmarkDot } from "./rendering/bookmarkDecoration";
import { bookmarkStyleInterceptor } from "./rendering/bookmarkStyleInterceptor";
import { registerBookmarkMenuItems } from "./handlers/menuBuilder";
import { registerBookmarkContextMenuItems } from "./handlers/contextMenuBuilder";
import { BookmarkTaskPane } from "./components/BookmarkTaskPane";
import { BookmarkEditOverlay } from "./components/BookmarkEditOverlay";
import { BookmarkStatusBarWidget } from "./components/BookmarkStatusBarWidget";
import {
  hasBookmarkAt,
  removeAllBookmarks,
  toggleHighlight,
  setCurrentSheet,
  getBookmarkCount,
  getAllBookmarks,
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
  activateViewBookmark,
  removeViewBookmark,
  removeAllViewBookmarks,
  getViewBookmarkCount,
  onViewBookmarkChange,
  serializeViewBookmarks,
  setScriptRunner,
  type ViewBookmarkActivator,
} from "./lib/viewBookmarkStore";

// Internal modules — Persistence
import { loadBookmarks, startBookmarkWriteThrough } from "./lib/bookmarkPersistence";

// Internal modules — The active-cell actions every door shares (they refuse
// while a selection owner holds the selection)
import {
  addBookmarkAtSelection,
  toggleBookmarkAtSelection,
  removeBookmarkAtSelection,
  editBookmarkAtSelection,
} from "./lib/bookmarkAtSelection";

// Internal modules — Script integration
import { processBookmarkMutations } from "./lib/scriptMutationHandler";

// Internal modules — Capability-scoped backend door
import { bookmarksBackend } from "./lib/bookmarksBackend";

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
// Keyboard shortcuts
// ============================================================================

/**
 * Toggle a bookmark on the active cell -- the command the keybinding
 * registry's `ext.bookmarks.toggle` (Ctrl+Shift+B) runs. The registry named
 * this id long before anything registered it, and this extension's listener
 * is BUBBLE-phase, so the capture-phase dispatcher's match stopped the key
 * before it arrived: Ctrl+Shift+B did nothing at all (BUG-0183).
 */
export const BOOKMARKS_TOGGLE_COMMAND = "bookmarks.toggle";

/**
 * Ctrl+Shift+V (Save Current View), the one key Cell Bookmarks still listens
 * for itself. A window BUBBLE-phase listener, installed by activate(); module
 * level and exported so its guards can be tested without activating the
 * whole extension.
 *
 * Ctrl+Shift+B and Ctrl+] / Ctrl+[ are NOT handled here: they are registry
 * bindings running registered commands (bookmarks.toggle / next / prev), the
 * ONE keyboard path, so a key runs once and a remap in Settings moves it; the
 * registry's layout tier also takes sv-SE's Ctrl+AltGr+9 / 8. Ctrl+Shift+V
 * cannot be a binding: it is Paste Special's key ON the grid (a grid-scoped
 * binding), and only off the grid -- a ribbon button, a pane -- does this
 * bubble-phase listener hear it.
 */
export function handleBookmarkKeyDown(e: KeyboardEvent): void {
  // A keystroke aimed at a surface stacked ON the grid -- an on-grid form's
  // field, a shape's declared hit rectangle -- is not this extension's.
  // This handler had no focus guard at all, and a longer tag list would only
  // be a census of the widget types that exist today.
  // See core/lib/pointerClaims.ts, and the census in
  // core/lib/globalInputListeners.ts (a new global listener adds a row).
  if (isKeyClaimed(e)) return;
  if (!(e.ctrlKey && e.shiftKey && !e.altKey && e.key === "V")) return;
  // Not while a cell edit owns the keyboard (Core's in-cell editor, the
  // formula bar, any text field, or a floating grid's live cell edit):
  // Ctrl+Shift+V in a text field is the native paste-as-text, which this
  // listener used to cancel to open Save View.
  if (isEditKeystroke(e)) return;

  e.preventDefault();
  showOverlay(VIEW_CREATE_OVERLAY_ID, {});
}

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  if (isActivated) {
    console.warn("[CellBookmarks] Already activated, skipping.");
    return;
  }

  console.log("[CellBookmarks] Activating...");

  // ---- 0. Bind the capability-scoped backend door (A3) ----
  bookmarksBackend.set(context.invokeBackend);

  // ---- 1. Cell Decoration (colored dot in bookmarked cells) ----
  // Anchor "over-selection": the dot is indicator chrome, not cell content. It
  // sits in the bottom-left corner, under the active-cell border and the fill
  // handle, and a bookmark you cannot see on the cell you just navigated to is
  // the one case that matters — navigation is how bookmarks are used.
  const unregDecoration = registerCellDecoration(DECORATION_ID, drawBookmarkDot, 20, "over-selection");
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
  // Every command goes through `commands.register`, which queues its
  // unregister with the rest of the cleanup: deactivate() used to leave all
  // of them registered, so a deactivated extension still answered the
  // registry's Ctrl+Shift+B / Ctrl+] / Ctrl+[ through a store nothing painted
  // or persisted any more (D3).
  const commands: Pick<typeof context.commands, "register"> = {
    register: (id, handler, options) => {
      context.commands.register(id, handler, options);
      cleanupFns.push(() => context.commands.unregister(id));
    },
  };

  // The active-cell actions refuse while a selection owner holds the
  // selection (lib/bookmarkAtSelection.ts, shared with the Insert menu).
  commands.register("bookmarks.add", () => {
    addBookmarkAtSelection();
  });

  commands.register(BOOKMARKS_TOGGLE_COMMAND, () => {
    toggleBookmarkAtSelection();
  });

  commands.register("bookmarks.remove", () => {
    removeBookmarkAtSelection();
  });

  commands.register("bookmarks.next", () => {
    const target = navigateToNextBookmark();
    if (!target) {
      showToast("No bookmarks", { variant: "info" });
    }
  }, { scriptSafe: true });

  commands.register("bookmarks.prev", () => {
    const target = navigateToPrevBookmark();
    if (!target) {
      showToast("No bookmarks", { variant: "info" });
    }
  }, { scriptSafe: true });

  commands.register("bookmarks.removeAll", () => {
    const count = getBookmarkCount();
    if (count === 0) {
      showToast("No bookmarks to remove", { variant: "info" });
      return;
    }
    removeAllBookmarks();
    showToast(`Removed ${count} bookmark${count > 1 ? "s" : ""}`, { variant: "info" });
  });

  commands.register("bookmarks.toggleHighlight", () => {
    const enabled = toggleHighlight();
    markSheetDirty();
    showToast(enabled ? "Bookmark highlighting on" : "Bookmark highlighting off", { variant: "info" });
  });

  commands.register("bookmarks.showPanel", () => {
    openTaskPane(TASK_PANE_ID);
  });

  commands.register("bookmarks.editAtSelection", () => {
    editBookmarkAtSelection();
  });

  // ---- 6b. View Bookmark Commands ----
  commands.register("bookmarks.saveView", () => {
    showOverlay(VIEW_CREATE_OVERLAY_ID, {});
  });

  commands.register("bookmarks.activateView", async (args?: unknown) => {
    const a = args as { id?: string } | undefined;
    if (!a?.id) return;
    // A command a person runs (the palette, a menu, a key, the command line's
    // `command` verb): it is not scriptSafe, so no script reaches it.
    const success = await activateViewBookmark(a.id, "person");
    if (success) {
      showToast("View activated", { variant: "success" });
    } else {
      showToast("View bookmark not found", { variant: "warning" });
    }
  });

  commands.register("bookmarks.deleteView", (args?: unknown) => {
    const a = args as { id?: string } | undefined;
    if (!a?.id) return;
    if (removeViewBookmark(a.id)) {
      showToast("View bookmark removed", { variant: "info" });
    }
  });

  commands.register("bookmarks.editView", (args?: unknown) => {
    const a = args as { id?: string } | undefined;
    if (!a?.id) return;
    showOverlay(VIEW_EDIT_OVERLAY_ID, { data: { viewBookmarkId: a.id } });
  });

  commands.register("bookmarks.removeAllViews", () => {
    const count = getViewBookmarkCount();
    if (count === 0) {
      showToast("No view bookmarks to remove", { variant: "info" });
      return;
    }
    removeAllViewBookmarks();
    showToast(`Removed ${count} view bookmark${count > 1 ? "s" : ""}`, { variant: "info" });
  });

  // ---- 7. Menu Items (Insert > Bookmarks) ----
  // Removed on deactivate like the commands above: a menu item outliving the
  // extension still acted on the store (D3 review).
  cleanupFns.push(registerBookmarkMenuItems());

  // ---- 8. Context Menu Items (grid right-click) ----
  cleanupFns.push(registerBookmarkContextMenuItems());

  // ---- 9. Selection Change (track current selection for navigation) ----
  const unregSelection = ExtensionRegistry.onSelectionChange(() => {
    // Selection change handled by navigation module reading grid state directly
  });
  cleanupFns.push(unregSelection);

  // ---- 10. Event: Sheet Changed (update current sheet in store) ----
  const unregSheetChanged = onAppEvent(AppEvents.SHEET_CHANGED, (detail) => {
    // Every emitter in the repo sends { sheetIndex, sheetName }; reading
    // `index` meant this never fired and the store kept the sheet it was
    // initialized with.
    //
    // AND SO DID READING `e.detail`. `onAppEvent` hands the callback the
    // CustomEvent's DETAIL, not the event -- so the previous signature looked
    // for `{ sheetIndex }.detail`, which is undefined for every emitter in the
    // repo, and the store STILL kept its initial sheet. The same fix, applied
    // one level too shallow. (Found while wiring the `sheets` domain, which
    // dispatches this event with no detail at all -- `.detail` of `undefined`
    // would have thrown.)
    const d = detail as { sheetIndex?: number } | undefined;
    if (typeof d?.sheetIndex === "number") {
      setCurrentSheet(d.sheetIndex);
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

  // ---- 12. Ctrl+Shift+V off the grid (handleBookmarkKeyDown, above) ----
  window.addEventListener("keydown", handleBookmarkKeyDown);
  cleanupFns.push(() => window.removeEventListener("keydown", handleBookmarkKeyDown));

  // ---- 12b. Persistence: write-through on every mutation ----
  //      NOT a BEFORE_SAVE listener. AppEvents handlers are not awaited by the
  //      dispatcher, so an async save-time flush raced `save_file` and could archive
  //      the previous bookmark state -- or lose the newest edit entirely if the user
  //      never saved again. Writing through on each mutation removes the window: the
  //      virtual file is already current whenever a save runs.
  cleanupFns.push(startBookmarkWriteThrough());

  const unregAfterOpen = onAppEvent(AppEvents.AFTER_OPEN, async () => {
    try {
      await loadBookmarks();
    } catch (error) {
      console.error("[CellBookmarks] Failed to load bookmarks:", error);
    }
  });
  cleanupFns.push(unregAfterOpen);

  // ---- 12c. Script bookmark mutations listener ----
  //      Every script surface routes its queued mutations here; the handler
  //      validates the payload (it arrives as an untyped CustomEvent detail).
  const handleScriptMutations = (e: Event) => {
    void processBookmarkMutations((e as CustomEvent).detail);
  };
  window.addEventListener(SCRIPT_BOOKMARK_MUTATIONS_EVENT, handleScriptMutations);
  cleanupFns.push(() =>
    window.removeEventListener(SCRIPT_BOOKMARK_MUTATIONS_EVENT, handleScriptMutations)
  );

  // ---- 13. Script runner for view bookmark onActivate ----
  //      Runs through the @api script runtime so the security gate, the
  //      bookmark collections the script can read, and the mutations it queues
  //      all go through one path.
  //      WHO activated the bookmark travels with the run (owner decision B,
  //      follow-up F10): an application's macro runs only when a PERSON
  //      started it, so one a script's activation set off is refused by the
  //      module-runtime gate (and recorded there). The user's own scripts run
  //      either way.
  setScriptRunner(async (scriptId: string, activatedBy: ViewBookmarkActivator) => {
    const script = await getWorkbookScript(scriptId);
    if (!script) return;
    let result: Awaited<ReturnType<typeof runWorkbookScript>>;
    try {
      result = await runWorkbookScript(
        script.source,
        script.name || "bookmark-script.js",
        {
          cellBookmarksJson: JSON.stringify(getAllBookmarks()),
          viewBookmarksJson: JSON.stringify(serializeViewBookmarks()),
          startedBy: { kind: "viewBookmark", activatedBy },
        }
      );
    } catch (error) {
      // A REFUSAL rejects (the gate said no: an application's macro a script
      // set off, code not approved, Script Security). The activation used to
      // swallow it into a console line; the user is told instead.
      const message = error instanceof Error ? error.message : String(error);
      showToast(`The view bookmark's script did not run: ${message}`, { variant: "error" });
      return;
    }
    if (result.type === "error") {
      showToast(`Script error: ${result.message}`, { variant: "error" });
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
