//! FILENAME: app/extensions/BuiltIn/FormulaAutocomplete/useAutocompleteStore.ts
// PURPOSE: Zustand store managing all formula autocomplete state.
// CONTEXT: Central state machine for the autocomplete dropdown and argument hints.
// The extension's event listeners call actions on this store, and the overlay
// component subscribes to state changes.

import { create } from "zustand";
import {
  setFormulaAutocompleteVisible,
  AutocompleteEvents,
} from "../../../src/api/formulaAutocomplete";
import type { AutocompleteInputPayload } from "../../../src/api/formulaAutocomplete";
import { isFormulaExpectingReference } from "../../../src/api/types";
import { parseTokenAtCursor } from "./tokenParser";
import type { TokenContext } from "./tokenParser";
import { filterFunctions, loadFunctionCatalog, getFunctionByName } from "./functionCatalog";
import type { ScoredFunction } from "./functionCatalog";
import type { FunctionInfo } from "../../../src/api/types";

// ============================================================================
// Store Interface
// ============================================================================

interface AutocompleteState {
  // --- Dropdown state ---
  /** Whether the function list dropdown is visible */
  visible: boolean;
  /** Filtered and scored function list */
  items: ScoredFunction[];
  /** Currently selected (highlighted) index in the dropdown */
  selectedIndex: number;
  /** Current token context from the parser */
  tokenContext: TokenContext | null;
  /** Position to anchor the dropdown below */
  anchorRect: { x: number; y: number; width: number; height: number } | null;
  /** Which editor emitted the last input event */
  source: "inline" | "formulaBar" | null;

  // --- Argument hints state ---
  /** Whether the argument hint tooltip is visible */
  argumentHintVisible: boolean;
  /** The function whose arguments to display */
  argumentHintFunction: FunctionInfo | null;
  /** Which argument is active (0-based) */
  argumentHintIndex: number;

  // --- Current formula state (for accept logic) ---
  currentValue: string;
  currentCursorPosition: number;

  // --- Actions ---
  loadFunctions: () => Promise<void>;
  handleInput: (payload: AutocompleteInputPayload) => void;
  handleKey: (key: string) => void;
  accept: (index?: number) => void;
  dismiss: () => void;
  reset: () => void;
}

// ============================================================================
// Store
// ============================================================================

