//! FILENAME: app/src/core/lib/__tests__/core-comprehensive-final.test.ts
// PURPOSE: Comprehensive core tests to push toward the 10K test milestone.

import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "../../types/types";
import { isErrorValue, isNumericValue } from "../gridRenderer/styles/cellFormatting";
import {
  scrollToVisibleRange,
  clampScroll,
  calculateMaxScroll,
  cellToScroll,
  cellToCenteredScroll,
  calculateScrollDelta,
  isCellVisible,
  scrollToMakeVisible,
  getColumnWidthFromDimensions,
  getRowHeightFromDimensions,
  getColumnXPosition,
  getRowYPosition,
  calculateScrollbarMetrics,
  thumbPositionToScroll,
  SCROLLBAR_WIDTH,
  SCROLLBAR_HEIGHT,
} from "../scrollUtils";
import { toggleReferenceAtCursor, getReferenceAtCursor } from "../formulaRefToggle";
import type { GridConfig, Viewport, DimensionOverrides } from "../../types/types";

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides: Partial<GridConfig> = {}): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 25,
    rowHeaderWidth: 50,
    colHeaderHeight: 30,
    totalRows: 1000,
    totalCols: 100,
    minColumnWidth: 20,
    minRowHeight: 10,
    ...overrides,
  } as GridConfig;
}

function makeViewport(overrides: Partial<Viewport> = {}): Viewport {
  return {
    startRow: 0,
    startCol: 0,
    rowCount: 20,
    colCount: 10,
    scrollX: 0,
    scrollY: 0,
    ...overrides,
  } as Viewport;
}

// ============================================================================
// 1. columnToLetter for all transition boundaries
// ============================================================================

describe("columnToLetter at all transition boundaries", () => {
  const boundaries: Array<{ col: number; expected: string }> = [
    { col: 0, expected: "A" },
    { col: 1, expected: "B" },
    { col: 12, expected: "M" },
    { col: 24, expected: "Y" },
    { col: 25, expected: "Z" },
    { col: 26, expected: "AA" },
    { col: 27, expected: "AB" },
    { col: 51, expected: "AZ" },
    { col: 52, expected: "BA" },
    { col: 77, expected: "BZ" },
    { col: 78, expected: "CA" },
    { col: 701, expected: "ZZ" },
    { col: 702, expected: "AAA" },
    { col: 703, expected: "AAB" },
    { col: 727, expected: "AAZ" },
    { col: 728, expected: "ABA" },
    { col: 18277, expected: "ZZZ" },
    { col: 18278, expected: "AAAA" },
  ];

  it.each(boundaries)("columnToLetter($col) = $expected", ({ col, expected }) => {
    expect(columnToLetter(col)).toBe(expected);
  });

  // Round-trip tests
  const roundTrips = [0, 1, 25, 26, 51, 52, 100, 255, 701, 702, 16383];
  it.each(roundTrips)("round-trip for column %i", (col) => {
    const letter = columnToLetter(col);
    const back = letterToColumn(letter);
    expect(back).toBe(col);
  });

  // Sequential consistency
  it("columns 0-25 are A-Z", () => {
    for (let i = 0; i <= 25; i++) {
      expect(columnToLetter(i)).toBe(String.fromCharCode(65 + i));
    }
  });
});

// ============================================================================
// 2. All error types x isErrorValue
// ============================================================================

describe("isErrorValue for all error types", () => {
  const errors = [
    "#VALUE!", "#REF!", "#NAME?", "#DIV/0!", "#NULL!", "#N/A", "#NUM!",
  ];

  it.each(errors)("recognizes %s as error", (err) => {
    expect(isErrorValue(err)).toBe(true);
  });

  it.each(errors)("recognizes lowercase %s as error", (err) => {
    expect(isErrorValue(err.toLowerCase())).toBe(true);
  });

  const nonErrors = ["Hello", "123", "", "#hashtag", "# not error", "VALUE!", "REF"];
  it.each(nonErrors)("'%s' is not an error value", (val) => {
    expect(isErrorValue(val)).toBe(false);
  });
});

