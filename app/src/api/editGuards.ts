//! FILENAME: app/src/api/editGuards.ts
// PURPOSE: Generic edit guard registry for the grid.
// CONTEXT: Extensions register guard functions that can block cell editing.
// The Core's useEditing hook queries this registry before starting an edit,
// without needing to know about any specific extension (e.g., pivot).
// Follows the same pattern as gridOverlays.ts.

// ============================================================================
// Types
// ============================================================================

/** Result returned by an edit guard when it blocks editing. */
export interface EditGuardResult {
  /** Whether the edit is blocked. */
  blocked: boolean;
  /** Optional message to display to the user. */
  message?: string;
}

/**
 * An async function that checks whether a cell can be edited.
 * Return `{ blocked: true, message }` to prevent editing.
 * Return `null` to allow editing (or let the next guard decide).
 */
export type EditGuardFn = (
  row: number,
  col: number
) => Promise<EditGuardResult | null>;

// ============================================================================
// Internal State
// ============================================================================

const guards = new Set<EditGuardFn>();

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register an edit guard that can block cell editing.
 * @param guard - Async function that checks whether a cell can be edited.
 * @returns A cleanup function that unregisters the guard.
 */
export function registerEditGuard(guard: EditGuardFn): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

/**
 * Check all registered edit guards for a given cell.
 * Returns the first blocking result, or `null` if all guards allow editing.
 */
export async function checkEditGuards(
  row: number,
  col: number
): Promise<EditGuardResult | null> {
  for (const guard of guards) {
    try {
      const result = await guard(row, col);
      if (result?.blocked) {
        return result;
      }
    } catch (error) {
      console.error("Error in edit guard:", error);
    }
  }
  return null;
}
