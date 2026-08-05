//! FILENAME: app/src/core/lib/cellContextMenuInterceptors.ts
// PURPOSE: Generic cell context-menu (right-click) interceptor registry for the grid.
// CONTEXT: Extensions (and the script host, on behalf of a sheet script's
// onBeforeRightClick hook) register interceptor functions that run BEFORE the
// grid's cell context menu is requested. If any interceptor returns true, the
// right-click is considered handled and the context menu is NOT shown.
// NOTE: This is a Core primitive — the exact twin of cellDoubleClickInterceptors
// (which gates edit-mode entry the same way). The API layer re-exports it.

// ============================================================================
// Types
// ============================================================================

/** Minimal event data passed to interceptors. */
export interface CellContextMenuEvent {
  clientX: number;
  clientY: number;
}

/**
 * An async function that can intercept a cell right-click.
 * Return `true` to indicate the right-click was handled (suppresses the
 * context menu). Return `false` to let the next interceptor or the default
 * context menu proceed.
 */
export type CellContextMenuInterceptorFn = (
  row: number,
  col: number,
  event: CellContextMenuEvent
) => Promise<boolean>;

// ============================================================================
// Internal State
// ============================================================================

const interceptors = new Set<CellContextMenuInterceptorFn>();

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register a cell context-menu interceptor.
 * @param interceptor - Async function that can handle a cell right-click.
 * @returns A cleanup function that unregisters the interceptor.
 */
export function registerCellContextMenuInterceptor(
  interceptor: CellContextMenuInterceptorFn
): () => void {
  interceptors.add(interceptor);
  return () => {
    interceptors.delete(interceptor);
  };
}

/** How many interceptors are registered — lets the grid skip the async hop
 *  (and open the menu synchronously) when nobody is listening. */
export function cellContextMenuInterceptorCount(): number {
  return interceptors.size;
}

/**
 * Check all registered cell context-menu interceptors for a given cell.
 * Returns `true` if any interceptor handled (suppressed) the right-click.
 * An interceptor that throws is skipped — a broken interceptor must never
 * take the user's context menu away.
 */
export async function checkCellContextMenuInterceptors(
  row: number,
  col: number,
  event: CellContextMenuEvent
): Promise<boolean> {
  for (const interceptor of interceptors) {
    try {
      if (await interceptor(row, col, event)) {
        return true;
      }
    } catch (error) {
      console.error("Error in cell context-menu interceptor:", error);
    }
  }
  return false;
}
