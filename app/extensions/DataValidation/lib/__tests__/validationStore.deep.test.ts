//! FILENAME: app/extensions/DataValidation/lib/__tests__/validationStore.deep.test.ts
// PURPOSE: Deep tests for validation store covering multiple cells with different
// validations, refresh/sync logic, circle toggle, and edge cases.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ValidationRange } from "@api";

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
  refreshValidationState,
  toggleCircleInvalidData,
  clearCircles,
  resetState,
} from "../validationStore";

import {
  getAllDataValidations,
  getInvalidCells,
  addGridRegions,
  removeGridRegionsByType,
  requestOverlayRedraw,
  emitAppEvent,
} from "@api";

const mockGetAll = vi.mocked(getAllDataValidations);
const mockGetInvalid = vi.mocked(getInvalidCells);
const mockAddRegions = vi.mocked(addGridRegions);
const mockRemoveRegions = vi.mocked(removeGridRegionsByType);
const mockRedraw = vi.mocked(requestOverlayRedraw);
const mockEmit = vi.mocked(emitAppEvent);

// ============================================================================
// Helpers
// ============================================================================

function makeValidationRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
  ruleType: "list" | "wholeNumber" | "decimal" | "textLength" | "date" | "custom",
  opts: { inCellDropdown?: boolean } = {}
): ValidationRange {
  let rule: ValidationRange["validation"]["rule"];

  switch (ruleType) {
    case "list":
      rule = {
        list: {
          source: { values: ["A", "B", "C"] },
          inCellDropdown: opts.inCellDropdown ?? true,
        },
      };
      break;
    case "wholeNumber":
      rule = { wholeNumber: { formula1: 1, formula2: 100, operator: "between" } };
      break;
    case "decimal":
      rule = { decimal: { formula1: 0, formula2: 1, operator: "between" } };
      break;
    case "textLength":
      rule = { textLength: { formula1: 3, formula2: 50, operator: "between" } };
      break;
    case "date":
      rule = { date: { formula1: 45000, formula2: 46000, operator: "between" } };
      break;
    case "custom":
      rule = { custom: { formula: "=A1>0" } };
      break;
  }

  return {
    startRow,
    startCol,
    endRow,
    endCol,
    validation: {
      rule,
      errorAlert: { title: "Error", message: "Invalid", style: "stop", showAlert: true },
      prompt: { title: "Input", message: "Enter value", showPrompt: true },
      ignoreBlanks: true,
    },
  };
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  resetState();
});

// ============================================================================
// Multiple Cells with Different Validations
// ============================================================================

describe("multiple cells with different validations", () => {
  it("stores multiple validation ranges from backend", async () => {
    const ranges: ValidationRange[] = [
      makeValidationRange(0, 0, 0, 0, "wholeNumber"),
      makeValidationRange(1, 0, 1, 0, "decimal"),
      makeValidationRange(2, 0, 5, 0, "list"),
      makeValidationRange(0, 1, 10, 1, "textLength"),
    ];

    mockGetAll.mockResolvedValue(ranges);
    await refreshValidationState();

    expect(getValidationRanges()).toEqual(ranges);
    expect(getValidationRanges()).toHaveLength(4);
  });

  it("replaces all ranges on refresh (not appends)", async () => {
    mockGetAll.mockResolvedValue([makeValidationRange(0, 0, 0, 0, "wholeNumber")]);
    await refreshValidationState();
    expect(getValidationRanges()).toHaveLength(1);

    mockGetAll.mockResolvedValue([
      makeValidationRange(5, 5, 5, 5, "decimal"),
      makeValidationRange(6, 6, 6, 6, "list"),
    ]);
    await refreshValidationState();
    expect(getValidationRanges()).toHaveLength(2);
    // The old wholeNumber range should be gone
    const rules = getValidationRanges().map((r) => Object.keys(r.validation.rule)[0]);
    expect(rules).not.toContain("wholeNumber");
  });
});

// ============================================================================
// Dropdown Chevron Region Sync
// ============================================================================

