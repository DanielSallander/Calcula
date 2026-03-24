//! FILENAME: app/src/api/columnHeaderOverrides.ts
// PURPOSE: Column header override API for extensions.
// CONTEXT: Allows extensions (e.g., Table) to replace column letters (A, B, C...)
//          with custom text (e.g., table field names) in the column header area.
//          Used when a table header row scrolls out of view while the table is selected.

// ============================================================================
// Types
// ============================================================================

/** Override data for a single column header. */
export interface ColumnHeaderOverride {
  /** Text to display instead of the column letter */
  text: string;
  /** Whether to show a filter dropdown button */
  showFilterButton?: boolean;
  /** Whether the filter on this column is active (changes button appearance) */
  hasActiveFilter?: boolean;
}

/**
 * Provider function called during header rendering for each visible column.
 * Return an override to replace the column letter, or null to keep the default.
 *
 * @param col - Zero-based column index
 * @param viewportStartRow - First visible row in the viewport (for scroll detection)
 */
export type ColumnHeaderOverrideProvider = (
  col: number,
  viewportStartRow: number,
) => ColumnHeaderOverride | null;

/**
 * Result of a column header click interception.
 */
export interface ColumnHeaderClickResult {
  /** If true, the click was fully handled (e.g., filter button opened) */
  handled: boolean;
  /**
   * If set, override the column selection to select only these rows
   * instead of all rows (e.g., table-scoped column selection).
   */
  selectionOverride?: { startRow: number; endRow: number };
}

/**
 * Click interceptor for column headers.
 * Called before the default column selection behavior.
 *
 * @param col - Zero-based column index that was clicked
 * @param canvasX - Canvas X coordinate of the click
 * @param canvasY - Canvas Y coordinate of the click
 * @param colX - Pixel X of the column's left edge on canvas
 * @param colWidth - Pixel width of the column
 * @param colHeaderHeight - Height of the column header area
 * @returns Result controlling what happens, or null to use default behavior
 */
export type ColumnHeaderClickInterceptorFn = (
  col: number,
  canvasX: number,
  canvasY: number,
  colX: number,
  colWidth: number,
  colHeaderHeight: number,
) => ColumnHeaderClickResult | null;

// ============================================================================
// Internal State
// ============================================================================

let currentProvider: ColumnHeaderOverrideProvider | null = null;
let clickInterceptor: ColumnHeaderClickInterceptorFn | null = null;

// ============================================================================
// API
// ============================================================================

/**
 * Set the column header override provider.
 * Only one provider can be active at a time (last one wins).
 * Pass null to clear the provider.
 *
 * @returns A cleanup function that clears the provider.
 */
export function setColumnHeaderOverrideProvider(
  provider: ColumnHeaderOverrideProvider | null,
): () => void {
  currentProvider = provider;
  return () => {
    if (currentProvider === provider) {
      currentProvider = null;
    }
  };
}

/**
 * Get the column header override for a specific column.
 * Called by the core header renderer during painting.
 *
 * @param col - Zero-based column index
 * @param viewportStartRow - First visible row in the viewport
 * @returns Override data, or null if no override applies
 */
export function getColumnHeaderOverride(
  col: number,
  viewportStartRow: number,
): ColumnHeaderOverride | null {
  return currentProvider ? currentProvider(col, viewportStartRow) : null;
}

/**
 * Register a column header click interceptor.
 * Called by the core header selection handler before default column selection.
 *
 * @returns A cleanup function that unregisters the interceptor.
 */
export function registerColumnHeaderClickInterceptor(
  interceptor: ColumnHeaderClickInterceptorFn,
): () => void {
  clickInterceptor = interceptor;
  return () => {
    if (clickInterceptor === interceptor) {
      clickInterceptor = null;
    }
  };
}

/**
 * Check the column header click interceptor.
 * Called by the core before default column selection behavior.
 */
export function checkColumnHeaderClickInterceptor(
  col: number,
  canvasX: number,
  canvasY: number,
  colX: number,
  colWidth: number,
  colHeaderHeight: number,
): ColumnHeaderClickResult | null {
  if (!clickInterceptor) return null;
  try {
    return clickInterceptor(col, canvasX, canvasY, colX, colWidth, colHeaderHeight);
  } catch (error) {
    console.error("[ColumnHeaderOverrides] Error in click interceptor:", error);
    return null;
  }
}
