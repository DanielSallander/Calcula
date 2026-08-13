//! FILENAME: app/src/core/lib/formulaEditTarget.ts
// PURPOSE: External formula edit session seam for the grid.
// CONTEXT: An extension-owned editor (e.g. a floating object's cell editor)
// can register itself as the active formula edit target. While the target
// reports that it is expecting a reference, grid clicks that would normally
// insert a reference into the internal editor are routed to the target
// instead (see useMouseSelection/useSpreadsheetSelection).
// NOTE: This is a Core primitive. The API layer re-exports it for extensions.

// ============================================================================
// Types
// ============================================================================

/**
 * A grid reference routed to an external formula edit session.
 * Coordinates are normalized (start <= end). sheetName is the ACTIVE sheet's
 * name so external targets can always produce a sheet-qualified reference;
 * null only when no sheet name is available.
 */
export interface ExternalFormulaReference {
  sheetName: string | null;
  startRow: number;
  startCol: number;
  endRow: number;
  endCol: number;
}

/**
 * An external editor that can receive grid cell references while its formula
 * is expecting one (same "expecting reference" semantics as the internal
 * editor's isFormulaExpectingReference check).
 */
export interface ExternalFormulaTarget {
  /** Whether the target's formula currently expects a reference at the cursor. */
  isExpectingReference(): boolean;
  /** Insert the picked reference into the target's formula at the cursor. */
  insertReference(ref: ExternalFormulaReference): void;
}

// ============================================================================
// Internal State
// ============================================================================

// Single slot: at most one external formula edit session can be active.
// A later registration replaces an earlier one (last-writer-wins).
let activeTarget: ExternalFormulaTarget | null = null;

// ============================================================================
// Registry API
// ============================================================================

/**
 * Register an external formula edit target.
 * @returns A cleanup function that unregisters the target. The cleanup is
 * identity-checked: it only clears the slot if this target still occupies it,
 * so a stale cleanup cannot tear down a newer session's registration.
 */
export function registerExternalFormulaTarget(target: ExternalFormulaTarget): () => void {
  activeTarget = target;
  return () => {
    if (activeTarget === target) {
      activeTarget = null;
    }
  };
}

/**
 * Get the currently registered external formula target, or null when none.
 */
export function getExternalFormulaTarget(): ExternalFormulaTarget | null {
  return activeTarget;
}
