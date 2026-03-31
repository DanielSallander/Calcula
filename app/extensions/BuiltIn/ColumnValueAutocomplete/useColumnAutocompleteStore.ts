//! FILENAME: app/extensions/BuiltIn/ColumnValueAutocomplete/useColumnAutocompleteStore.ts
// PURPOSE: Zustand store managing column value autocomplete state.
// CONTEXT: Central state machine for the autocomplete dropdown. Listens to editor
// input events (shared with formula autocomplete) and shows matching values from
// the same column when not editing a formula.

import { create } from "zustand";
import {
  setColumnAutocompleteVisible,
  ColumnAutocompleteEvents,
} from "../../../src/api/columnAutocomplete";
import type { AutocompleteInputPayload } from "../../../src/api/formulaAutocomplete";
import { getCellsInCols } from "../../../src/api/lib";

// ============================================================================
// Column Value Cache
// ============================================================================

/** Cached unique text values per column, keyed by column index */
const columnValueCache = new Map<number, string[]>();

/**
 * Invalidate all cached column values (e.g., when cells change).
 */
export function invalidateColumnValueCache(): void {
  columnValueCache.clear();
}

/**
 * Fetch unique non-empty text values for a column, using cache if available.
 */
async function getUniqueColumnValues(col: number): Promise<string[]> {
  const cached = columnValueCache.get(col);
  if (cached) return cached;

  const cells = await getCellsInCols(col, col);
  const seen = new Set<string>();
  const values: string[] = [];

  for (const cell of cells) {
    // Use display value; skip formulas, empty, and numeric-only values
    const text = cell.display?.trim();
    if (!text) continue;
    // Skip if it looks like a pure number (users rarely want to autocomplete numbers)
    if (/^-?\d[\d.,]*%?$/.test(text)) continue;
    const lower = text.toLowerCase();
    if (!seen.has(lower)) {
      seen.add(lower);
      values.push(text);
    }
  }

  // Sort alphabetically for predictable ordering
  values.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  columnValueCache.set(col, values);
  return values;
}

// ============================================================================
// Store Interface
// ============================================================================

interface ColumnAutocompleteState {
  /** Whether the dropdown is visible */
  visible: boolean;
  /** Filtered suggestion list */
  items: string[];
  /** Currently selected (highlighted) index */
  selectedIndex: number;
  /** Position to anchor the dropdown below */
  anchorRect: { x: number; y: number; width: number; height: number } | null;
  /** Current column being edited */
  currentCol: number;
  /** Current row being edited (excluded from suggestions) */
  currentRow: number;
  /** Current typed value */
  currentValue: string;

  // --- Actions ---
  handleInput: (payload: AutocompleteInputPayload, row: number, col: number) => void;
  handleKey: (key: string) => void;
  accept: (index?: number) => void;
  dismiss: () => void;
  reset: () => void;
}

// ============================================================================
// Store
// ============================================================================

export const useColumnAutocompleteStore = create<ColumnAutocompleteState>(
  (set, get) => ({
    // Initial state
    visible: false,
    items: [],
    selectedIndex: 0,
    anchorRect: null,
    currentCol: -1,
    currentRow: -1,
    currentValue: "",

    /**
     * Handle input from an editor. Only triggers for non-formula values.
     */
    handleInput: (
      payload: AutocompleteInputPayload,
      row: number,
      col: number
    ) => {
      const { value, anchorRect, source } = payload;

      // Only respond to inline editor events - the formula bar also emits
      // autocomplete:input events with its own anchorRect (at the top of
      // the screen), which would misposition the dropdown.
      if (source !== "inline") {
        if (get().visible) get().dismiss();
        return;
      }

      // Skip formulas - FormulaAutocomplete handles those
      if (value.startsWith("=")) {
        if (get().visible) get().dismiss();
        return;
      }

      // Skip empty values or very short values (need at least 1 character)
      if (!value.trim()) {
        if (get().visible) get().dismiss();
        return;
      }

      // Store current state for async callback
      const typedValue = value;

      // Fetch unique column values (may be cached) and filter
      getUniqueColumnValues(col).then((allValues) => {
        // Check if the input has changed since we started the async fetch
        const currentState = get();
        // Filter: prefix match, case-insensitive, exclude exact match
        const prefix = typedValue.toLowerCase();
        const matches = allValues.filter((v) => {
          const lower = v.toLowerCase();
          return lower.startsWith(prefix) && lower !== prefix;
        });

        if (matches.length > 0) {
          // Preserve selected index if same item is still in list
          let newIndex = 0;
          if (
            currentState.visible &&
            currentState.items.length > 0 &&
            currentState.selectedIndex < currentState.items.length
          ) {
            const prevItem = currentState.items[currentState.selectedIndex];
            const sameIdx = matches.indexOf(prevItem);
            if (sameIdx >= 0) newIndex = sameIdx;
          }

          set({
            visible: true,
            items: matches,
            selectedIndex: newIndex,
            anchorRect,
            currentCol: col,
            currentRow: row,
            currentValue: typedValue,
          });
          setColumnAutocompleteVisible(true);
        } else {
          if (currentState.visible) {
            get().dismiss();
          }
        }
      });
    },

    /**
     * Handle a keyboard event forwarded from the editor.
     */
    handleKey: (key: string) => {
      const state = get();
      if (!state.visible) return;

      switch (key) {
        case "ArrowDown":
          set({
            selectedIndex: Math.min(
              state.selectedIndex + 1,
              state.items.length - 1
            ),
          });
          break;
        case "ArrowUp":
          set({
            selectedIndex: Math.max(state.selectedIndex - 1, 0),
          });
          break;
        case "Tab":
        case "Enter":
          state.accept(state.selectedIndex);
          break;
        case "Escape":
          state.dismiss();
          break;
      }
    },

    /**
     * Accept the selected suggestion: replace the entire cell value.
     */
    accept: (index?: number) => {
      const state = get();
      const idx = index ?? state.selectedIndex;
      const item = state.items[idx];
      if (!item) return;

      // Emit ACCEPTED event so the editor updates its value
      window.dispatchEvent(
        new CustomEvent(ColumnAutocompleteEvents.ACCEPTED, {
          detail: { newValue: item },
        })
      );

      set({
        visible: false,
        items: [],
        selectedIndex: 0,
        currentValue: item,
      });
      setColumnAutocompleteVisible(false);
    },

    /**
     * Dismiss the dropdown.
     */
    dismiss: () => {
      if (get().visible) {
        set({
          visible: false,
          items: [],
          selectedIndex: 0,
        });
        setColumnAutocompleteVisible(false);
      }
    },

    /**
     * Reset all state (called when editing ends).
     */
    reset: () => {
      set({
        visible: false,
        items: [],
        selectedIndex: 0,
        anchorRect: null,
        currentCol: -1,
        currentRow: -1,
        currentValue: "",
      });
      setColumnAutocompleteVisible(false);
    },
  })
);
