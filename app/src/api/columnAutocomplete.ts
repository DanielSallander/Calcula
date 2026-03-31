//! FILENAME: app/src/api/columnAutocomplete.ts
// PURPOSE: API bridge for column value autocomplete (Excel-style).
// CONTEXT: Provides a module-level visibility flag that Core editors can check
// synchronously in handleKeyDown, plus event constants for decoupled communication.
// Similar to formulaAutocomplete.ts but for non-formula cell editing.

// ============================================================================
// Visibility Flag (module-level for synchronous reads from Core)
// ============================================================================

let _columnAutocompleteVisible = false;

/**
 * Check if the column value autocomplete dropdown is currently visible.
 * Used by InlineEditor to intercept keyboard events (Tab, Enter, Arrow, Escape).
 */
export function isColumnAutocompleteVisible(): boolean {
  return _columnAutocompleteVisible;
}

/**
 * Set the column autocomplete visibility flag.
 * Called by the ColumnValueAutocomplete extension when showing/hiding.
 */
export function setColumnAutocompleteVisible(visible: boolean): void {
  _columnAutocompleteVisible = visible;
}

// ============================================================================
// Event Constants
// ============================================================================

export const ColumnAutocompleteEvents = {
  /** Emitted by the extension when a keyboard event needs handling */
  KEY: "column-autocomplete:key",
  /** Emitted by the extension when a value is accepted (inserted) */
  ACCEPTED: "column-autocomplete:accepted",
} as const;

// ============================================================================
// Payload Types
// ============================================================================

export interface ColumnAutocompleteAcceptedPayload {
  newValue: string;
}
