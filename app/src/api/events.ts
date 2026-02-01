//! FILENAME: app/src/api/events.ts
// PURPOSE: Re-exports the Core event system for extension consumption.
// CONTEXT: Extensions import events from this API module (not from Core).
// The event primitives are defined in core/lib/events.ts.

// Re-export the event system from Core
export { AppEvents, emitAppEvent, onAppEvent } from "../core/lib/events";
export type { AppEventType } from "../core/lib/events";

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
