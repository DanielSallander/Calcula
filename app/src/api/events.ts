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

  // Split window events
  SPLIT_CHANGED: "app:split-changed",

  // View mode events
  VIEW_MODE_CHANGED: "app:view-mode-changed",
  SHOW_FORMULAS_TOGGLED: "app:show-formulas-toggled",
  DISPLAY_ZEROS_TOGGLED: "app:display-zeros-toggled",
  DISPLAY_GRIDLINES_TOGGLED: "app:display-gridlines-toggled",
  DISPLAY_HEADINGS_TOGGLED: "app:display-headings-toggled",
  DISPLAY_FORMULA_BAR_TOGGLED: "app:display-formula-bar-toggled",

  // Selection events
  SELECTION_CHANGED: "app:selection-changed",

  // Sheet events
  SHEET_CHANGED: "app:sheet-changed",

  // Data events
  DATA_CHANGED: "app:data-changed",
  CELLS_UPDATED: "app:cells-updated",
  CELL_VALUES_CHANGED: "app:cell-values-changed",

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
  STRUCTURAL_UNDO: "app:structural-undo",

  // Generic post-mutation refresh. Core emits ONE of these with a list of change
  // DOMAINS (not feature/extension names) after undo/redo/commit; a Shell-side
  // translator fans it out to the per-feature refresh events. This keeps Core
  // feature-agnostic (it no longer dispatches pivot:refresh/slicers:refresh/etc).
  MUTATION_REFRESH: "app:mutation-refresh",

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

  // Annotation events (comments and notes)
  ANNOTATIONS_CHANGED: "app:annotations-changed",

  // Zoom events
  ZOOM_CHANGED: "app:zoom-changed",

  // Document Theme events (Office-style cell-content colors). NOT app appearance.
  THEME_CHANGED: "app:theme-changed",

  // App Appearance / Skin events (application chrome + grid skin). Distinct from
  // THEME_CHANGED so reskinning the app never marks the document dirty.
  APPEARANCE_CHANGED: "app:appearance-changed",

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

  // Linked sheet events
  LINKED_SHEETS_REFRESHED: "app:linked-sheets-refreshed",

  // Reference style events
  REFERENCE_STYLE_CHANGED: "app:reference-style-changed",

  // Locale events
  LOCALE_CHANGED: "app:locale-changed",

  // Status bar text events
  STATUS_BAR_TEXT_CHANGED: "app:status-bar-text-changed",

  // UI focus events
  NAMEBOX_FOCUS: "app:namebox-focus",

  // Ribbon visibility events
  RIBBON_TOGGLE_MINIMIZE: "app:ribbon-toggle-minimize",

  // Chart selection events
  CHART_SELECTION_CHANGED: "app:chart-selection-changed",

  // Dimension events (row/column resize)
  ROW_RESIZED: "app:row-resized",
  COLUMN_RESIZED: "app:column-resized",
} as const;

/**
 * A generic change-domain reported by a MUTATION_REFRESH event. These are
 * change CLASSES, not feature/extension names — Core knows nothing about which
 * extension consumes each. The Shell translator maps each domain to the concrete
 * per-feature refresh event(s).
 */
export type MutationDomain = "styles" | "pivot" | "slicer" | "ribbonFilter" | "paneControl" | "objects";

/** Payload of AppEvents.MUTATION_REFRESH. */
export interface MutationRefreshPayload {
  domains: MutationDomain[];
  source: "undo" | "redo" | "commit";
}

/** A single cell value change within a CELL_VALUES_CHANGED event. */
export interface CellValueChange {
  row: number;
  col: number;
  /**
   * Sheet the change occurred on. Absent means "the active sheet" — the historical
   * implicit contract, kept so existing single-sheet emitters need no change.
   * Cross-sheet emitters (fills/edits that touch other sheets) MUST set it so
   * sheet-scoped consumers (chart invalidation, render-cache staleness) don't
   * mistake an off-sheet edit for an active-sheet one.
   */
  sheetIndex?: number;
  oldValue?: string;
  newValue: string;
  formula?: string | null;
}

/** Payload emitted with CELL_VALUES_CHANGED event. */
export interface CellValuesChangedPayload {
  changes: CellValueChange[];
  source: "user" | "undo" | "redo" | "paste" | "fill" | "clear" | "script" | "api";
}

/**
 * OPTIONAL payload on the CELLS_UPDATED event. CELLS_UPDATED remains a fire-on-
 * every-change signal that may be emitted bare; when the changed cells are known
 * (the canonical cellEvents path) they ride along here so subscribers can scope
 * their work (e.g. invalidate only charts whose range intersects a change). Uses
 * the `changes` key only (never top-level row/col) — handlers must treat it as
 * possibly-absent and fall back to a full refresh.
 */
export interface CellsUpdatedPayload {
  changes: CellValueChange[];
}

/** Payload emitted with FILL_COMPLETED event. */
export interface FillCompletedPayload {
  sourceRange: { startRow: number; startCol: number; endRow: number; endCol: number };
  targetRange: { startRow: number; startCol: number; endRow: number; endCol: number };
  direction: "down" | "up" | "right" | "left";
}

export type AppEventName = (typeof AppEvents)[keyof typeof AppEvents];

// ============================================================================
// User-script event namespacing (sandbox design §5, R5)
// ============================================================================

/**
 * Namespace prefix for events emitted by object scripts. Force-prefixing on
 * BOTH emit and subscribe (symmetric) means scripts using their own custom
 * names see no behavior change, while internal control events (e.g.
 * shape:setCanvasRenderer) can never be forged or observed by scripts.
 */
export const USERSCRIPT_EVENT_PREFIX = "userscript:";

/** Apply the userscript namespace to a custom event name (idempotent). */
export function namespaceUserEvent(name: string): string {
  return name.startsWith(USERSCRIPT_EVENT_PREFIX) ? name : USERSCRIPT_EVENT_PREFIX + name;
}

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