export const useAutocompleteStore = create<AutocompleteState>((set, get) => ({
  // Initial state
  visible: false,
  items: [],
  selectedIndex: 0,
  tokenContext: null,
  anchorRect: null,
  source: null,
  argumentHintVisible: false,
  argumentHintFunction: null,
  argumentHintIndex: -1,
  currentValue: "",
  currentCursorPosition: 0,

  /**
   * Load the function catalog from the backend (called once at activation).
   */
  loadFunctions: async () => {
    await loadFunctionCatalog();
  },

  /**
   * Handle input from an editor (value change or cursor move).
   * Determines whether to show/hide the dropdown and argument hints.
   */
  handleInput: (payload: AutocompleteInputPayload) => {
    const { value, cursorPosition, anchorRect, source } = payload;
    console.log("[FormulaAutocomplete] handleInput:", { value, cursorPosition, source });

    // Do NOT trigger if not a formula
    if (!value.startsWith("=")) {
      const state = get();
      if (state.visible || state.argumentHintVisible) {
        get().dismiss();
        set({ argumentHintVisible: false, argumentHintFunction: null, argumentHintIndex: -1 });
      }
      return;
    }

    // Do NOT trigger the dropdown when in cell reference mode.
    // But still update argument hints (user might be selecting a cell as an argument).
    const isRefMode = isFormulaExpectingReference(value);

    // Parse the token at the cursor
    const context = parseTokenAtCursor(value, cursorPosition);
    console.log("[FormulaAutocomplete] tokenContext:", context, "isRefMode:", isRefMode);

    // --- Update argument hints ---
    if (context.enclosingFunction) {
      const fnInfo = getFunctionByName(context.enclosingFunction);
      if (fnInfo) {
        set({
          argumentHintVisible: true,
          argumentHintFunction: fnInfo,
          argumentHintIndex: context.argumentIndex,
          anchorRect,
          currentValue: value,
          currentCursorPosition: cursorPosition,
        });
      } else {
        set({
          argumentHintVisible: false,
          argumentHintFunction: null,
          argumentHintIndex: -1,
        });
      }
    } else {
      set({
        argumentHintVisible: false,
        argumentHintFunction: null,
        argumentHintIndex: -1,
      });
    }

    // --- Update dropdown ---
    if (!isRefMode && context.shouldTrigger && context.token.length > 0) {
      const items = filterFunctions(context.token);
      console.log("[FormulaAutocomplete] filterFunctions('" + context.token + "') returned", items.length, "items");
      if (items.length > 0) {
        // Preserve selected index if the same item is still in the list
        const prev = get();
        let newIndex = 0;
        if (prev.visible && prev.items.length > 0 && prev.selectedIndex < prev.items.length) {
          const prevName = prev.items[prev.selectedIndex].info.name;
          const sameIdx = items.findIndex((it) => it.info.name === prevName);
          if (sameIdx >= 0) {
            newIndex = sameIdx;
          }
        }

        set({
          visible: true,
          items,
          selectedIndex: newIndex,
          tokenContext: context,
          anchorRect,
          source,
          currentValue: value,
          currentCursorPosition: cursorPosition,
        });
        setFormulaAutocompleteVisible(true);
        return;
      }
    }

    // No matches or no trigger -- hide dropdown (but keep argument hints)
    if (get().visible) {
      set({
        visible: false,
        items: [],
        selectedIndex: 0,
        tokenContext: null,
      });
      setFormulaAutocompleteVisible(false);
    }

    // Always update the current value for accept logic
    set({ currentValue: value, currentCursorPosition: cursorPosition });
  },

  /**
   * Handle a keyboard event forwarded from an editor.
   */
  handleKey: (key: string) => {
    const state = get();
    if (!state.visible) return;

    switch (key) {
      case "ArrowDown":
        set({
          selectedIndex: Math.min(state.selectedIndex + 1, state.items.length - 1),
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
   * Accept the selected function: replace the partial token in the formula
   * with the full function name + "(" and emit the ACCEPTED event.
   */
  accept: (index?: number) => {
    const state = get();
    const idx = index ?? state.selectedIndex;
    const item = state.items[idx];
    if (!item || !state.tokenContext) return;

    const fnName = item.info.name;
    const { tokenStart } = state.tokenContext;
    const value = state.currentValue;
    const cursorPos = state.currentCursorPosition;

    // Replace the partial token with the full function name + "("
    const before = value.substring(0, tokenStart);
    const after = value.substring(cursorPos);
    const insertion = fnName + "(";
    const newValue = before + insertion + after;
    const newCursorPosition = tokenStart + insertion.length;

    // Emit ACCEPTED event so editors can update their value and cursor
    window.dispatchEvent(
      new CustomEvent(AutocompleteEvents.ACCEPTED, {
        detail: { newValue, newCursorPosition },
      })
    );

    // Hide dropdown, show argument hints for the just-inserted function
    set({
      visible: false,
      items: [],
      selectedIndex: 0,
      tokenContext: null,
      argumentHintVisible: true,
      argumentHintFunction: item.info,
      argumentHintIndex: 0,
      currentValue: newValue,
      currentCursorPosition: newCursorPosition,
    });
    setFormulaAutocompleteVisible(false);
  },

  /**
   * Dismiss the dropdown (but keep argument hints).
   */
  dismiss: () => {
    if (get().visible) {
      set({
        visible: false,
        items: [],
        selectedIndex: 0,
        tokenContext: null,
      });
      setFormulaAutocompleteVisible(false);
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
      tokenContext: null,
      anchorRect: null,
      source: null,
      argumentHintVisible: false,
      argumentHintFunction: null,
      argumentHintIndex: -1,
      currentValue: "",
      currentCursorPosition: 0,
    });
    setFormulaAutocompleteVisible(false);
  },
}));
