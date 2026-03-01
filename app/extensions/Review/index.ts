//! FILENAME: app/extensions/Review/index.ts
// PURPOSE: Review extension entry point. Registers/unregisters all comment and note components.
// CONTEXT: Called from extensions/index.ts during app initialization.

import {
  registerCellDecoration,
  registerCellClickInterceptor,
  registerOverlay,
  unregisterOverlay,
  registerTaskPane,
  unregisterTaskPane,
  hideOverlay,
  hideAllOverlays,
  onAppEvent,
  AppEvents,
  ExtensionRegistry,
  emitAppEvent,
} from "../../src/api";

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

// ============================================================================
// Registration
// ============================================================================

export function registerReviewExtension(): void {
  console.log("[Review] Registering...");

  // 1. Register cell decoration for triangle indicators
  const unregDecoration = registerCellDecoration(
    "annotation-triangles",
    drawAnnotationTriangle,
    5
  );
  cleanupFns.push(unregDecoration);

  // 2. Register overlay components
  registerOverlay({
    id: NOTE_EDITOR_OVERLAY_ID,
    component: NoteEditorOverlay,
    layer: "popover",
  });
  cleanupFns.push(() => unregisterOverlay(NOTE_EDITOR_OVERLAY_ID));

  registerOverlay({
    id: COMMENT_PANEL_OVERLAY_ID,
    component: CommentPanelOverlay,
    layer: "popover",
  });
  cleanupFns.push(() => unregisterOverlay(COMMENT_PANEL_OVERLAY_ID));

  registerOverlay({
    id: ANNOTATION_PREVIEW_OVERLAY_ID,
    component: AnnotationPreview,
    layer: "tooltip",
  });
  cleanupFns.push(() => unregisterOverlay(ANNOTATION_PREVIEW_OVERLAY_ID));

  // 3. Register task pane for comments sidebar
  registerTaskPane({
    id: COMMENTS_PANE_ID,
    title: "Comments",
    component: CommentsSidebar,
    contextKeys: ["comment", "always"],
    closable: true,
  });
  cleanupFns.push(() => unregisterTaskPane(COMMENTS_PANE_ID));

  // 4. Register cell click interceptor for opening editors on annotated cells
  const unregClick = registerCellClickInterceptor(handleAnnotationClick);
  cleanupFns.push(unregClick);

  // 5. Subscribe to selection changes
  const unsubSelection = ExtensionRegistry.onSelectionChange(handleSelectionChange);
  cleanupFns.push(unsubSelection);

  // 6. Subscribe to sheet changes (refresh indicator cache)
  const unsubSheet = onAppEvent(AppEvents.SHEET_CHANGED, () => {
    hideOverlay(NOTE_EDITOR_OVERLAY_ID);
    hideOverlay(COMMENT_PANEL_OVERLAY_ID);
    hideOverlay(ANNOTATION_PREVIEW_OVERLAY_ID);
    refreshAnnotationState().then(() => {
      emitAppEvent(AppEvents.GRID_REFRESH);
    });
  });
  cleanupFns.push(unsubSheet);

  // 7. Subscribe to structure changes (refresh after row/col insert/delete)
  const unsubRowsInserted = onAppEvent(AppEvents.ROWS_INSERTED, () => {
    refreshAnnotationState();
  });
  cleanupFns.push(unsubRowsInserted);

  const unsubColsInserted = onAppEvent(AppEvents.COLUMNS_INSERTED, () => {
    refreshAnnotationState();
  });
  cleanupFns.push(unsubColsInserted);

  const unsubRowsDeleted = onAppEvent(AppEvents.ROWS_DELETED, () => {
    refreshAnnotationState();
  });
  cleanupFns.push(unsubRowsDeleted);

  const unsubColsDeleted = onAppEvent(AppEvents.COLUMNS_DELETED, () => {
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

  console.log("[Review] Registered successfully.");
}

// ============================================================================
// Unregistration
// ============================================================================

export function unregisterReviewExtension(): void {
  console.log("[Review] Unregistering...");

  // Close all overlays
  hideOverlay(NOTE_EDITOR_OVERLAY_ID);
  hideOverlay(COMMENT_PANEL_OVERLAY_ID);
  hideOverlay(ANNOTATION_PREVIEW_OVERLAY_ID);

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

  console.log("[Review] Unregistered.");
}
