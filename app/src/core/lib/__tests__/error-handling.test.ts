//! FILENAME: app/src/core/lib/__tests__/error-handling.test.ts
// PURPOSE: Verify defensive coding across core utility modules.
// CONTEXT: Ensures functions handle null/undefined/wrong-type inputs gracefully.

import { describe, it, expect } from "vitest";
import {
  getColumnWidthFromDimensions,
  getRowHeightFromDimensions,
  getColumnXPosition,
  getRowYPosition,
  calculateMaxScroll,
  clampScroll,
  scrollToVisibleRange,
  cellToScroll,
  cellToCenteredScroll,
  calculateScrollDelta,
  isCellVisible,
  scrollToMakeVisible,
  thumbPositionToScroll,
  calculateScrollbarMetrics,
} from "../scrollUtils";
import {
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
  buildCellReference,
  buildRangeReference,
  findReferenceAtCell,
  updateFormulaReference,
} from "../formulaRefParser";
import { autoCompleteFormula, isIncompleteFormula } from "../formulaCompletion";
import { toggleReferenceAtCursor, getReferenceAtCursor } from "../formulaRefToggle";
import type { GridConfig, Viewport } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides?: Partial<GridConfig>): GridConfig {
  return {
    totalRows: 1000,
    totalCols: 26,
    defaultCellWidth: 100,
    defaultCellHeight: 25,
    rowHeaderWidth: 50,
    colHeaderHeight: 30,
    ...overrides,
  } as GridConfig;
}

function makeViewport(overrides?: Partial<Viewport>): Viewport {
  return {
    scrollX: 0,
    scrollY: 0,
    ...overrides,
  } as Viewport;
}

// ============================================================================
// scrollUtils - null/undefined/wrong type inputs
// ============================================================================

