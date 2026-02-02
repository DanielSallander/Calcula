//! FILENAME: app/src/api/events.ts
// PURPOSE: Application-wide event system for decoupled communication.
// CONTEXT: Extensions and Shell use this to communicate without direct coupling.

// ============================================================================
// Event Names
// ============================================================================

export const AppEvents = {
  FREEZE_CHANGED: "calcula:freeze-changed",
  SELECTION_CHANGED: "calcula:selection-changed",
  SHEET_CHANGED: "calcula:sheet-changed",
  DATA_CHANGED: "calcula:data-changed",
  EDIT_STARTED: "calcula:edit-started",
  EDIT_ENDED: "calcula:edit-ended",
  GRID_REFRESH: "calcula:grid-refresh",
  CONTEXT_MENU_REQUEST: "calcula:context-menu-request",
  CONTEXT_MENU_CLOSE: "calcula:context-menu-close",
  NAVIGATE_TO_CELL: "calcula:navigate-to-cell",
  PREVENT_BLUR_COMMIT: "calcula:prevent-blur-commit",
} as const;

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