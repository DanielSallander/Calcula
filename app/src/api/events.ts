//! FILENAME: app/src/api/events.ts
// PURPOSE: Application-wide event system for decoupled communication.
// CONTEXT: Extensions and Shell use this to communicate without direct coupling.
// FIX: Event names must match core/lib/events.ts which is the canonical source.

// ============================================================================
// Event Names
// ============================================================================

export const AppEvents = {
  // Clipboard events (from core)
  CUT: "app:cut",
  COPY: "app:copy",
  PASTE: "app:paste",

  // Find/Replace events (from core)
  FIND: "app:find",
  REPLACE: "app:replace",

  // Freeze pane events
  FREEZE_CHANGED: "app:freeze-changed",

  // Selection events
  SELECTION_CHANGED: "app:selection-changed",

  // Sheet events
  SHEET_CHANGED: "app:sheet-changed",

  // Data events
  DATA_CHANGED: "app:data-changed",
  CELLS_UPDATED: "app:cells-updated",

  // Editing events
  EDIT_STARTED: "app:edit-started",
  EDIT_ENDED: "app:edit-ended",

  // Grid events
  GRID_REFRESH: "app:grid-refresh",

  // Context menu events - FIX: Must match core/lib/events.ts
  CONTEXT_MENU_REQUEST: "app:context-menu-request",
  CONTEXT_MENU_CLOSE: "app:context-menu-close",

  // Structure events (row/column insert/delete)
  ROWS_INSERTED: "app:rows-inserted",
  COLUMNS_INSERTED: "app:columns-inserted",
  ROWS_DELETED: "app:rows-deleted",
  COLUMNS_DELETED: "app:columns-deleted",

  // Navigation events
  NAVIGATE_TO_CELL: "app:navigate-to-cell",

  // Named ranges
  NAMED_RANGES_CHANGED: "app:named-ranges-changed",

  // Blur commit prevention
  PREVENT_BLUR_COMMIT: "app:prevent-blur-commit",

  // Status bar context menu
  STATUS_BAR_CONTEXT_MENU: "app:status-bar-context-menu",

  // Fill handle events
  FILL_COMPLETED: "app:fill-completed",
} as const;

/** Payload emitted with FILL_COMPLETED event. */
export interface FillCompletedPayload {
  sourceRange: { startRow: number; startCol: number; endRow: number; endCol: number };
  targetRange: { startRow: number; startCol: number; endRow: number; endCol: number };
  direction: "down" | "up" | "right" | "left";
}

export type AppEventName = (typeof AppEvents)[keyof typeof AppEvents];

// ============================================================================
// Event Emitter/Listener Functions
// ============================================================================

/**
 * Emit an application event.
 * @param eventName The event name from AppEvents
 * @param detail The event payload
 */
export function emitAppEvent<T = unknown>(eventName: AppEventName | string, detail?: T): void {
  const event = new CustomEvent(eventName, { detail });
  window.dispatchEvent(event);
}

/**
 * Subscribe to an application event.
 * @param eventName The event name from AppEvents
 * @param callback The callback to invoke when the event fires
 * @returns Cleanup function to unsubscribe
 */
export function onAppEvent<T = unknown>(
  eventName: AppEventName | string,
  callback: (detail: T) => void
): () => void {
  const handler = (event: Event) => {
    const customEvent = event as CustomEvent<T>;
    callback(customEvent.detail);
  };

  window.addEventListener(eventName, handler);

  return () => {
    window.removeEventListener(eventName, handler);
  };
}

// ============================================================================
// UI Utilities
// ============================================================================

/**
 * Restore keyboard focus to the grid canvas.
 * Used after menu actions, dialogs, etc. to return focus to the spreadsheet.
 */
export function restoreFocusToGrid(): void {
  const canvas = document.querySelector("canvas") as HTMLElement | null;
  if (canvas) {
    canvas.focus();
  }
}