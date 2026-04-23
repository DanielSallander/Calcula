//! FILENAME: app/extensions/Controls/Button/floatingSelection.ts
// PURPOSE: Track which floating controls are currently selected.
// CONTEXT: Supports both single and multi-selection (Ctrl+Click).
//          Used by renderers for selection indicators and by index.ts
//          for properties pane and group operations.

// ============================================================================
// State
// ============================================================================

const selectedControlIds: Set<string> = new Set();

// ============================================================================
// API
// ============================================================================

/** Get the currently selected floating control ID (primary / first). */
export function getSelectedFloatingControl(): string | null {
  if (selectedControlIds.size === 0) return null;
  // Return first selected
  return selectedControlIds.values().next().value ?? null;
}

/** Get all selected floating control IDs. */
export function getSelectedFloatingControls(): Set<string> {
  return selectedControlIds;
}

/** Check if a specific floating control is selected. */
export function isFloatingControlSelected(controlId: string): boolean {
  return selectedControlIds.has(controlId);
}

/** Select a floating control (replaces current selection unless additive). */
export function selectFloatingControl(controlId: string, additive = false): void {
  if (!additive) {
    selectedControlIds.clear();
  }
  selectedControlIds.add(controlId);
}

/** Toggle selection of a floating control (for Ctrl+Click). */
export function toggleFloatingControlSelection(controlId: string): void {
  if (selectedControlIds.has(controlId)) {
    selectedControlIds.delete(controlId);
  } else {
    selectedControlIds.add(controlId);
  }
}

/** Select multiple floating controls (replaces current selection). */
export function selectFloatingControls(controlIds: string[]): void {
  selectedControlIds.clear();
  for (const id of controlIds) {
    selectedControlIds.add(id);
  }
}

/** Deselect the current floating control(s). */
export function deselectFloatingControl(): void {
  selectedControlIds.clear();
}

/** Get the count of selected controls. */
export function getSelectedControlCount(): number {
  return selectedControlIds.size;
}
