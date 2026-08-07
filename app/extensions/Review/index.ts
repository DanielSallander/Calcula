//! FILENAME: app/extensions/Review/index.ts
// PURPOSE: Review extension entry point. Registers/unregisters all comment and note components.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  AppEvents,
  ExtensionRegistry,
} from "@api";

// Rendering
import { drawAnnotationTriangle } from "./rendering/triangleRenderer";

// Store
import {
  requestAnnotationRefresh,
  invalidateAnnotationRefresh,
  resetAnnotationStore,
} from "./lib/annotationStore";

// Handlers
import { handleAnnotationClick } from "./handlers/clickHandler";
import { handleSelectionChange } from "./handlers/selectionHandler";
import { initHoverHandler, destroyHoverHandler, hidePreview } from "./handlers/hoverHandler";
import {
  registerKeyboardShortcuts,
  unregisterKeyboardShortcuts,
} from "./handlers/keyboardHandler";
import {
  registerAnnotationContextMenuItems,
  unregisterAnnotationContextMenuItems,
} from "./handlers/contextMenuBuilder";
import { registerReviewMenuItems } from "./handlers/reviewMenuBuilder";

// Components
import NoteEditorOverlay from "./components/NoteEditorOverlay";
import CommentPanelOverlay from "./components/CommentPanelOverlay";
import AnnotationPreview from "./components/AnnotationPreview";
import CommentsSidebar from "./components/CommentsSidebar";

// ============================================================================
// Constants
// ============================================================================

const NOTE_EDITOR_OVERLAY_ID = "note-editor";
const COMMENT_PANEL_OVERLAY_ID = "comment-panel";
const ANNOTATION_PREVIEW_OVERLAY_ID = "annotation-preview";
const COMMENTS_PANE_ID = "comments-pane";

// ============================================================================
// Cleanup tracking
// ============================================================================

const cleanupFns: (() => void)[] = [];
let _context: ExtensionContext | null = null;

// ============================================================================
// Lifecycle
// ============================================================================

