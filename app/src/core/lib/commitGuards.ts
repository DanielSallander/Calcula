//! FILENAME: app/src/core/lib/commitGuards.ts
// PURPOSE: Generic commit guard registry for the grid.
// CONTEXT: Extensions register guard functions that can block or modify cell commits.
// The Core's useEditing hook queries this registry before writing a cell value,
// without needing to know about any specific extension (e.g., data validation).
// NOTE: This is a Core primitive. The API layer re-exports it for extensions.

// ============================================================================
// Types
// ============================================================================

/** Result returned by a commit guard. */
export interface CommitGuardResult {
  /** What action to take:
   * - "allow" = proceed with the commit
   * - "block" = cancel the commit entirely, revert cell to previous value
   * - "retry" = keep the cell in edit mode so the user can correct the value
   */
  action: "allow" | "block" | "retry";
  /**
   * Optional replacement value when action is "allow" — the commit proceeds
   * with this string instead of what the user typed (e.g. a cell type
   * coercing "yes" to "TRUE"). Rewrites chain: later guards see the rewritten
   * value.
   */
  newValue?: string;
}

/**
 * An async function that checks whether a cell value can be committed.
 * Return a CommitGuardResult to control the commit behavior.
 * Return `null` to allow the commit (no objection from this guard).
 *
 * The guard function may show UI (dialogs, modals) and wait for user input
 * before returning. The commit will pause until the guard resolves.
 */
export type CommitGuardFn = (
  row: number,
  col: number,
  value: string
) => Promise<CommitGuardResult | null>;

// ============================================================================
// Internal State
// ============================================================================

const guards = new Set<CommitGuardFn>();

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register a commit guard that can block or modify cell commits.
 * @param guard - Async function that checks whether a cell value can be committed.
 * @returns A cleanup function that unregisters the guard.
 */
export function registerCommitGuard(guard: CommitGuardFn): () => void {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}

/**
 * Check all registered commit guards for a given cell and value.
 * Returns the first non-allow result; an allow-with-`newValue` when any guard
 * rewrote the value (rewrites chain through subsequent guards); or `null`
 * when all guards allow the commit unchanged.
 */
export async function checkCommitGuards(
  row: number,
  col: number,
  value: string
): Promise<CommitGuardResult | null> {
  let current = value;
  for (const guard of guards) {
    try {
      const result = await guard(row, col, current);
      if (result && result.action !== "allow") {
        return result;
      }
      if (result && typeof result.newValue === "string") {
        current = result.newValue;
      }
    } catch (error) {
      console.error("Error in commit guard:", error);
    }
  }
  return current !== value ? { action: "allow", newValue: current } : null;
}