describe("dropdown chevron region sync", () => {
  it("creates grid regions only for list validations with inCellDropdown", async () => {
    const ranges: ValidationRange[] = [
      makeValidationRange(0, 0, 0, 0, "list", { inCellDropdown: true }),
      makeValidationRange(1, 0, 1, 0, "wholeNumber"), // no dropdown
      makeValidationRange(2, 0, 2, 0, "list", { inCellDropdown: false }), // dropdown disabled
    ];

    mockGetAll.mockResolvedValue(ranges);
    await refreshValidationState();

    // Should only create region for the first list validation
    expect(mockAddRegions).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          type: "validation-dropdown",
          startRow: 0,
          startCol: 0,
        }),
      ])
    );

    // Should have exactly 1 region (not 3)
    const addedRegions = mockAddRegions.mock.calls[0][0];
    expect(addedRegions).toHaveLength(1);
  });

  it("creates individual regions for multi-cell list range", async () => {
    // A 2x2 range with list validation
    const ranges = [makeValidationRange(0, 0, 1, 1, "list")];

    mockGetAll.mockResolvedValue(ranges);
    await refreshValidationState();

    // Should create 4 regions (2 rows x 2 cols)
    const addedRegions = mockAddRegions.mock.calls[0][0];
    expect(addedRegions).toHaveLength(4);
  });

  it("removes old chevron regions before adding new ones", async () => {
    mockGetAll.mockResolvedValue([makeValidationRange(0, 0, 0, 0, "list")]);
    await refreshValidationState();

    const removeCallIndex = mockRemoveRegions.mock.calls.findIndex(
      (call) => call[0] === "validation-dropdown"
    );
    expect(removeCallIndex).toBeGreaterThanOrEqual(0);
  });

  it("does not call addGridRegions when no list validations exist", async () => {
    mockGetAll.mockResolvedValue([makeValidationRange(0, 0, 0, 0, "wholeNumber")]);
    await refreshValidationState();

    // addGridRegions should not be called (only removeGridRegionsByType)
    expect(mockAddRegions).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Circle Invalid Data Toggle
// ============================================================================

describe("toggleCircleInvalidData", () => {
  it("activates circles and creates invalid cell regions", async () => {
    mockGetAll.mockResolvedValue([]);
    mockGetInvalid.mockResolvedValue({ cells: [[0, 0], [1, 1], [2, 2]], count: 3 });

    await toggleCircleInvalidData();

    expect(isCirclesActive()).toBe(true);
    expect(getInvalidCellsList()).toEqual([[0, 0], [1, 1], [2, 2]]);
    expect(mockAddRegions).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ type: "validation-invalid", startRow: 0, startCol: 0 }),
        expect.objectContaining({ type: "validation-invalid", startRow: 1, startCol: 1 }),
        expect.objectContaining({ type: "validation-invalid", startRow: 2, startCol: 2 }),
      ])
    );
    expect(mockEmit).toHaveBeenCalledWith("datavalidation:circles-toggled", { active: true });
    expect(mockRedraw).toHaveBeenCalled();
  });

  it("deactivates circles on second toggle", async () => {
    mockGetAll.mockResolvedValue([]);
    mockGetInvalid.mockResolvedValue({ cells: [[0, 0]], count: 1 });

    await toggleCircleInvalidData(); // ON
    vi.clearAllMocks();

    await toggleCircleInvalidData(); // OFF

    expect(isCirclesActive()).toBe(false);
    expect(getInvalidCellsList()).toBeNull();
    expect(mockRemoveRegions).toHaveBeenCalledWith("validation-invalid");
    expect(mockEmit).toHaveBeenCalledWith("datavalidation:circles-toggled", { active: false });
  });

  it("handles empty invalid cells list (circles on, nothing invalid)", async () => {
    mockGetAll.mockResolvedValue([]);
    mockGetInvalid.mockResolvedValue({ cells: [], count: 0 });

    await toggleCircleInvalidData();

    expect(isCirclesActive()).toBe(true);
    expect(getInvalidCellsList()).toEqual([]);
    // Should not add any regions
    // removeGridRegionsByType is called, but addGridRegions should not be
    const addCalls = mockAddRegions.mock.calls.filter(
      (call) => call[0]?.some?.((r: { type: string }) => r.type === "validation-invalid")
    );
    expect(addCalls).toHaveLength(0);
  });
});

