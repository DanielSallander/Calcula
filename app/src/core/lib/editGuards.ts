//! FILENAME: app/src/core/lib/editGuards.ts
// PURPOSE: Generic edit guard registry for the grid.
// CONTEXT: Extensions register guard functions that can block cell editing.
// The Core's useEditing hook queries this registry before starting an edit,
// without needing to know about any specific extension (e.g., pivot).
// NOTE: This is a Core primitive. The API layer re-exports it for extensions.

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

// ============================================================================
// Range Guard Registry
// ============================================================================

/**
 * WHAT is about to happen to the range a guard is asked about.
 *
 * - `"edit"`: the user is about to type into ONE cell (keystroke, F2,
 *   double-click, the formula bar). The value then goes through the commit
 *   guards, so a guard that only objects to BULK writes can let it through.
 * - `"other"`: anything else, or a caller that did not say -- paste, fill,
 *   drag-move, structural operations, a source-range probe. A guard must treat
 *   it as a bulk write. It is the default, so a call site that predates the
 *   operation kind keeps its old, stricter meaning.
 *
 * Guards that do not care (a pivot, a table header) ignore the argument and
 * block both.
 */
export type RangeGuardOperation = "edit" | "other";

/**
 * A synchronous function that checks whether a range can be modified.
 * Return `{ blocked: true, message }` to prevent the operation.
 * Return `null` to allow (or let the next guard decide).
 */
export type RangeGuardFn = (
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  operation: RangeGuardOperation
) => EditGuardResult | null;

const rangeGuards = new Set<RangeGuardFn>();

/**
 * Register a range guard that can block operations on cell ranges.
 * Used by drag/move/copy operations to check source and destination ranges.
 * @returns A cleanup function that unregisters the guard.
 */
export function registerRangeGuard(guard: RangeGuardFn): () => void {
  rangeGuards.add(guard);
  return () => {
    rangeGuards.delete(guard);
  };
}

/**
 * Check all registered range guards for a given range.
 * Returns the first blocking result, or `null` if all guards allow the operation.
 * `operation` defaults to `"other"` (a bulk write); single-cell edit-start call
 * sites pass `"edit"` -- see {@link RangeGuardOperation}.
 */
export function checkRangeGuards(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  operation: RangeGuardOperation = "other"
): EditGuardResult | null {
  for (const guard of rangeGuards) {
    try {
      const result = guard(startRow, startCol, endRow, endCol, operation);
      if (result?.blocked) {
        return result;
      }
    } catch (error) {
      console.error("Error in range guard:", error);
    }
  }
  return null;
}