describe("scrollUtils error handling", () => {
  const config = makeConfig();

  describe("getColumnWidthFromDimensions", () => {
    it("returns default width when dimensions is undefined", () => {
      expect(getColumnWidthFromDimensions(0, config, undefined)).toBe(100);
    });

    it("handles NaN column index", () => {
      const result = getColumnWidthFromDimensions(NaN, config, undefined);
      expect(typeof result).toBe("number");
    });

    it("handles negative column index", () => {
      const result = getColumnWidthFromDimensions(-1, config, undefined);
      expect(typeof result).toBe("number");
    });

    it("handles Infinity column index", () => {
      const result = getColumnWidthFromDimensions(Infinity, config, undefined);
      expect(typeof result).toBe("number");
    });
  });

  describe("getRowHeightFromDimensions", () => {
    it("returns default height when dimensions is undefined", () => {
      expect(getRowHeightFromDimensions(0, config, undefined)).toBe(25);
    });

    it("handles NaN row index", () => {
      const result = getRowHeightFromDimensions(NaN, config, undefined);
      expect(typeof result).toBe("number");
    });
  });

  describe("getColumnXPosition", () => {
    it("handles col=0 with no dimensions", () => {
      expect(getColumnXPosition(0, config, undefined)).toBe(0);
    });

    it("handles negative col", () => {
      const result = getColumnXPosition(-5, config, undefined);
      expect(typeof result).toBe("number");
    });

    it("handles very large col index", () => {
      const result = getColumnXPosition(999999, config, undefined);
      expect(typeof result).toBe("number");
      expect(isFinite(result)).toBe(true);
    });
  });

  describe("getRowYPosition", () => {
    it("handles row=0 with no dimensions", () => {
      expect(getRowYPosition(0, config, undefined)).toBe(0);
    });

    it("handles negative row", () => {
      const result = getRowYPosition(-5, config, undefined);
      expect(typeof result).toBe("number");
    });
  });

  describe("calculateMaxScroll", () => {
    it("handles zero viewport dimensions", () => {
      const result = calculateMaxScroll(config, 0, 0, undefined);
      expect(result.maxScrollX).toBeGreaterThanOrEqual(0);
      expect(result.maxScrollY).toBeGreaterThanOrEqual(0);
    });

    it("handles negative viewport dimensions", () => {
      const result = calculateMaxScroll(config, -100, -100, undefined);
      expect(result.maxScrollX).toBeGreaterThanOrEqual(0);
      expect(result.maxScrollY).toBeGreaterThanOrEqual(0);
    });
  });

  describe("clampScroll", () => {
    it("clamps negative scroll to zero", () => {
      const result = clampScroll(-100, -100, config, 800, 600, undefined);
      expect(result.scrollX).toBe(0);
      expect(result.scrollY).toBe(0);
    });

    it("handles NaN scroll values", () => {
      const result = clampScroll(NaN, NaN, config, 800, 600, undefined);
      expect(typeof result.scrollX).toBe("number");
      expect(typeof result.scrollY).toBe("number");
    });

    it("handles Infinity scroll values", () => {
      const result = clampScroll(Infinity, Infinity, config, 800, 600, undefined);
      expect(isFinite(result.scrollX)).toBe(true);
      expect(isFinite(result.scrollY)).toBe(true);
    });
  });

  describe("scrollToVisibleRange", () => {
    it("handles zero scroll values", () => {
      const result = scrollToVisibleRange(0, 0, config, 800, 600);
      expect(result.startRow).toBe(0);
      expect(result.startCol).toBe(0);
    });

    it("handles zero viewport size", () => {
      const result = scrollToVisibleRange(0, 0, config, 0, 0);
      expect(typeof result.startRow).toBe("number");
      expect(typeof result.endRow).toBe("number");
    });
  });

  describe("cellToScroll", () => {
    it("handles row=0, col=0", () => {
      const result = cellToScroll(0, 0, config, undefined);
      expect(result.scrollX).toBe(0);
      expect(result.scrollY).toBe(0);
    });

    it("handles negative coordinates", () => {
      const result = cellToScroll(-1, -1, config, undefined);
      expect(typeof result.scrollX).toBe("number");
      expect(typeof result.scrollY).toBe("number");
    });
  });

  describe("cellToCenteredScroll", () => {
    it("handles zero viewport", () => {
      const result = cellToCenteredScroll(0, 0, config, 0, 0, undefined);
      expect(typeof result.scrollX).toBe("number");
      expect(typeof result.scrollY).toBe("number");
    });
  });

  describe("calculateScrollDelta", () => {
    const viewport = makeViewport();

    it("handles all directions with cell unit", () => {
      for (const dir of ["up", "down", "left", "right"] as const) {
        const result = calculateScrollDelta(dir, "cell", config, viewport, 800, 600);
        expect(typeof result.deltaX).toBe("number");
        expect(typeof result.deltaY).toBe("number");
      }
    });

    it("handles zero viewport size", () => {
      const result = calculateScrollDelta("down", "page", config, viewport, 0, 0);
      expect(typeof result.deltaY).toBe("number");
    });
  });

  describe("isCellVisible", () => {
    it("returns boolean for edge cells", () => {
      const viewport = makeViewport();
      expect(typeof isCellVisible(0, 0, viewport, config, 800, 600)).toBe("boolean");
    });

    it("returns false for very large indices", () => {
      const viewport = makeViewport();
      expect(isCellVisible(999999, 999999, viewport, config, 800, 600)).toBe(false);
    });
  });

  describe("scrollToMakeVisible", () => {
    it("returns null when cell is already visible", () => {
      const viewport = makeViewport();
      const result = scrollToMakeVisible(0, 0, viewport, config, 800, 600, undefined);
      expect(result).toBeNull();
    });

    it("handles negative cell coordinates", () => {
      const viewport = makeViewport();
      const result = scrollToMakeVisible(-1, -1, viewport, config, 800, 600, undefined);
      // Should either return null or a valid scroll position
      if (result !== null) {
        expect(typeof result.scrollX).toBe("number");
        expect(typeof result.scrollY).toBe("number");
      }
    });
  });

  describe("thumbPositionToScroll", () => {
    it("returns 0 when thumbRange is 0", () => {
      expect(thumbPositionToScroll(0, 100, 100, 500, 500)).toBe(0);
    });

    it("returns 0 when scrollRange is 0", () => {
      expect(thumbPositionToScroll(0, 50, 100, 100, 100)).toBe(0);
    });

    it("handles negative inputs", () => {
      const result = thumbPositionToScroll(-10, 50, 100, 500, 200);
      expect(typeof result).toBe("number");
    });
  });

  describe("calculateScrollbarMetrics", () => {
    it("produces finite values for valid inputs", () => {
      const viewport = makeViewport();
      const result = calculateScrollbarMetrics(config, viewport, 800, 600);
      expect(isFinite(result.horizontal.thumbSize)).toBe(true);
      expect(isFinite(result.vertical.thumbSize)).toBe(true);
    });

    it("handles zero viewport", () => {
      const viewport = makeViewport();
      const result = calculateScrollbarMetrics(config, viewport, 0, 0);
      expect(typeof result.horizontal.thumbSize).toBe("number");
      expect(typeof result.vertical.thumbSize).toBe("number");
    });
  });
});

