//! FILENAME: app/src/core/lib/formulaReferenceInterceptors.ts
// PURPOSE: Generic formula reference interceptor registry for the grid.
// CONTEXT: Extensions register interceptor functions that can override the
// default cell reference insertion when clicking a cell in formula mode.
// If any interceptor returns a result, the default "A1" reference insertion
// is replaced with the interceptor's custom formula text.
// NOTE: This is a Core primitive. The API layer re-exports it for extensions.

// ============================================================================
// Types
// ============================================================================

/**
 * The result of a formula reference interception.
 * Contains the text to insert and optional cell coordinates for highlighting.
 */
export interface FormulaReferenceOverride {
  /** The formula text to insert (e.g., 'GETPIVOTDATA("Sum of Sales",B5,"Region","North")') */
  text: string;
  /** Row of the cell reference to highlight in the formula bar */
  highlightRow: number;
  /** Column of the cell reference to highlight in the formula bar */
  highlightCol: number;
}

/**
 * An async function that can intercept a formula cell reference insertion.
 * Return a FormulaReferenceOverride to replace the default reference, or null to pass through.
 */
export type FormulaReferenceInterceptorFn = (
  row: number,
  col: number
) => Promise<FormulaReferenceOverride | null>;

// ============================================================================
// Internal State
// ============================================================================

const interceptors = new Set<FormulaReferenceInterceptorFn>();

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register a formula reference interceptor.
 * @param interceptor - Async function that can override formula reference insertion.
 * @returns A cleanup function that unregisters the interceptor.
 */
export function registerFormulaReferenceInterceptor(
  interceptor: FormulaReferenceInterceptorFn
): () => void {
  interceptors.add(interceptor);
  return () => {
    interceptors.delete(interceptor);
  };
}

/**
 * Check all registered formula reference interceptors for a given cell.
 * Returns the first non-null override, or null for default behavior.
 */
export async function checkFormulaReferenceInterceptors(
  row: number,
  col: number
): Promise<FormulaReferenceOverride | null> {
  for (const interceptor of interceptors) {
    try {
      const result = await interceptor(row, col);
      if (result) {
        return result;
      }
    } catch (error) {
      console.error("Error in formula reference interceptor:", error);
    }
  }
  return null;
}