function activate(context: ExtensionContext): void {
  _context = context;
  console.log("[Review] Activating...");

  // 1. Register cell decoration for triangle indicators.
  //    Anchor "over-selection": the triangle sits in the cell's top-right
  //    corner, which is exactly where the active-cell border and the selection
  //    tint land — selecting a commented cell used to hide its own indicator.
  //    Excel keeps it visible; the anchor is how this decoration says so
  //    without the selection painter having to know what a note is.
  const unregDecoration = context.grid.decorations.register(
    "annotation-triangles",
    drawAnnotationTriangle,
    5,
    "over-selection"
  );
  cleanupFns.push(unregDecoration);

  // 2. Register overlay components
  context.ui.overlays.register({
    id: NOTE_EDITOR_OVERLAY_ID,
    component: NoteEditorOverlay,
    layer: "popover",
  });
  cleanupFns.push(() => context.ui.overlays.unregister(NOTE_EDITOR_OVERLAY_ID));

  context.ui.overlays.register({
    id: COMMENT_PANEL_OVERLAY_ID,
    component: CommentPanelOverlay,
    layer: "popover",
  });
  cleanupFns.push(() => context.ui.overlays.unregister(COMMENT_PANEL_OVERLAY_ID));

  context.ui.overlays.register({
    id: ANNOTATION_PREVIEW_OVERLAY_ID,
    component: AnnotationPreview,
    layer: "tooltip",
  });
  cleanupFns.push(() => context.ui.overlays.unregister(ANNOTATION_PREVIEW_OVERLAY_ID));

  // 3. Register task pane for comments sidebar
  context.ui.taskPanes.register({
    id: COMMENTS_PANE_ID,
    title: "Comments",
    component: CommentsSidebar,
    contextKeys: ["comment", "always"],
    closable: true,
  });
  cleanupFns.push(() => context.ui.taskPanes.unregister(COMMENTS_PANE_ID));

  // 4. Register cell click interceptor for opening editors on annotated cells
  const unregClick = context.grid.cellClicks.registerClickInterceptor(handleAnnotationClick);
  cleanupFns.push(unregClick);

  // 4b. Mount the hover preview (Excel's primary way of READING a note: rest the
  // pointer on the cell). It owns its own document listeners; destroyHoverHandler
  // removes them and makes any pending timer inert.
  initHoverHandler();
  cleanupFns.push(destroyHoverHandler);

  // 5. Subscribe to selection changes
  const unsubSelection = ExtensionRegistry.onSelectionChange(handleSelectionChange);
  cleanupFns.push(unsubSelection);

  // 6. Subscribe to sheet changes (refresh indicator cache)
  const unsubSheet = context.events.on(AppEvents.SHEET_CHANGED, () => {
    context.ui.overlays.hide(NOTE_EDITOR_OVERLAY_ID);
    context.ui.overlays.hide(COMMENT_PANEL_OVERLAY_ID);
    // Through the hover handler, so its "a preview is showing for cell X" state
    // is cleared too — hiding the overlay behind its back would leave it
    // convinced the tooltip is still up for that cell.
    hidePreview();
    // The pass in flight (if any) is reading the sheet we are leaving.
    invalidateAnnotationRefresh();
    void requestAnnotationRefresh().then(() => {
      context.events.emit(AppEvents.GRID_REFRESH);
    });
  });
  cleanupFns.push(unsubSheet);

  // 7. Subscribe to structure changes (refresh after row/col insert/delete).
  //
  // STRUCTURAL_UNDO is in the set because undoing an insert moves the comments
  // and notes back — without it the triangles stayed at their post-insert cells
  // until something else happened to refresh them. Its payload carries no
  // coordinates, so the only correct response is a re-fetch.
  //
  // The repaint matters as much as the refetch: refreshAnnotationState is async
  // and the indicators are painted from its cache, so a frame drawn before it
  // resolves still shows the old triangles.
  const onAnnotationsStale = () => {
    // The cached preview content (and the cell it belongs to) is about to move
    // or change; drop it rather than show a stale note over a shifted cell.
    hidePreview();
    // request(), not the join() flavour: this reacts to a change SOMETHING ELSE
    // made, so a pass that was already running may have started reading before
    // that change was committed.
    void requestAnnotationRefresh().then(() => {
      context.events.emit(AppEvents.GRID_REFRESH);
    });
  };
  // ANNOTATIONS_CHANGED is announced by the IPC wrapper itself, so it covers
  // EVERY route that writes an annotation — this extension's own overlays and
  // context menu, the script rows (api.setNote / api.addComment / ...), and an
  // out-of-band mutator that never went through a wrapper and dispatches the
  // event instead. Triangles appear without waiting for a sheet switch.
  // AFTER_OPEN: a newly opened workbook brings a whole new annotation set, and
  // the active sheet index may not change, so SHEET_CHANGED cannot be relied on.
  for (const evt of [
    AppEvents.ROWS_INSERTED,
    AppEvents.COLUMNS_INSERTED,
    AppEvents.ROWS_DELETED,
    AppEvents.COLUMNS_DELETED,
    AppEvents.STRUCTURAL_UNDO,
    AppEvents.ANNOTATIONS_CHANGED,
    AppEvents.AFTER_OPEN,
  ]) {
    cleanupFns.push(context.events.on(evt, onAnnotationsStale));
  }

  // 8. Register context menu items
  registerAnnotationContextMenuItems();

  // 9. Register Review menu items (appended to existing Review menu)
  registerReviewMenuItems();

  // 10. Register keyboard shortcuts
  registerKeyboardShortcuts();
  cleanupFns.push(unregisterKeyboardShortcuts);

  // 11. Initial state load
  void requestAnnotationRefresh();

  console.log("[Review] Activated successfully.");
}

function deactivate(): void {
  console.log("[Review] Deactivating...");

  // Close all overlays
  _context?.ui.overlays.hide(NOTE_EDITOR_OVERLAY_ID);
  _context?.ui.overlays.hide(COMMENT_PANEL_OVERLAY_ID);
  _context?.ui.overlays.hide(ANNOTATION_PREVIEW_OVERLAY_ID);

  // Unregister context menu items
  unregisterAnnotationContextMenuItems();

  // Run cleanup functions
  for (const fn of cleanupFns) {
    try {
      fn();
    } catch (err) {
      console.error("[Review] Cleanup error:", err);
    }
  }
  cleanupFns.length = 0;

  // Reset state
  resetAnnotationStore();
  _context = null;

  console.log("[Review] Deactivated.");
}

// ============================================================================
// Extension Module
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.review",
    name: "Review",
    version: "1.0.0",
    description: "Comments, notes, and annotation management for cells.",
  },
  activate,
  deactivate,
};
export default extension;