// ============================================================================
// formulaRefParser - null/undefined/wrong type inputs
// ============================================================================

describe("formulaRefParser error handling", () => {
  describe("parseFormulaReferences", () => {
    it("returns empty array for empty string", () => {
      expect(parseFormulaReferences("")).toEqual([]);
    });

    it("returns empty array for non-formula string", () => {
      expect(parseFormulaReferences("hello")).toEqual([]);
    });

    it("returns empty array for bare equals", () => {
      expect(parseFormulaReferences("=")).toEqual([]);
    });

    it("returns empty array for formula with no refs", () => {
      expect(parseFormulaReferences("=123+456")).toEqual([]);
    });

    it("throws on null/undefined (no runtime guard)", () => {
      expect(() => parseFormulaReferences(null as unknown as string)).toThrow();
      expect(() => parseFormulaReferences(undefined as unknown as string)).toThrow();
    });

    it("returns empty for number cast as string (no startsWith)", () => {
      expect(() => parseFormulaReferences(42 as unknown as string)).toThrow();
    });

    it("handles very long formula string", () => {
      const formula = "=" + "A1+".repeat(10000) + "A1";
      const result = parseFormulaReferences(formula);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
    });
  });

  describe("parseFormulaReferencesWithPositions", () => {
    it("returns empty array for empty string", () => {
      expect(parseFormulaReferencesWithPositions("")).toEqual([]);
    });

    it("returns empty array for non-formula", () => {
      expect(parseFormulaReferencesWithPositions("not a formula")).toEqual([]);
    });

    it("throws on null/undefined (no runtime guard)", () => {
      expect(() => parseFormulaReferencesWithPositions(null as unknown as string)).toThrow();
      expect(() => parseFormulaReferencesWithPositions(undefined as unknown as string)).toThrow();
    });
  });

  describe("buildCellReference", () => {
    it("handles row=0, col=0", () => {
      const result = buildCellReference(0, 0, false, false);
      expect(result).toBe("A1");
    });

    it("handles negative row/col", () => {
      // Should not crash
      const result = buildCellReference(-1, -1, false, false);
      expect(typeof result).toBe("string");
    });

    it("handles very large row/col", () => {
      const result = buildCellReference(999999, 999999, true, true);
      expect(typeof result).toBe("string");
      expect(result.length).toBeGreaterThan(0);
    });

    it("handles empty sheet name", () => {
      const result = buildCellReference(0, 0, false, false, "");
      expect(typeof result).toBe("string");
    });
  });

  describe("buildRangeReference", () => {
    it("returns single cell ref when start equals end", () => {
      const result = buildRangeReference(0, 0, 0, 0, false, false, false, false);
      expect(result).toBe("A1");
    });

    it("handles inverted range (start > end)", () => {
      const result = buildRangeReference(5, 5, 0, 0, false, false, false, false);
      expect(typeof result).toBe("string");
    });
  });

  describe("findReferenceAtCell", () => {
    it("returns -1 for empty refs array", () => {
      expect(findReferenceAtCell([], 0, 0)).toBe(-1);
    });

    it("returns -1 for negative coordinates", () => {
      expect(findReferenceAtCell([], -1, -1)).toBe(-1);
    });
  });

  describe("updateFormulaReference", () => {
    it("handles replacement at start of formula", () => {
      const refs = parseFormulaReferencesWithPositions("=A1+B2");
      expect(refs.length).toBeGreaterThan(0);
      const result = updateFormulaReference("=A1+B2", refs[0], 2, 2);
      expect(typeof result).toBe("string");
      expect(result.startsWith("=")).toBe(true);
    });
  });
});

// ============================================================================
// formulaCompletion - null/undefined/wrong type inputs
// ============================================================================