// ============================================================================
// clearCircles
// ============================================================================

describe("clearCircles", () => {
  it("clears invalid cells and removes regions", async () => {
    mockGetAll.mockResolvedValue([]);
    mockGetInvalid.mockResolvedValue({ cells: [[0, 0]], count: 1 });
    await toggleCircleInvalidData();
    vi.clearAllMocks();

    clearCircles();

    expect(isCirclesActive()).toBe(false);
    expect(getInvalidCellsList()).toBeNull();
    expect(mockRemoveRegions).toHaveBeenCalledWith("validation-invalid");
    expect(mockEmit).toHaveBeenCalledWith("datavalidation:circles-toggled", { active: false });
    expect(mockRedraw).toHaveBeenCalled();
  });

  it("is safe to call when circles are already inactive", () => {
    expect(isCirclesActive()).toBe(false);
    clearCircles();
    // Should not throw, should still emit event
    expect(mockEmit).toHaveBeenCalledWith("datavalidation:circles-toggled", { active: false });
  });
});

// ============================================================================
// refreshValidationState with circles active
// ============================================================================

describe("refresh with circles active", () => {
  it("also refreshes invalid cells when circles are active", async () => {
    // First toggle circles on
    mockGetAll.mockResolvedValue([]);
    mockGetInvalid.mockResolvedValue({ cells: [[0, 0]], count: 1 });
    await toggleCircleInvalidData();

    vi.clearAllMocks();

    // Now refresh - should also refresh invalid cells
    mockGetAll.mockResolvedValue([makeValidationRange(0, 0, 5, 0, "wholeNumber")]);
    mockGetInvalid.mockResolvedValue({ cells: [[0, 0], [3, 0]], count: 2 });

    await refreshValidationState();

    expect(mockGetInvalid).toHaveBeenCalled();
    expect(getInvalidCellsList()).toEqual([[0, 0], [3, 0]]);
  });

  it("does not refresh invalid cells when circles are not active", async () => {
    mockGetAll.mockResolvedValue([makeValidationRange(0, 0, 0, 0, "wholeNumber")]);

    await refreshValidationState();

    expect(mockGetInvalid).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Error Handling
// ============================================================================

describe("error handling in refresh", () => {
  it("handles getAllDataValidations failure gracefully", async () => {
    mockGetAll.mockRejectedValue(new Error("Backend down"));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await refreshValidationState();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[DataValidation]"),
      expect.any(Error)
    );
    // State should remain unchanged
    expect(getValidationRanges()).toEqual([]);

    consoleSpy.mockRestore();
  });
});

// ============================================================================
// Validation with Dependent Dropdowns (cascading)
// ============================================================================

describe("dependent dropdown scenarios", () => {
  it("stores multiple list validations that could be dependent", async () => {
    const ranges: ValidationRange[] = [
      {
        startRow: 0, startCol: 0, endRow: 0, endCol: 0,
        validation: {
          rule: { list: { source: { values: ["USA", "Canada", "UK"] }, inCellDropdown: true } },
          errorAlert: { title: "", message: "", style: "stop", showAlert: true },
          prompt: { title: "Country", message: "Select country", showPrompt: true },
          ignoreBlanks: true,
        },
      },
      {
        startRow: 0, startCol: 1, endRow: 0, endCol: 1,
        validation: {
          rule: { list: { source: { range: { sheetName: "Lists", startRow: 0, startCol: 0, endRow: 50, endCol: 0 } }, inCellDropdown: true } },
          errorAlert: { title: "", message: "", style: "stop", showAlert: true },
          prompt: { title: "State", message: "Select state", showPrompt: true },
          ignoreBlanks: true,
        },
      },
    ];

    mockGetAll.mockResolvedValue(ranges);
    await refreshValidationState();

    expect(getValidationRanges()).toHaveLength(2);
    // Both should get dropdown chevron regions
    const addedRegions = mockAddRegions.mock.calls[0][0];
    expect(addedRegions).toHaveLength(2);
  });
});

// ============================================================================
// Edge Cases: List Content
// ============================================================================

describe("edge cases for list content", () => {
  it("handles empty list values array", async () => {
    const ranges: ValidationRange[] = [{
      startRow: 0, startCol: 0, endRow: 0, endCol: 0,
      validation: {
        rule: { list: { source: { values: [] }, inCellDropdown: true } },
        errorAlert: { title: "", message: "", style: "stop", showAlert: true },
        prompt: { title: "", message: "", showPrompt: false },
        ignoreBlanks: true,
      },
    }];

    mockGetAll.mockResolvedValue(ranges);
    await refreshValidationState();

    expect(getValidationRanges()).toHaveLength(1);
    // Should still create chevron region
    expect(mockAddRegions).toHaveBeenCalled();
  });

  it("handles list with special characters", async () => {
    const ranges: ValidationRange[] = [{
      startRow: 0, startCol: 0, endRow: 0, endCol: 0,
      validation: {
        rule: {
          list: {
            source: { values: ["Hello, World", "Line\nBreak", "Tab\there", 'Quote"s', ""] },
            inCellDropdown: true,
          },
        },
        errorAlert: { title: "", message: "", style: "stop", showAlert: true },
        prompt: { title: "", message: "", showPrompt: false },
        ignoreBlanks: true,
      },
    }];

    mockGetAll.mockResolvedValue(ranges);
    await refreshValidationState();

    const stored = getValidationRanges()[0];
    const rule = stored.validation.rule;
    if ("list" in rule && "values" in rule.list.source) {
      expect(rule.list.source.values).toHaveLength(5);
      expect(rule.list.source.values).toContain("");
    }
  });

  it("handles very long list (1000 items)", async () => {
    const longList = Array.from({ length: 1000 }, (_, i) => `Item_${i}`);
    const ranges: ValidationRange[] = [{
      startRow: 0, startCol: 0, endRow: 0, endCol: 0,
      validation: {
        rule: { list: { source: { values: longList }, inCellDropdown: true } },
        errorAlert: { title: "", message: "", style: "stop", showAlert: true },
        prompt: { title: "", message: "", showPrompt: false },
        ignoreBlanks: true,
      },
    }];

    mockGetAll.mockResolvedValue(ranges);
    await refreshValidationState();

    const stored = getValidationRanges()[0];
    const rule = stored.validation.rule;
    if ("list" in rule && "values" in rule.list.source) {
      expect(rule.list.source.values).toHaveLength(1000);
    }
  });
});

// ============================================================================
// Prompt State Combinations
// ============================================================================

describe("prompt state with validation context", () => {
  it("can have prompt visible while dropdown is also open", () => {
    setPromptState(true, { row: 0, col: 0 });
    setOpenDropdownCell({ row: 0, col: 0 });

    const state = getValidationState();
    expect(state.promptVisible).toBe(true);
    expect(state.openDropdownCell).toEqual({ row: 0, col: 0 });
  });

  it("reset clears both prompt and dropdown", () => {
    setPromptState(true, { row: 0, col: 0 });
    setOpenDropdownCell({ row: 0, col: 0 });

    resetState();

    const state = getValidationState();
    expect(state.promptVisible).toBe(false);
    expect(state.promptCell).toBeNull();
    expect(state.openDropdownCell).toBeNull();
  });
});

// ============================================================================
// Selection Tracking
// ============================================================================

describe("selection tracking with validation", () => {
  it("tracks multi-cell selection for validation dialog", () => {
    setCurrentSelection({
      startRow: 0,
      startCol: 0,
      endRow: 9,
      endCol: 3,
      activeRow: 0,
      activeCol: 0,
    });

    const sel = getCurrentSelection();
    expect(sel).not.toBeNull();
    expect(sel!.endRow).toBe(9);
    expect(sel!.endCol).toBe(3);
  });

  it("updates selection without affecting other state", () => {
    setOpenDropdownCell({ row: 5, col: 5 });
    setPromptState(true, { row: 5, col: 5 });

    setCurrentSelection({
      startRow: 10,
      startCol: 10,
      endRow: 20,
      endCol: 20,
      activeRow: 10,
      activeCol: 10,
    });

    // Other state should be unaffected
    expect(getOpenDropdownCell()).toEqual({ row: 5, col: 5 });
    expect(getValidationState().promptVisible).toBe(true);
  });
});
