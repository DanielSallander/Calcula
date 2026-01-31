//! FILENAME: app/src/api/cellClickInterceptors.ts
// PURPOSE: Generic cell click interceptor registry for the grid.
// CONTEXT: Extensions register interceptor functions that can handle cell clicks
// before the Core's default selection behavior runs. If any interceptor returns
// true, the click is considered handled and default behavior is suppressed.
// Follows the same pattern as gridOverlays.ts.

// ============================================================================
// Types
// ============================================================================

/** Minimal click event data passed to interceptors. */
export interface CellClickEvent {
  clientX: number;
  clientY: number;
}

/**
 * An async function that can intercept a cell click.
 * Return `true` to indicate the click was handled (prevents default behavior).
 * Return `false` to let the next interceptor or default behavior proceed.
 */
export type CellClickInterceptorFn = (
  row: number,
  col: number,
  event: CellClickEvent
) => Promise<boolean>;

// ============================================================================
// Internal State
// ============================================================================

const interceptors = new Set<CellClickInterceptorFn>();

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register a cell click interceptor.
 * @param interceptor - Async function that can handle a cell click.
 * @returns A cleanup function that unregisters the interceptor.
 */
export function registerCellClickInterceptor(
  interceptor: CellClickInterceptorFn
): () => void {
  interceptors.add(interceptor);
  return () => {
    interceptors.delete(interceptor);
  };
}

/**
 * Check all registered cell click interceptors for a given cell.
 * Returns `true` if any interceptor handled the click.
 */
export async function checkCellClickInterceptors(
  row: number,
  col: number,
  event: CellClickEvent
): Promise<boolean> {
  for (const interceptor of interceptors) {
    try {
      if (await interceptor(row, col, event)) {
        return true;
      }
    } catch (error) {
      console.error("Error in cell click interceptor:", error);
    }
  }
  return false;
}
