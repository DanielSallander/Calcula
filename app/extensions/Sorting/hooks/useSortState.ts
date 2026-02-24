//! FILENAME: app/extensions/Sorting/hooks/useSortState.ts
// PURPOSE: Zustand store for the Sort dialog state.
// CONTEXT: Manages sort levels, options, and range metadata.

import { create } from "zustand";
import type { SortLevel, SortDialogState } from "../types";
import type { SortOn, SortDataOption, SortOrientation } from "../../../src/api/lib";
import { MAX_SORT_LEVELS } from "../types";

// ============================================================================
// Helpers
// ============================================================================

let nextId = 0;

function createLevel(columnKey: number = 0): SortLevel {
  return {
    id: `sort-level-${++nextId}`,
    columnKey,
    sortOn: "value",
    ascending: true,
    dataOption: "normal",
  };
}

// ============================================================================
// Store Interface
// ============================================================================

interface SortStore extends SortDialogState {
  // Level management
  addLevel: () => void;
  deleteLevel: (id: string) => void;
  copyLevel: (id: string) => void;
  updateLevel: (id: string, patch: Partial<Omit<SortLevel, "id">>) => void;
  moveLevelUp: (id: string) => void;
  moveLevelDown: (id: string) => void;
  selectLevel: (id: string | null) => void;

  // Options
  setHasHeaders: (hasHeaders: boolean) => void;
  setCaseSensitive: (caseSensitive: boolean) => void;
  setOrientation: (orientation: SortOrientation) => void;

  // Range and headers
  setRange: (startRow: number, startCol: number, endRow: number, endCol: number) => void;
  setColumnHeaders: (headers: string[]) => void;

  // Lifecycle
  initialize: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    headers: string[],
    hasHeaders: boolean,
  ) => void;
  reset: () => void;
}

// ============================================================================
// Default State
// ============================================================================

const DEFAULT_STATE: SortDialogState = {
  levels: [],
  hasHeaders: true,
  caseSensitive: false,
  orientation: "rows",
  rangeStartRow: 0,
  rangeStartCol: 0,
  rangeEndRow: 0,
  rangeEndCol: 0,
  columnHeaders: [],
  selectedLevelId: null,
};

// ============================================================================
// Store
// ============================================================================

export const useSortStore = create<SortStore>((set, get) => ({
  ...DEFAULT_STATE,

  // ---- Level Management ----

  addLevel: () => {
    set((state) => {
      if (state.levels.length >= MAX_SORT_LEVELS) return state;
      // Pick the first column not already used, or default to 0
      const usedKeys = new Set(state.levels.map((l) => l.columnKey));
      let newKey = 0;
      for (let i = 0; i < state.columnHeaders.length; i++) {
        if (!usedKeys.has(i)) {
          newKey = i;
          break;
        }
      }
      const level = createLevel(newKey);
      return {
        levels: [...state.levels, level],
        selectedLevelId: level.id,
      };
    });
  },

  deleteLevel: (id: string) => {
    set((state) => {
      const idx = state.levels.findIndex((l) => l.id === id);
      if (idx === -1) return state;
      const newLevels = state.levels.filter((l) => l.id !== id);
      // Select adjacent level
      const newSelected =
        newLevels.length === 0
          ? null
          : newLevels[Math.min(idx, newLevels.length - 1)].id;
      return { levels: newLevels, selectedLevelId: newSelected };
    });
  },

  copyLevel: (id: string) => {
    set((state) => {
      if (state.levels.length >= MAX_SORT_LEVELS) return state;
      const source = state.levels.find((l) => l.id === id);
      if (!source) return state;
      const copy: SortLevel = { ...source, id: `sort-level-${++nextId}` };
      const idx = state.levels.findIndex((l) => l.id === id);
      const newLevels = [...state.levels];
      newLevels.splice(idx + 1, 0, copy);
      return { levels: newLevels, selectedLevelId: copy.id };
    });
  },

  updateLevel: (id: string, patch: Partial<Omit<SortLevel, "id">>) => {
    set((state) => ({
      levels: state.levels.map((l) =>
        l.id === id ? { ...l, ...patch } : l,
      ),
    }));
  },

  moveLevelUp: (id: string) => {
    set((state) => {
      const idx = state.levels.findIndex((l) => l.id === id);
      if (idx <= 0) return state;
      const newLevels = [...state.levels];
      [newLevels[idx - 1], newLevels[idx]] = [newLevels[idx], newLevels[idx - 1]];
      return { levels: newLevels };
    });
  },

  moveLevelDown: (id: string) => {
    set((state) => {
      const idx = state.levels.findIndex((l) => l.id === id);
      if (idx === -1 || idx >= state.levels.length - 1) return state;
      const newLevels = [...state.levels];
      [newLevels[idx], newLevels[idx + 1]] = [newLevels[idx + 1], newLevels[idx]];
      return { levels: newLevels };
    });
  },

  selectLevel: (id: string | null) => {
    set({ selectedLevelId: id });
  },

  // ---- Options ----

  setHasHeaders: (hasHeaders: boolean) => {
    set({ hasHeaders });
  },

  setCaseSensitive: (caseSensitive: boolean) => {
    set({ caseSensitive });
  },

  setOrientation: (orientation: SortOrientation) => {
    set({ orientation });
  },

  // ---- Range ----

  setRange: (startRow: number, startCol: number, endRow: number, endCol: number) => {
    set({ rangeStartRow: startRow, rangeStartCol: startCol, rangeEndRow: endRow, rangeEndCol: endCol });
  },

  setColumnHeaders: (headers: string[]) => {
    set({ columnHeaders: headers });
  },

  // ---- Lifecycle ----

  initialize: (
    startRow: number,
    startCol: number,
    endRow: number,
    endCol: number,
    headers: string[],
    hasHeaders: boolean,
  ) => {
    const firstLevel = createLevel(0);
    set({
      ...DEFAULT_STATE,
      rangeStartRow: startRow,
      rangeStartCol: startCol,
      rangeEndRow: endRow,
      rangeEndCol: endCol,
      columnHeaders: headers,
      hasHeaders,
      levels: [firstLevel],
      selectedLevelId: firstLevel.id,
    });
  },

  reset: () => {
    set({ ...DEFAULT_STATE });
  },
}));
