//! FILENAME: app/src/core/lib/events.ts
// PURPOSE: Application-wide event system for decoupled communication.
// CONTEXT: Core primitive that enables the Kernel to emit events that
// Shell and Extensions can listen to without creating import dependencies.
// The API layer re-exports this module for extension consumption.

// ============================================================================
// Event Types
// ============================================================================

export const AppEvents = {
  // Clipboard events
  CUT: "app:cut",
  COPY: "app:copy",
  PASTE: "app:paste",

  // Find/Replace events
  FIND: "app:find",
  REPLACE: "app:replace",

  // Freeze pane events
  FREEZE_CHANGED: "app:freeze-changed",

  // Navigation events
  NAVIGATE_TO_CELL: "app:navigate-to-cell",

  // Cell events
  CELLS_UPDATED: "app:cells-updated",

  // Context Menu events
  CONTEXT_MENU_REQUEST: "app:context-menu-request",
  CONTEXT_MENU_CLOSE: "app:context-menu-close",

  // Grid events
  GRID_REFRESH: "app:grid-refresh",

  // Structure events (row/column insert/delete)
  ROWS_INSERTED: "app:rows-inserted",
  COLUMNS_INSERTED: "app:columns-inserted",
  ROWS_DELETED: "app:rows-deleted",
  COLUMNS_DELETED: "app:columns-deleted",

  // Sheet events
  SHEET_CHANGED: "app:sheet-changed",

  // Editing events
  PREVENT_BLUR_COMMIT: "app:prevent-blur-commit",
} as const;

export type AppEventType = (typeof AppEvents)[keyof typeof AppEvents];

// ============================================================================
// Event Emission
// ============================================================================

/**
 * Emit an application event.
 * Accepts both core AppEventType and extension-defined event strings.
 * @param event The event type to emit
 * @param detail Optional detail payload
 */
export function emitAppEvent(event: AppEventType | string, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(event, { detail }));
}

// ============================================================================
// Event Subscription
// ============================================================================

/**
 * Subscribe to an application event.
 * Accepts both core AppEventType and extension-defined event strings.
 * @param event The event type to listen for
 * @param callback The callback to invoke when the event fires
 * @returns Cleanup function to remove the listener
 */
export function onAppEvent<T = unknown>(
  event: AppEventType | string,
  callback: (detail: T) => void
): () => void {
  const handler = (e: Event) => {
    const customEvent = e as CustomEvent<T>;
    callback(customEvent.detail);
  };

  window.addEventListener(event, handler);
  return () => window.removeEventListener(event, handler);
}
