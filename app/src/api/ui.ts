//! FILENAME: app/src/api/ui.ts
// PURPOSE: UI registration APIs for extensions.
// CONTEXT: Extensions use these to register task panes, dialogs, and overlays.
// This provides a clean, stable API surface for UI contributions.

import { TaskPaneExtensions } from "../core/extensions/taskPaneExtensions";
import { DialogExtensions } from "../core/extensions/dialogExtensions";
import { OverlayExtensions } from "../core/extensions/overlayExtensions";
import { useTaskPaneStore } from "../shell/task-pane/useTaskPaneStore";

// Re-export the extension registries for direct access if needed
export { TaskPaneExtensions, DialogExtensions, OverlayExtensions };

// Re-export types
export type {
  TaskPaneViewDefinition,
  TaskPaneViewProps,
  TaskPaneContextKey,
} from "../core/extensions/taskPaneExtensions";

export type {
  DialogDefinition,
  DialogProps,
} from "../core/extensions/dialogExtensions";

export type {
  OverlayDefinition,
  OverlayProps,
  OverlayLayer,
  AnchorRect,
} from "../core/extensions/overlayExtensions";

// ============================================================================
// Task Pane API
// ============================================================================

/**
 * Register a task pane view that can be opened in the sidebar.
 * @param definition - The view definition including component and metadata
 */
export function registerTaskPane(
  definition: import("../core/extensions/taskPaneExtensions").TaskPaneViewDefinition
): void {
  TaskPaneExtensions.registerView(definition);
}

/**
 * Unregister a task pane view.
 * @param viewId - The ID of the view to unregister
 */
export function unregisterTaskPane(viewId: string): void {
  TaskPaneExtensions.unregisterView(viewId);
}

/**
 * Open a task pane with optional data.
 * @param viewId - The ID of the view to open
 * @param data - Optional data to pass to the view component
 */
export function openTaskPane(viewId: string, data?: Record<string, unknown>): void {
  useTaskPaneStore.getState().openPane(viewId, data);
}

/**
 * Close a task pane.
 * @param viewId - The ID of the view to close
 */
export function closeTaskPane(viewId: string): void {
  useTaskPaneStore.getState().closePane(viewId);
}

/**
 * Get a registered task pane view definition.
 * @param viewId - The ID of the view
 * @returns The view definition or undefined if not found
 */
export function getTaskPane(
  viewId: string
): import("../core/extensions/taskPaneExtensions").TaskPaneViewDefinition | undefined {
  return TaskPaneExtensions.getView(viewId);
}

// ============================================================================
// Dialog API
// ============================================================================

/**
 * Register a dialog that can be shown modally.
 * @param definition - The dialog definition including component
 */
export function registerDialog(
  definition: import("../core/extensions/dialogExtensions").DialogDefinition
): void {
  DialogExtensions.registerDialog(definition);
}

/**
 * Unregister a dialog.
 * @param dialogId - The ID of the dialog to unregister
 */
export function unregisterDialog(dialogId: string): void {
  DialogExtensions.unregisterDialog(dialogId);
}

/**
 * Show a dialog.
 * @param dialogId - The ID of the dialog to show
 * @param data - Optional data to pass to the dialog component
 */
export function showDialog(dialogId: string, data?: Record<string, unknown>): void {
  DialogExtensions.openDialog(dialogId, data);
}

/**
 * Hide a dialog.
 * @param dialogId - The ID of the dialog to hide
 */
export function hideDialog(dialogId: string): void {
  DialogExtensions.closeDialog(dialogId);
}

// ============================================================================
// Overlay API
// ============================================================================

/**
 * Register an overlay (dropdown, tooltip, context menu, etc.).
 * @param definition - The overlay definition including component and layer
 */
export function registerOverlay(
  definition: import("../core/extensions/overlayExtensions").OverlayDefinition
): void {
  OverlayExtensions.registerOverlay(definition);
}

/**
 * Unregister an overlay.
 * @param overlayId - The ID of the overlay to unregister
 */
export function unregisterOverlay(overlayId: string): void {
  OverlayExtensions.unregisterOverlay(overlayId);
}

/**
 * Show an overlay at a specific position.
 * @param overlayId - The ID of the overlay to show
 * @param options - Position and data for the overlay
 */
export function showOverlay(
  overlayId: string,
  options: {
    data?: Record<string, unknown>;
    anchorRect?: import("../core/extensions/overlayExtensions").AnchorRect;
  }
): void {
  OverlayExtensions.showOverlay(overlayId, options);
}

/**
 * Hide an overlay.
 * @param overlayId - The ID of the overlay to hide
 */
export function hideOverlay(overlayId: string): void {
  OverlayExtensions.hideOverlay(overlayId);
}

/**
 * Hide all overlays.
 */
export function hideAllOverlays(): void {
  OverlayExtensions.hideAllOverlays();
}