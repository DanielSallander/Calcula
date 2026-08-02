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

  // Split window events
  SPLIT_CHANGED: "app:split-changed",

  // Navigation events
  NAVIGATE_TO_CELL: "app:navigate-to-cell",

  // Cell events
  CELLS_UPDATED: "app:cells-updated",
  CELL_VALUES_CHANGED: "app:cell-values-changed",

  // Context Menu events
  CONTEXT_MENU_REQUEST: "app:context-menu-request",
  CONTEXT_MENU_CLOSE: "app:context-menu-close",

  // Grid events
  GRID_REFRESH: "app:grid-refresh",
  GRID_DATA_REFRESH: "grid:refresh",

  // Generic post-mutation refresh (see api/events.ts). Core emits ONE of these
  // with a list of change domains; a Shell translator fans it out to the
  // per-feature refresh events, so Core never names a feature.
  MUTATION_REFRESH: "app:mutation-refresh",

  // Structure events (row/column insert/delete).
  //
  // Emitted by the tauri-api wrappers themselves, so EVERY caller announces the
  // edit — not just the toolbar. Payload:
  //   ROWS_INSERTED / ROWS_DELETED       { startRow: number; count: number }
  //   COLUMNS_INSERTED / COLUMNS_DELETED { startCol: number; count: number }
  // These commands always act on the ACTIVE sheet, so no sheet index is
  // carried. This payload is visible to user scripts (see the scriptHost
  // allowlist), so treat its shape as public.
  ROWS_INSERTED: "app:rows-inserted",
  COLUMNS_INSERTED: "app:columns-inserted",
  ROWS_DELETED: "app:rows-deleted",
  COLUMNS_DELETED: "app:columns-deleted",

  // Sheet events. SHEET_CHANGED is "the ACTIVE sheet changed"; the three below
  // report the sheet COLLECTION changing (added / deleted / renamed) and are
  // emitted by the tauri-api sheet wrappers, so every caller announces it.
  // Payloads mirror api/events.ts (SheetAddedPayload / SheetDeletedPayload /
  // SheetRenamedPayload) and are visible to user scripts — treat as public.
  SHEET_CHANGED: "app:sheet-changed",
  SHEET_ADDED: "app:sheet-added",
  SHEET_DELETED: "app:sheet-deleted",
  SHEET_RENAMED: "app:sheet-renamed",

  // An explicit recalculation pass finished (calculate_now / calculate_sheet).
  // Payload: { scope, cellsUpdated, durationMs }.
  RECALCULATION_COMPLETED: "app:recalculation-completed",

  // A recalculation pass is running (backend, ~100 ms clock). Payload:
  // { scope, cellsDone, cellsTotal, elapsedMs, done, cancelled, pendingCells }.
  CALC_PROGRESS: "app:calc-progress",
  // A recalculation was cancelled; some cells are stale. Payload:
  // { sheetIndex, cellCount }.
  RECALC_INCOMPLETE: "app:recalc-incomplete",

  // Editing events
  EDIT_STARTED: "app:edit-started",
  EDIT_ENDED: "app:edit-ended",
  PREVENT_BLUR_COMMIT: "app:prevent-blur-commit",

  // Workbook lifecycle events
  BEFORE_SAVE: "app:before-save",
  AFTER_SAVE: "app:after-save",
  BEFORE_OPEN: "app:before-open",
  AFTER_OPEN: "app:after-open",
  BEFORE_NEW: "app:before-new",
  AFTER_NEW: "app:after-new",
  BEFORE_CLOSE: "app:before-close",

  // Dirty state events
  DIRTY_STATE_CHANGED: "app:dirty-state-changed",
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
