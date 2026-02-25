//! FILENAME: app/src/core/lib/cellDoubleClickInterceptors.ts
// PURPOSE: Generic cell double-click interceptor registry for the grid.
// CONTEXT: Extensions register interceptor functions that can handle cell double-clicks
// before the Core's default edit-mode behavior runs. If any interceptor returns
// true, the double-click is considered handled and edit mode is not entered.
// NOTE: This is a Core primitive. The API layer re-exports it for extensions.

// ============================================================================
// Types
// ============================================================================

/** Minimal click event data passed to interceptors. */
export interface CellDoubleClickEvent {
  clientX: number;
  clientY: number;
}

/**
 * An async function that can intercept a cell double-click.
 * Return `true` to indicate the double-click was handled (prevents edit mode).
 * Return `false` to let the next interceptor or default behavior proceed.
 */
export type CellDoubleClickInterceptorFn = (
  row: number,
  col: number,
  event: CellDoubleClickEvent
) => Promise<boolean>;

// ============================================================================
// Internal State
// ============================================================================

const interceptors = new Set<CellDoubleClickInterceptorFn>();

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register a cell double-click interceptor.
 * @param interceptor - Async function that can handle a cell double-click.
 * @returns A cleanup function that unregisters the interceptor.
 */
export function registerCellDoubleClickInterceptor(
  interceptor: CellDoubleClickInterceptorFn
): () => void {
  interceptors.add(interceptor);
  return () => {
    interceptors.delete(interceptor);
  };
}

/**
 * Check all registered cell double-click interceptors for a given cell.
 * Returns `true` if any interceptor handled the double-click.
 */
export async function checkCellDoubleClickInterceptors(
  row: number,
  col: number,
  event: CellDoubleClickEvent
): Promise<boolean> {
  for (const interceptor of interceptors) {
    try {
      if (await interceptor(row, col, event)) {
        return true;
      }
    } catch (error) {
      console.error("Error in cell double-click interceptor:", error);
    }
  }
  return false;
}
