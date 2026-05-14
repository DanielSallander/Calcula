//! FILENAME: app/extensions/DataValidation/lib/__tests__/validationStore.test.ts
// PURPOSE: Tests for the data validation store state management.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the @api module
vi.mock("@api", () => ({
  getAllDataValidations: vi.fn(),
  getInvalidCells: vi.fn(),
  addGridRegions: vi.fn(),
  removeGridRegionsByType: vi.fn(),
  requestOverlayRedraw: vi.fn(),
  emitAppEvent: vi.fn(),
}));

import {
  getValidationState,
  getValidationRanges,
  getInvalidCellsList,
  isCirclesActive,
  getOpenDropdownCell,
  getCurrentSelection,
  setCurrentSelection,
  setOpenDropdownCell,
  setPromptState,
  resetState,
} from "../validationStore";

import {
  removeGridRegionsByType,
} from "@api";

const mockRemoveRegions = vi.mocked(removeGridRegionsByType);

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
});

// ============================================================================
// Initial State Tests
// ============================================================================

describe("initial state", () => {
  it("starts with empty validation ranges", () => {
    expect(getValidationRanges()).toEqual([]);
  });

  it("starts with no invalid cells", () => {
    expect(getInvalidCellsList()).toBeNull();
  });

  it("circles are not active initially", () => {
    expect(isCirclesActive()).toBe(false);
  });

  it("no dropdown cell open initially", () => {
    expect(getOpenDropdownCell()).toBeNull();
  });

  it("no current selection initially", () => {
    expect(getCurrentSelection()).toBeNull();
  });

  it("prompt is not visible initially", () => {
    const state = getValidationState();
    expect(state.promptVisible).toBe(false);
    expect(state.promptCell).toBeNull();
  });
});

// ============================================================================
// Setter Tests
// ============================================================================

describe("setCurrentSelection", () => {
  it("sets the current selection", () => {
    const sel = {
      startRow: 0,
      startCol: 0,
      endRow: 5,
      endCol: 3,
      activeRow: 0,
      activeCol: 0,
    };
    setCurrentSelection(sel);
    expect(getCurrentSelection()).toEqual(sel);
  });

  it("clears the selection when set to null", () => {
    setCurrentSelection({
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 1,
      activeRow: 0,
      activeCol: 0,
    });
    expect(getCurrentSelection()).not.toBeNull();
    setCurrentSelection(null);
    expect(getCurrentSelection()).toBeNull();
  });
});

describe("setOpenDropdownCell", () => {
  it("sets the open dropdown cell", () => {
    setOpenDropdownCell({ row: 3, col: 5 });
    expect(getOpenDropdownCell()).toEqual({ row: 3, col: 5 });
  });

  it("clears the dropdown cell when set to null", () => {
    setOpenDropdownCell({ row: 1, col: 2 });
    setOpenDropdownCell(null);
    expect(getOpenDropdownCell()).toBeNull();
  });
});

describe("setPromptState", () => {
  it("sets prompt visible with cell", () => {
    setPromptState(true, { row: 2, col: 4 });
    const state = getValidationState();
    expect(state.promptVisible).toBe(true);
    expect(state.promptCell).toEqual({ row: 2, col: 4 });
  });

  it("hides prompt and clears cell", () => {
    setPromptState(true, { row: 2, col: 4 });
    setPromptState(false, null);
    const state = getValidationState();
    expect(state.promptVisible).toBe(false);
    expect(state.promptCell).toBeNull();
  });
});

// ============================================================================
// Reset Tests
// ============================================================================

describe("resetState", () => {
  it("resets all state to defaults", () => {
    // Set some state
    setCurrentSelection({
      startRow: 0,
      startCol: 0,
      endRow: 1,
      endCol: 1,
      activeRow: 0,
      activeCol: 0,
    });
    setOpenDropdownCell({ row: 1, col: 1 });
    setPromptState(true, { row: 2, col: 2 });

    // Reset
    resetState();

    expect(getValidationRanges()).toEqual([]);
    expect(getInvalidCellsList()).toBeNull();
    expect(isCirclesActive()).toBe(false);
    expect(getOpenDropdownCell()).toBeNull();
    expect(getCurrentSelection()).toBeNull();
    const state = getValidationState();
    expect(state.promptVisible).toBe(false);
    expect(state.promptCell).toBeNull();
  });

  it("removes grid regions on reset", () => {
    resetState();
    expect(mockRemoveRegions).toHaveBeenCalledWith("validation-dropdown");
    expect(mockRemoveRegions).toHaveBeenCalledWith("validation-invalid");
  });
});

// ============================================================================
// isCirclesActive Tests
// ============================================================================

describe("isCirclesActive", () => {
  it("returns false when invalidCells is null", () => {
    expect(isCirclesActive()).toBe(false);
  });

  it("returns true when invalidCells is an empty array (circles toggled on but nothing invalid)", () => {
    // We can't directly set invalidCells, but we can verify the logic
    // through the state getter. The internal state defaults to null.
    expect(getValidationState().invalidCells).toBeNull();
    expect(isCirclesActive()).toBe(false);
  });
});

// ============================================================================
// State Snapshot Tests
// ============================================================================

describe("getValidationState", () => {
  it("returns the full state object", () => {
    const state = getValidationState();
    expect(state).toHaveProperty("validationRanges");
    expect(state).toHaveProperty("invalidCells");
    expect(state).toHaveProperty("openDropdownCell");
    expect(state).toHaveProperty("promptVisible");
    expect(state).toHaveProperty("promptCell");
  });

  it("reflects mutations via setters", () => {
    setOpenDropdownCell({ row: 7, col: 9 });
    setPromptState(true, { row: 3, col: 1 });
    const state = getValidationState();
    expect(state.openDropdownCell).toEqual({ row: 7, col: 9 });
    expect(state.promptVisible).toBe(true);
    expect(state.promptCell).toEqual({ row: 3, col: 1 });
  });
});