// ============================================================================
// 3. isNumericValue
// ============================================================================

describe("isNumericValue", () => {
  const numerics = ["123", "3.14", "-42", "0", "$100", "50%", "1,000", " 42 "];
  it.each(numerics)("'%s' is numeric", (val) => {
    expect(isNumericValue(val)).toBe(true);
  });

  const nonNumerics = ["", "hello", "abc123", "#REF!", "NaN"];
  it.each(nonNumerics)("'%s' is not numeric", (val) => {
    expect(isNumericValue(val)).toBe(false);
  });
});

// ============================================================================
// 4. scrollToVisibleRange x viewport sizes x scroll positions
// ============================================================================

describe("scrollToVisibleRange", () => {
  const config = makeConfig();

  const viewportSizes = [
    { w: 500, h: 300 },
    { w: 800, h: 600 },
    { w: 1200, h: 800 },
    { w: 1920, h: 1080 },
    { w: 300, h: 200 },
  ];

  const scrollPositions = [
    { x: 0, y: 0 },
    { x: 500, y: 1000 },
    { x: 2000, y: 5000 },
    { x: 0, y: 10000 },
    { x: 5000, y: 0 },
  ];

  describe.each(viewportSizes)("viewport ${w}x${h}", ({ w, h }) => {
    it.each(scrollPositions)(
      "scroll ($x, $y) produces valid range",
      ({ x, y }) => {
        const range = scrollToVisibleRange(x, y, config, w, h);
        expect(range.startRow).toBeGreaterThanOrEqual(0);
        expect(range.startCol).toBeGreaterThanOrEqual(0);
        expect(range.endRow).toBeGreaterThanOrEqual(range.startRow);
        expect(range.endCol).toBeGreaterThanOrEqual(range.startCol);
        expect(range.endRow).toBeLessThan(config.totalRows);
        expect(range.endCol).toBeLessThan(config.totalCols);
      },
    );
  });

  it("scroll at origin starts at row 0, col 0", () => {
    const range = scrollToVisibleRange(0, 0, config, 1000, 600);
    expect(range.startRow).toBe(0);
    expect(range.startCol).toBe(0);
  });

  it("offset is negative and within one cell", () => {
    const range = scrollToVisibleRange(50, 12, config, 1000, 600);
    expect(range.offsetX).toBe(-50);
    expect(range.offsetY).toBe(-12);
  });

  it("scrolling down moves startRow", () => {
    const range = scrollToVisibleRange(0, 250, config, 1000, 600);
    expect(range.startRow).toBe(10); // 250 / 25 = 10
  });

  it("scrolling right moves startCol", () => {
    const range = scrollToVisibleRange(300, 0, config, 1000, 600);
    expect(range.startCol).toBe(3); // 300 / 100 = 3
  });
});

// ============================================================================
// 5. clampScroll
// ============================================================================

describe("clampScroll", () => {
  const config = makeConfig();

  it("clamps negative scroll to zero", () => {
    const result = clampScroll(-100, -200, config, 1000, 600);
    expect(result.scrollX).toBe(0);
    expect(result.scrollY).toBe(0);
  });

  it("clamps excessive scroll to max", () => {
    const result = clampScroll(999999, 999999, config, 1000, 600);
    const { maxScrollX, maxScrollY } = calculateMaxScroll(config, 1000, 600);
    expect(result.scrollX).toBe(maxScrollX);
    expect(result.scrollY).toBe(maxScrollY);
  });

  it("within-bounds scroll is unchanged", () => {
    const result = clampScroll(100, 100, config, 1000, 600);
    expect(result.scrollX).toBe(100);
    expect(result.scrollY).toBe(100);
  });
});

// ============================================================================
// 6. calculateMaxScroll
// ============================================================================

