//! FILENAME: app/src/api/formulaAutocomplete.ts
// PURPOSE: API bridge for formula autocomplete (Intellisense).
// CONTEXT: Provides a module-level visibility flag that Core editors can check
// synchronously in handleKeyDown, plus event constants for decoupled communication.

// ============================================================================
// Visibility Flag (module-level for synchronous reads from Core)
// ============================================================================

let _autocompleteVisible = false;

/**
 * Check if the formula autocomplete dropdown is currently visible.
 * Used by InlineEditor and FormulaInput to intercept keyboard events.
 */
export function isFormulaAutocompleteVisible(): boolean {
  return _autocompleteVisible;
}

/**
 * Set the autocomplete visibility flag.
 * Called by the FormulaAutocomplete extension when showing/hiding.
 */
export function setFormulaAutocompleteVisible(visible: boolean): void {
  _autocompleteVisible = visible;
}

// ============================================================================
// Event Constants
// ============================================================================

export const AutocompleteEvents = {
  /** Emitted by editors on input change / cursor move */
  INPUT: "autocomplete:input",
  /** Emitted by editors when a navigation key is pressed while autocomplete is visible */
  KEY: "autocomplete:key",
  /** Emitted by the extension when a function is accepted (inserted) */
  ACCEPTED: "autocomplete:accepted",
  /** Emitted to dismiss the autocomplete dropdown */
  DISMISS: "autocomplete:dismiss",
} as const;

// ============================================================================
// Payload Types
// ============================================================================

export interface AutocompleteInputPayload {
  value: string;
  cursorPosition: number;
  anchorRect: { x: number; y: number; width: number; height: number };
  source: "inline" | "formulaBar";
}

export interface AutocompleteKeyPayload {
  key: "ArrowUp" | "ArrowDown" | "Tab" | "Enter" | "Escape";
}

export interface AutocompleteAcceptedPayload {
  newValue: string;
  newCursorPosition: number;
}
