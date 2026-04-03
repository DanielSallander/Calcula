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
import { refreshAnnotationState, resetAnnotationStore } from "./lib/annotationStore";

// Handlers
import { handleAnnotationClick } from "./handlers/clickHandler";
import { handleSelectionChange } from "./handlers/selectionHandler";
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

  // 1. Register cell decoration for triangle indicators
  const unregDecoration = context.grid.decorations.register(
    "annotation-triangles",
    drawAnnotationTriangle,
    5
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

  // 5. Subscribe to selection changes
  const unsubSelection = ExtensionRegistry.onSelectionChange(handleSelectionChange);
  cleanupFns.push(unsubSelection);

  // 6. Subscribe to sheet changes (refresh indicator cache)
  const unsubSheet = context.events.on(AppEvents.SHEET_CHANGED, () => {
    context.ui.overlays.hide(NOTE_EDITOR_OVERLAY_ID);
    context.ui.overlays.hide(COMMENT_PANEL_OVERLAY_ID);
    context.ui.overlays.hide(ANNOTATION_PREVIEW_OVERLAY_ID);
    refreshAnnotationState().then(() => {
      context.events.emit(AppEvents.GRID_REFRESH);
    });
  });
  cleanupFns.push(unsubSheet);

  // 7. Subscribe to structure changes (refresh after row/col insert/delete)
  const unsubRowsInserted = context.events.on(AppEvents.ROWS_INSERTED, () => {
    refreshAnnotationState();
  });
  cleanupFns.push(unsubRowsInserted);

  const unsubColsInserted = context.events.on(AppEvents.COLUMNS_INSERTED, () => {
    refreshAnnotationState();
  });
  cleanupFns.push(unsubColsInserted);

  const unsubRowsDeleted = context.events.on(AppEvents.ROWS_DELETED, () => {
    refreshAnnotationState();
  });
  cleanupFns.push(unsubRowsDeleted);

  const unsubColsDeleted = context.events.on(AppEvents.COLUMNS_DELETED, () => {
    refreshAnnotationState();
  });
  cleanupFns.push(unsubColsDeleted);

  // 8. Register context menu items
  registerAnnotationContextMenuItems();

  // 9. Register Review menu items (appended to existing Review menu)
  registerReviewMenuItems();

  // 10. Register keyboard shortcuts
  registerKeyboardShortcuts();
  cleanupFns.push(unregisterKeyboardShortcuts);

  // 11. Initial state load
  refreshAnnotationState();

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