describe("calculateMaxScroll", () => {
  it("max scroll is positive for large grids", () => {
    const config = makeConfig();
    const { maxScrollX, maxScrollY } = calculateMaxScroll(config, 1000, 600);
    expect(maxScrollX).toBeGreaterThan(0);
    expect(maxScrollY).toBeGreaterThan(0);
  });

  it("max scroll is 0 when viewport is larger than content", () => {
    const config = makeConfig({ totalRows: 5, totalCols: 3 });
    const { maxScrollX, maxScrollY } = calculateMaxScroll(config, 10000, 10000);
    expect(maxScrollX).toBe(0);
    expect(maxScrollY).toBe(0);
  });

  it("custom wider columns increase max scroll X", () => {
    const config = makeConfig();
    const dims: DimensionOverrides = {
      columnWidths: new Map([[0, 500]]),
      rowHeights: new Map(),
    };
    const base = calculateMaxScroll(config, 1000, 600);
    const custom = calculateMaxScroll(config, 1000, 600, dims);
    expect(custom.maxScrollX).toBeGreaterThan(base.maxScrollX);
  });
});

// ============================================================================
// 7. Dimension helpers
// ============================================================================

describe("dimension helpers", () => {
  const config = makeConfig();

  it("getColumnWidthFromDimensions returns default", () => {
    expect(getColumnWidthFromDimensions(5, config)).toBe(100);
  });

  it("getColumnWidthFromDimensions returns custom", () => {
    const dims: DimensionOverrides = {
      columnWidths: new Map([[5, 200]]),
      rowHeights: new Map(),
    };
    expect(getColumnWidthFromDimensions(5, config, dims)).toBe(200);
  });

  it("hidden column has width 0", () => {
    const dims: DimensionOverrides = {
      columnWidths: new Map(),
      rowHeights: new Map(),
      hiddenCols: new Set([5]),
    };
    expect(getColumnWidthFromDimensions(5, config, dims)).toBe(0);
  });

  it("getRowHeightFromDimensions returns default", () => {
    expect(getRowHeightFromDimensions(10, config)).toBe(25);
  });

  it("getRowHeightFromDimensions returns custom", () => {
    const dims: DimensionOverrides = {
      columnWidths: new Map(),
      rowHeights: new Map([[10, 50]]),
    };
    expect(getRowHeightFromDimensions(10, config, dims)).toBe(50);
  });

  it("hidden row has height 0", () => {
    const dims: DimensionOverrides = {
      columnWidths: new Map(),
      rowHeights: new Map(),
      hiddenRows: new Set([10]),
    };
    expect(getRowHeightFromDimensions(10, config, dims)).toBe(0);
  });
});

// ============================================================================
// 8. Position helpers
// ============================================================================

describe("getColumnXPosition and getRowYPosition", () => {
  const config = makeConfig();

  it("column 0 starts at x=0", () => {
    expect(getColumnXPosition(0, config)).toBe(0);
  });

  it("column 5 starts at 500 (5*100)", () => {
    expect(getColumnXPosition(5, config)).toBe(500);
  });

  it("row 0 starts at y=0", () => {
    expect(getRowYPosition(0, config)).toBe(0);
  });

  it("row 10 starts at 250 (10*25)", () => {
    expect(getRowYPosition(10, config)).toBe(250);
  });

  it("custom width shifts subsequent columns", () => {
    const dims: DimensionOverrides = {
      columnWidths: new Map([[0, 200]]),
      rowHeights: new Map(),
    };
    expect(getColumnXPosition(1, config, dims)).toBe(200);
  });
});

// ============================================================================
// 9. cellToScroll and cellToCenteredScroll
// ============================================================================

describe("cellToScroll", () => {
  const config = makeConfig();

  it("cell (0,0) scrolls to origin", () => {
    const result = cellToScroll(0, 0, config);
    expect(result.scrollX).toBe(0);
    expect(result.scrollY).toBe(0);
  });

  it("cell (10, 5) scrolls to correct position", () => {
    const result = cellToScroll(10, 5, config);
    expect(result.scrollX).toBe(500);
    expect(result.scrollY).toBe(250);
  });
});

