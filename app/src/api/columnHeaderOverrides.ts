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
// Internal State (multi-provider: granular bricks phase 3 generalized the
// original single last-wins slot into priority-ordered registries)
// ============================================================================

interface ProviderRegistration {
  provider: ColumnHeaderOverrideProvider;
  priority: number;
}

const providers: ProviderRegistration[] = [];
const clickInterceptors = new Set<ColumnHeaderClickInterceptorFn>();

// ============================================================================
// API
// ============================================================================

/**
 * Register a column-header override provider. Lower priority is consulted
 * first; the first non-null override wins. Multiple extensions can register
 * concurrently (Table + AutoFilter no longer clobber each other's slot).
 *
 * @returns A cleanup function that unregisters the provider.
 */
export function registerColumnHeaderOverrideProvider(
  provider: ColumnHeaderOverrideProvider,
  priority: number = 0,
): () => void {
  const registration = { provider, priority };
  providers.push(registration);
  providers.sort((a, b) => a.priority - b.priority);
  return () => {
    const i = providers.indexOf(registration);
    if (i >= 0) providers.splice(i, 1);
  };
}

/**
 * Set a column header override provider (legacy single-slot signature, kept
 * for existing callers). Registers into the multi-provider registry at
 * default priority; pass null as a no-op that returns a no-op cleanup.
 *
 * @returns A cleanup function that unregisters the provider.
 */
export function setColumnHeaderOverrideProvider(
  provider: ColumnHeaderOverrideProvider | null,
): () => void {
  if (!provider) return () => {};
  return registerColumnHeaderOverrideProvider(provider);
}

/**
 * Get the column header override for a specific column: the first non-null
 * answer across providers in priority order.
 * Called by the core header renderer during painting.
 */
export function getColumnHeaderOverride(
  col: number,
  viewportStartRow: number,
): ColumnHeaderOverride | null {
  for (const r of providers) {
    try {
      const override = r.provider(col, viewportStartRow);
      if (override) return override;
    } catch (error) {
      console.error("[ColumnHeaderOverrides] Error in provider:", error);
    }
  }
  return null;
}

/**
 * Register a column header click interceptor. Multiple interceptors may
 * register; the first non-null result wins.
 *
 * @returns A cleanup function that unregisters the interceptor.
 */
export function registerColumnHeaderClickInterceptor(
  interceptor: ColumnHeaderClickInterceptorFn,
): () => void {
  clickInterceptors.add(interceptor);
  return () => {
    clickInterceptors.delete(interceptor);
  };
}

/**
 * Check the column header click interceptors (first non-null result wins).
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
  for (const interceptor of clickInterceptors) {
    try {
      const result = interceptor(col, canvasX, canvasY, colX, colWidth, colHeaderHeight);
      if (result) return result;
    } catch (error) {
      console.error("[ColumnHeaderOverrides] Error in click interceptor:", error);
    }
  }
  return null;
}
