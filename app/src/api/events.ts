//! FILENAME: app/src/api/events.ts
// PURPOSE: Application-wide event system for decoupled communication
// CONTEXT: Enables Core to emit events that Shell/Extensions can listen to
// without creating import dependencies.

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

  // Context Menu events (NEW)
  CONTEXT_MENU_REQUEST: "app:context-menu-request",
  CONTEXT_MENU_CLOSE: "app:context-menu-close",
} as const;

export type AppEventType = (typeof AppEvents)[keyof typeof AppEvents];

// ============================================================================
// Event Emission
// ============================================================================

/**
 * Emit an application event.
 * @param event The event type to emit
 * @param detail Optional detail payload
 */
export function emitAppEvent(event: AppEventType, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(event, { detail }));
}

// ============================================================================
// Event Subscription
// ============================================================================

/**
 * Subscribe to an application event.
 * @param event The event type to listen for
 * @param callback The callback to invoke when the event fires
 * @returns Cleanup function to remove the listener
 */
export function onAppEvent<T = unknown>(
  event: AppEventType,
  callback: (detail: T) => void
): () => void {
  const handler = (e: Event) => {
    const customEvent = e as CustomEvent<T>;
    callback(customEvent.detail);
  };

  window.addEventListener(event, handler);
  return () => window.removeEventListener(event, handler);
}

// ============================================================================
// Focus Management
// ============================================================================

/**
 * Restore focus to the grid container.
 * This is useful after dialogs or overlays close.
 */
export function restoreFocusToGrid(): void {
  // Find the spreadsheet focus container and focus it
  const focusContainer = document.querySelector(
    '[data-focus-container="spreadsheet"]'
  ) as HTMLElement | null;
  if (focusContainer) {
    focusContainer.focus();
  }
}