describe("cellToCenteredScroll", () => {
  const config = makeConfig();

  it("returns scroll values", () => {
    const result = cellToCenteredScroll(50, 10, config, 1000, 600);
    expect(typeof result.scrollX).toBe("number");
    expect(typeof result.scrollY).toBe("number");
  });
});

// ============================================================================
// 10. calculateScrollDelta
// ============================================================================

describe("calculateScrollDelta", () => {
  const config = makeConfig();
  const viewport = makeViewport();

  const directions: Array<"up" | "down" | "left" | "right"> = ["up", "down", "left", "right"];
  const units: Array<"cell" | "page" | "document"> = ["cell", "page", "document"];

  describe.each(directions)("direction %s", (dir) => {
    it.each(units)("unit %s returns a delta", (unit) => {
      const delta = calculateScrollDelta(dir, unit, config, viewport, 1000, 600);
      expect(typeof delta.deltaX).toBe("number");
      expect(typeof delta.deltaY).toBe("number");
    });
  });

  it("cell down delta equals default cell height", () => {
    const delta = calculateScrollDelta("down", "cell", config, viewport, 1000, 600);
    expect(delta.deltaY).toBe(25);
    expect(delta.deltaX).toBe(0);
  });

  it("cell right delta equals default cell width", () => {
    const delta = calculateScrollDelta("right", "cell", config, viewport, 1000, 600);
    expect(delta.deltaX).toBe(100);
    expect(delta.deltaY).toBe(0);
  });

  it("document up from origin has zero or negative delta", () => {
    const delta = calculateScrollDelta("up", "document", config, viewport, 1000, 600);
    expect(delta.deltaY).toBeLessThanOrEqual(0);
  });
});

// ============================================================================
// 11. isCellVisible
// ============================================================================

describe("isCellVisible", () => {
  const config = makeConfig();
  const viewport = makeViewport({ scrollX: 0, scrollY: 0 });

  it("cell (0,0) is visible at origin", () => {
    expect(isCellVisible(0, 0, viewport, config, 1000, 600)).toBe(true);
  });

  it("cell far away is not visible at origin", () => {
    expect(isCellVisible(500, 50, viewport, config, 1000, 600)).toBe(false);
  });
});

// ============================================================================
// 12. scrollToMakeVisible
// ============================================================================

describe("scrollToMakeVisible", () => {
  const config = makeConfig();
  const viewport = makeViewport({ scrollX: 0, scrollY: 0 });

  it("returns null if cell already visible", () => {
    const result = scrollToMakeVisible(0, 0, viewport, config, 1000, 600);
    expect(result).toBeNull();
  });

  it("returns scroll values for off-screen cell", () => {
    const result = scrollToMakeVisible(500, 50, viewport, config, 1000, 600);
    expect(result).not.toBeNull();
    expect(result!.scrollX).toBeGreaterThan(0);
    expect(result!.scrollY).toBeGreaterThan(0);
  });
});

// ============================================================================
// 13. Scrollbar metrics
// ============================================================================

describe("calculateScrollbarMetrics", () => {
  const config = makeConfig();
  const viewport = makeViewport();

  it("produces positive thumb sizes", () => {
    const metrics = calculateScrollbarMetrics(config, viewport, 1000, 600);
    expect(metrics.horizontal.thumbSize).toBeGreaterThan(0);
    expect(metrics.vertical.thumbSize).toBeGreaterThan(0);
  });

  it("thumb position at origin is 0", () => {
    const metrics = calculateScrollbarMetrics(config, viewport, 1000, 600);
    expect(metrics.horizontal.thumbPosition).toBe(0);
    expect(metrics.vertical.thumbPosition).toBe(0);
  });
});

// ============================================================================
// 14. thumbPositionToScroll
// ============================================================================

describe("thumbPositionToScroll", () => {
  it("position 0 returns scroll 0", () => {
    expect(thumbPositionToScroll(0, 50, 500, 10000, 500)).toBe(0);
  });

  it("thumb at end returns max scroll", () => {
    const scroll = thumbPositionToScroll(450, 50, 500, 10000, 500);
    expect(scroll).toBeCloseTo(9500, 0);
  });

  it("returns 0 when thumb fills track", () => {
    expect(thumbPositionToScroll(0, 500, 500, 500, 500)).toBe(0);
  });
});

