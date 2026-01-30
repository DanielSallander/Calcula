//! FILENAME: app/src/api/events.ts
// PURPOSE: Application-wide events that extensions can listen to and emit.
// CONTEXT: This replaces direct imports between layers (e.g., MenuEvents from shell).
// Extensions and core can use these events without creating circular dependencies.

/**
 * Application events that can be emitted and listened to.
 * Use these instead of importing events from shell or core directly.
 *
 * NOTE: Event names use 'menu:' prefix for backward compatibility with existing code.
 * Future versions may migrate to 'app:' prefix.
 */
export const AppEvents = {
  // Menu/Clipboard events
  CUT: "menu:cut",
  COPY: "menu:copy",
  PASTE: "menu:paste",
  FIND: "menu:find",
  REPLACE: "menu:replace",

  // Freeze pane events
  FREEZE_CHANGED: "menu:freezeChanged",

  // Cell merge events
  CELLS_MERGED: "menu:cellsMerged",
  CELLS_UNMERGED: "menu:cellsUnmerged",

  // Grid refresh
  GRID_REFRESH: "grid:refresh",

  // Editor events
  PREVENT_BLUR_COMMIT: "editor:preventBlurCommit",

  // Pivot events (extensions emit these)
  PIVOT_CREATED: "menu:pivotCreated",
  PIVOT_REGIONS_UPDATED: "pivot:regionsUpdated",
  PIVOT_OPEN_FILTER_MENU: "pivot:openFilterMenu",
} as const;

export type AppEventType = (typeof AppEvents)[keyof typeof AppEvents];

/**
 * Emit an application event.
 * @param event - The event type from AppEvents
 * @param detail - Optional event data
 */
export function emitAppEvent(event: AppEventType, detail?: unknown): void {
  window.dispatchEvent(new CustomEvent(event, { detail }));
}

/**
 * Listen to an application event.
 * @param event - The event type from AppEvents
 * @param handler - The event handler
 * @returns A cleanup function to remove the listener
 */
export function onAppEvent<T = unknown>(
  event: AppEventType,
  handler: (detail: T) => void
): () => void {
  const listener = (e: Event) => {
    const customEvent = e as CustomEvent<T>;
    handler(customEvent.detail);
  };
  window.addEventListener(event, listener);
  return () => window.removeEventListener(event, listener);
}

/**
 * Restore focus to the spreadsheet grid.
 * Useful after menu interactions.
 */
export function restoreFocusToGrid(): void {
  setTimeout(() => {
    const focusContainer = document.querySelector(
      '[tabindex="0"][style*="outline: none"]'
    ) as HTMLElement;
    if (focusContainer) {
      focusContainer.focus();
    }
  }, 0);
}