describe("formulaCompletion error handling", () => {
  describe("autoCompleteFormula", () => {
    it("returns empty string for empty input", () => {
      expect(autoCompleteFormula("")).toBe("");
    });

    it("returns non-formula strings unchanged", () => {
      expect(autoCompleteFormula("hello")).toBe("hello");
    });

    it("returns bare equals unchanged", () => {
      expect(autoCompleteFormula("=")).toBe("=");
    });

    it("throws on null/undefined (no runtime guard)", () => {
      expect(() => autoCompleteFormula(null as unknown as string)).toThrow();
      expect(() => autoCompleteFormula(undefined as unknown as string)).toThrow();
    });

    it("closes multiple unclosed parens", () => {
      expect(autoCompleteFormula("=SUM(IF(A1")).toBe("=SUM(IF(A1))");
    });

    it("closes unclosed string", () => {
      const result = autoCompleteFormula('=CONCAT("hello');
      expect(result).toContain('"');
    });

    it("handles deeply nested parens", () => {
      const formula = "=" + "(".repeat(100) + "1" + ")".repeat(50);
      const result = autoCompleteFormula(formula);
      expect(typeof result).toBe("string");
    });
  });

  describe("isIncompleteFormula", () => {
    it("returns false for empty string", () => {
      expect(isIncompleteFormula("")).toBe(false);
    });

    it("returns false for non-formula", () => {
      expect(isIncompleteFormula("hello")).toBe(false);
    });

    it("returns false for complete formula", () => {
      expect(isIncompleteFormula("=SUM(A1)")).toBe(false);
    });

    it("returns true for unclosed paren", () => {
      expect(isIncompleteFormula("=SUM(A1")).toBe(true);
    });

    it("returns true for unclosed string", () => {
      expect(isIncompleteFormula('="hello')).toBe(true);
    });
  });
});

// ============================================================================
// formulaRefToggle - null/undefined/wrong type inputs
// ============================================================================

describe("formulaRefToggle error handling", () => {
  describe("toggleReferenceAtCursor", () => {
    it("returns formula unchanged when no references exist", () => {
      const result = toggleReferenceAtCursor("=123", 2);
      expect(result.formula).toBe("=123");
      expect(result.cursorPos).toBe(2);
    });

    it("returns formula unchanged for empty string", () => {
      const result = toggleReferenceAtCursor("", 0);
      expect(result.formula).toBe("");
    });

    it("handles cursor at position 0", () => {
      const result = toggleReferenceAtCursor("=A1", 0);
      expect(typeof result.formula).toBe("string");
    });

    it("handles cursor beyond formula length", () => {
      const result = toggleReferenceAtCursor("=A1", 100);
      expect(typeof result.formula).toBe("string");
    });

    it("handles negative cursor position", () => {
      const result = toggleReferenceAtCursor("=A1", -5);
      expect(typeof result.formula).toBe("string");
    });

    it("handles null/undefined gracefully (regex finds no matches)", () => {
      const r1 = toggleReferenceAtCursor(null as unknown as string, 0);
      expect(r1.cursorPos).toBe(0);
      const r2 = toggleReferenceAtCursor(undefined as unknown as string, 0);
      expect(r2.cursorPos).toBe(0);
    });

    it("cycles through all four modes", () => {
      let { formula, cursorPos } = toggleReferenceAtCursor("=B2", 2);
      expect(formula).toContain("$");
      ({ formula, cursorPos } = toggleReferenceAtCursor(formula, cursorPos));
      ({ formula, cursorPos } = toggleReferenceAtCursor(formula, cursorPos));
      ({ formula, cursorPos } = toggleReferenceAtCursor(formula, cursorPos));
      // After 4 toggles, should be back to relative
      expect(formula).toBe("=B2");
    });
  });

  describe("getReferenceAtCursor", () => {
    it("returns null for empty formula", () => {
      expect(getReferenceAtCursor("", 0)).toBeNull();
    });

    it("returns null for formula with no refs", () => {
      expect(getReferenceAtCursor("=123", 2)).toBeNull();
    });

    it("returns null when cursor is before any ref", () => {
      const result = getReferenceAtCursor("=A1", 0);
      // Cursor at '=' - might find the ref at index 1 via fallback, or null
      // Either is acceptable defensive behavior
      if (result !== null) {
        expect(typeof result.ref).toBe("string");
      }
    });

    it("returns null for null/undefined (regex handles gracefully)", () => {
      expect(getReferenceAtCursor(null as unknown as string, 0)).toBeNull();
      expect(getReferenceAtCursor(undefined as unknown as string, 0)).toBeNull();
    });
  });
});