// ============================================================================
// 15. F4 reference toggle - all 4 states x formula patterns
// ============================================================================

describe("toggleReferenceAtCursor - all 4 states", () => {
  // B2 -> $B$2 -> B$2 -> $B2 -> B2
  const patterns = [
    { input: "=B2+1", cursor: 2, expected: "=$B$2+1" },
    { input: "=$B$2+1", cursor: 4, expected: "=B$2+1" },
    { input: "=B$2+1", cursor: 3, expected: "=$B2+1" },
    { input: "=$B2+1", cursor: 3, expected: "=B2+1" },
  ];

  it.each(patterns)("toggles '$input' at cursor $cursor to '$expected'", ({ input, cursor, expected }) => {
    const result = toggleReferenceAtCursor(input, cursor);
    expect(result.formula).toBe(expected);
  });

  it("no reference returns unchanged", () => {
    const result = toggleReferenceAtCursor("=SUM()", 5);
    expect(result.formula).toBe("=SUM()");
  });

  it("falls back to nearest reference before cursor", () => {
    const result = toggleReferenceAtCursor("=SUM(B2)", 8);
    expect(result.formula).toBe("=SUM($B$2)");
  });

  const formulaPatterns = [
    "=A1",
    "=SUM(A1:B5)",
    "=A1+B2*C3",
    "=IF(A1>0,B1,C1)",
    "=VLOOKUP(A1,B1:C10,2,FALSE)",
  ];

  it.each(formulaPatterns)("toggles reference in '%s' without crash", (formula) => {
    const result = toggleReferenceAtCursor(formula, 2);
    expect(result.formula).toBeDefined();
    expect(typeof result.cursorPos).toBe("number");
  });

  // Full cycle test
  it("cycles through all 4 states and back", () => {
    let formula = "=B2";
    let cursor = 2;

    // B2 -> $B$2
    let result = toggleReferenceAtCursor(formula, cursor);
    expect(result.formula).toBe("=$B$2");

    // $B$2 -> B$2
    result = toggleReferenceAtCursor(result.formula, 2);
    expect(result.formula).toBe("=B$2");

    // B$2 -> $B2
    result = toggleReferenceAtCursor(result.formula, 2);
    expect(result.formula).toBe("=$B2");

    // $B2 -> B2
    result = toggleReferenceAtCursor(result.formula, 2);
    expect(result.formula).toBe("=B2");
  });
});

// ============================================================================
// 16. getReferenceAtCursor
// ============================================================================

describe("getReferenceAtCursor", () => {
  it("finds reference at cursor", () => {
    const result = getReferenceAtCursor("=A1+B2", 2);
    expect(result).not.toBeNull();
    expect(result!.ref).toBe("A1");
  });

  it("finds reference at exact start", () => {
    const result = getReferenceAtCursor("=A1", 1);
    expect(result).not.toBeNull();
  });

  it("returns null when no references", () => {
    const result = getReferenceAtCursor("=SUM()", 3);
    expect(result).toBeNull();
  });

  it("falls back to nearest before cursor", () => {
    const result = getReferenceAtCursor("=SUM(B2)", 8);
    expect(result).not.toBeNull();
    expect(result!.ref).toBe("B2");
  });

  it("multi-letter column reference", () => {
    const result = getReferenceAtCursor("=AA100", 1);
    expect(result).not.toBeNull();
    expect(result!.ref).toBe("AA100");
  });
});

// ============================================================================
// 17. SCROLLBAR constants
// ============================================================================

describe("scrollbar constants", () => {
  it("SCROLLBAR_WIDTH is 17", () => {
    expect(SCROLLBAR_WIDTH).toBe(17);
  });

  it("SCROLLBAR_HEIGHT is 17", () => {
    expect(SCROLLBAR_HEIGHT).toBe(17);
  });
});
