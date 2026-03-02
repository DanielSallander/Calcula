//! FILENAME: app/extensions/Controls/Button/floatingSelection.ts
// PURPOSE: Track which floating control is currently selected.
// CONTEXT: Used by the floating renderer to draw selection indicators
//          and by the index to manage properties pane visibility.

// ============================================================================
// State
// ============================================================================

let selectedControlId: string | null = null;

// ============================================================================
// API
// ============================================================================

/** Get the currently selected floating control ID. */
export function getSelectedFloatingControl(): string | null {
  return selectedControlId;
}

/** Check if a specific floating control is selected. */
export function isFloatingControlSelected(controlId: string): boolean {
  return selectedControlId === controlId;
}

/** Select a floating control. */
export function selectFloatingControl(controlId: string): void {
  selectedControlId = controlId;
}

/** Deselect the current floating control. */
export function deselectFloatingControl(): void {
  selectedControlId = null;
}
