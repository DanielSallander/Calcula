//! FILENAME: app/extensions/BuiltIn/FindReplaceDialog/useFindStore.ts
// PURPOSE: Local state management for the Find & Replace extension.
// CONTEXT: Replaces the Find state that was previously in Core's GridState.
// This follows the Microkernel Rule: "Find" is a feature, not a kernel primitive.
// The Core only provides primitives like searchCells() and selectCells().

import { create } from "zustand";

// ============================================================================
// Types
// ============================================================================

export interface FindOptions {
  caseSensitive: boolean;
  matchEntireCell: boolean;
  searchFormulas: boolean;
}

export interface FindState {
  // Dialog visibility
  isOpen: boolean;
  showReplace: boolean;

  // Search state
  query: string;
  replaceText: string;
  matches: [number, number][];
  currentIndex: number;

  // Options
  options: FindOptions;
}

export interface FindActions {
  // Dialog control
  open: (showReplace?: boolean) => void;
  close: () => void;

  // Search state
  setQuery: (query: string) => void;
  setReplaceText: (text: string) => void;
  setMatches: (matches: [number, number][], query: string) => void;
  setCurrentIndex: (index: number) => void;
  clearResults: () => void;

  // Options
  setOptions: (options: Partial<FindOptions>) => void;

  // Navigation helpers
  nextMatch: () => void;
  previousMatch: () => void;

  // Reset
  reset: () => void;
}

export type FindStore = FindState & FindActions;

// ============================================================================
// Default State
// ============================================================================

const DEFAULT_FIND_OPTIONS: FindOptions = {
  caseSensitive: false,
  matchEntireCell: false,
  searchFormulas: false,
};

const DEFAULT_FIND_STATE: FindState = {
  isOpen: false,
  showReplace: false,
  query: "",
  replaceText: "",
  matches: [],
  currentIndex: -1,
  options: { ...DEFAULT_FIND_OPTIONS },
};

// ============================================================================
// Store Implementation
// ============================================================================

export const useFindStore = create<FindStore>((set, get) => ({
  // Initial state
  ...DEFAULT_FIND_STATE,

  // ---------------------------------------------------------------------------
  // Dialog Control
  // ---------------------------------------------------------------------------

  open: (showReplace = false) => {
    set({ isOpen: true, showReplace });
  },

  close: () => {
    set({
      isOpen: false,
      // Optionally clear results when closing
      // matches: [],
      // currentIndex: -1,
    });
  },

  // ---------------------------------------------------------------------------
  // Search State
  // ---------------------------------------------------------------------------

  setQuery: (query: string) => {
    set({ query });
  },

  setReplaceText: (replaceText: string) => {
    set({ replaceText });
  },

  setMatches: (matches: [number, number][], query: string) => {
    set({
      matches,
      query,
      currentIndex: matches.length > 0 ? 0 : -1,
    });
  },

  setCurrentIndex: (index: number) => {
    const { matches } = get();
    if (index >= -1 && index < matches.length) {
      set({ currentIndex: index });
    }
  },

  clearResults: () => {
    set({
      matches: [],
      currentIndex: -1,
    });
  },

  // ---------------------------------------------------------------------------
  // Options
  // ---------------------------------------------------------------------------

  setOptions: (options: Partial<FindOptions>) => {
    set((state) => ({
      options: { ...state.options, ...options },
    }));
  },

  // ---------------------------------------------------------------------------
  // Navigation Helpers
  // ---------------------------------------------------------------------------

  nextMatch: () => {
    const { matches, currentIndex } = get();
    if (matches.length === 0) return;

    const nextIndex = (currentIndex + 1) % matches.length;
    set({ currentIndex: nextIndex });
  },

  previousMatch: () => {
    const { matches, currentIndex } = get();
    if (matches.length === 0) return;

    const prevIndex = currentIndex <= 0 ? matches.length - 1 : currentIndex - 1;
    set({ currentIndex: prevIndex });
  },

  // ---------------------------------------------------------------------------
  // Reset
  // ---------------------------------------------------------------------------

  reset: () => {
    set({ ...DEFAULT_FIND_STATE });
  },
}));

// ============================================================================
// Selector Hooks (for convenience)
// ============================================================================

export const useFindIsOpen = () => useFindStore((state) => state.isOpen);
export const useFindShowReplace = () => useFindStore((state) => state.showReplace);
export const useFindQuery = () => useFindStore((state) => state.query);
export const useFindMatches = () => useFindStore((state) => state.matches);
export const useFindCurrentIndex = () => useFindStore((state) => state.currentIndex);
export const useFindOptions = () => useFindStore((state) => state.options);

/**
 * Get the current match coordinates, or null if no current match.
 */
export const useFindCurrentMatch = (): [number, number] | null => {
  return useFindStore((state) => {
    const { matches, currentIndex } = state;
    if (currentIndex >= 0 && currentIndex < matches.length) {
      return matches[currentIndex];
    }
    return null;
  });
};

/**
 * Get a formatted string showing match count (e.g., "3 of 10").
 */
export const useFindMatchCountDisplay = (): string => {
  return useFindStore((state) => {
    const { matches, currentIndex } = state;
    if (matches.length === 0) return "No matches";
    return `${currentIndex + 1} of ${matches.length}`;
  });
};