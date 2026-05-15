//! FILENAME: app/src/core/lib/__tests__/excel-boundaries.test.ts
// PURPOSE: Boundary/regression tests for Excel compatibility edge cases.
// CONTEXT: Validates max row (1048576), max column (XFD=16383), and related
//          functions at Excel limits.

import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "../../types";
import {
  parseFormulaReferences,
  parseFormulaReferencesWithPositions,
  buildCellReference,
  buildRangeReference,
} from "../formulaRefParser";
import {
  scrollToVisibleRange,
  clampScroll,
  calculateMaxScroll,
  cellToScroll,
  cellToCenteredScroll,
  isCellVisible,
  scrollToMakeVisible,
  calculateScrollDelta,
  getColumnXPosition,
  getRowYPosition,
} from "../scrollUtils";
import type { GridConfig, Viewport } from "../../types";

// ============================================================================
// Constants
// ============================================================================

const EXCEL_MAX_ROW = 1048576; // 1-based in Excel, 0-based index = 1048575
const EXCEL_MAX_ROW_IDX = EXCEL_MAX_ROW - 1;
const EXCEL_MAX_COL = 16384; // XFD is column 16384 in 1-based, 0-based = 16383
const EXCEL_MAX_COL_IDX = EXCEL_MAX_COL - 1;

/** Grid config sized to Excel limits. */
function excelConfig(overrides: Partial<GridConfig> = {}): GridConfig {
  return {
    defaultCellWidth: 80,
    defaultCellHeight: 24,
    rowHeaderWidth: 50,
    colHeaderHeight: 24,
    totalRows: EXCEL_MAX_ROW,
    totalCols: EXCEL_MAX_COL,
    minColumnWidth: 20,
    minRowHeight: 10,
    outlineBarWidth: 0,
    ...overrides,
  } as GridConfig;
}

// ============================================================================
// columnToLetter / letterToColumn at boundaries
// ============================================================================

describe("columnToLetter at Excel boundaries", () => {
  it("converts max column index 16383 to XFD", () => {
    expect(columnToLetter(EXCEL_MAX_COL_IDX)).toBe("XFD");
  });

  it("converts one past max (16384) to XFE", () => {
    // The function itself does not enforce Excel limits
    expect(columnToLetter(16384)).toBe("XFE");
  });

  it("converts 0 to A", () => {
    expect(columnToLetter(0)).toBe("A");
  });

  it("converts column 702 (AAA) correctly", () => {
    expect(columnToLetter(702)).toBe("AAA");
  });

  it("handles very large column index (100000)", () => {
    const letter = columnToLetter(100000);
    expect(letter.length).toBeGreaterThanOrEqual(3);
    // Round-trip should work
    expect(letterToColumn(letter)).toBe(100000);
  });
});

describe("letterToColumn at Excel boundaries", () => {
  it("converts XFD to 16383", () => {
    expect(letterToColumn("XFD")).toBe(EXCEL_MAX_COL_IDX);
  });

  it("converts XFE to 16384 (one past max)", () => {
    expect(letterToColumn("XFE")).toBe(16384);
  });

  it("is case-sensitive (uses uppercase char codes)", () => {
    // letterToColumn uses charCodeAt - 64, which assumes uppercase
    expect(letterToColumn("A")).toBe(0);
    expect(letterToColumn("Z")).toBe(25);
  });

  it("round-trips at max column", () => {
    expect(letterToColumn(columnToLetter(EXCEL_MAX_COL_IDX))).toBe(EXCEL_MAX_COL_IDX);
  });

  it("round-trips for columns near boundaries", () => {
    for (const col of [0, 25, 26, 255, 256, 701, 702, 16382, 16383]) {
      expect(letterToColumn(columnToLetter(col))).toBe(col);
    }
  });
});

// ============================================================================
// parseFormulaReferences with max row/col references
// ============================================================================

describe("parseFormulaReferences with Excel max references", () => {
  it("parses reference to max row (XFD1048576)", () => {
    const refs = parseFormulaReferences("=XFD1048576");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(EXCEL_MAX_ROW_IDX);
    expect(refs[0].startCol).toBe(EXCEL_MAX_COL_IDX);
  });

  it("parses range spanning entire sheet (A1:XFD1048576)", () => {
    const refs = parseFormulaReferences("=A1:XFD1048576");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(0);
    expect(refs[0].startCol).toBe(0);
    expect(refs[0].endRow).toBe(EXCEL_MAX_ROW_IDX);
    expect(refs[0].endCol).toBe(EXCEL_MAX_COL_IDX);
  });

  it("parses absolute reference at max ($XFD$1048576)", () => {
    const refs = parseFormulaReferences("=$XFD$1048576");
    expect(refs).toHaveLength(1);
    expect(refs[0].startCol).toBe(EXCEL_MAX_COL_IDX);
    expect(refs[0].startRow).toBe(EXCEL_MAX_ROW_IDX);
  });

  it("parses multiple references including max", () => {
    const refs = parseFormulaReferences("=A1+XFD1048576+B2");
    expect(refs).toHaveLength(3);
    expect(refs[1].startCol).toBe(EXCEL_MAX_COL_IDX);
    expect(refs[1].startRow).toBe(EXCEL_MAX_ROW_IDX);
  });

  it("handles row numbers beyond 7 digits (regex limit)", () => {
    // The regex pattern uses \\d{1,7} so row 10485760 (8 digits) should not fully match
    const refs = parseFormulaReferences("=A10485760");
    // 1048576 (7 digits) should match, trailing 0 is not part of reference
    if (refs.length > 0) {
      expect(refs[0].startRow).toBe(1048576 - 1); // 7-digit number parsed
    }
  });

  it("handles cross-sheet reference at max", () => {
    const refs = parseFormulaReferences("=Sheet1!XFD1048576");
    expect(refs).toHaveLength(1);
    expect(refs[0].sheetName).toBe("Sheet1");
    expect(refs[0].startCol).toBe(EXCEL_MAX_COL_IDX);
    expect(refs[0].startRow).toBe(EXCEL_MAX_ROW_IDX);
  });

  it("returns empty for non-formula strings", () => {
    expect(parseFormulaReferences("not a formula")).toHaveLength(0);
  });
});

describe("parseFormulaReferencesWithPositions at boundaries", () => {
  it("tracks text positions for max reference", () => {
    const refs = parseFormulaReferencesWithPositions("=$XFD$1048576");
    expect(refs).toHaveLength(1);
    expect(refs[0].originalText).toBe("$XFD$1048576");
    expect(refs[0].isStartColAbsolute).toBe(true);
    expect(refs[0].isStartRowAbsolute).toBe(true);
    expect(refs[0].textStartIndex).toBe(1); // after '='
  });

  it("tracks positions in range at max", () => {
    const refs = parseFormulaReferencesWithPositions("=$A$1:$XFD$1048576");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(0);
    expect(refs[0].endRow).toBe(EXCEL_MAX_ROW_IDX);
    expect(refs[0].isEndColAbsolute).toBe(true);
    expect(refs[0].isEndRowAbsolute).toBe(true);
  });
});

// ============================================================================
// buildCellReference / buildRangeReference at boundaries
// ============================================================================

describe("buildCellReference at boundaries", () => {
  it("builds reference for max cell", () => {
    const ref = buildCellReference(EXCEL_MAX_ROW_IDX, EXCEL_MAX_COL_IDX, false, false);
    expect(ref).toBe("XFD1048576");
  });

  it("builds absolute reference for max cell", () => {
    const ref = buildCellReference(EXCEL_MAX_ROW_IDX, EXCEL_MAX_COL_IDX, true, true);
    expect(ref).toBe("$XFD$1048576");
  });

  it("builds reference for A1 (origin)", () => {
    const ref = buildCellReference(0, 0, false, false);
    expect(ref).toBe("A1");
  });
});

describe("buildRangeReference at boundaries", () => {
  it("builds full sheet range", () => {
    const ref = buildRangeReference(
      0, 0, EXCEL_MAX_ROW_IDX, EXCEL_MAX_COL_IDX,
      false, false, false, false,
    );
    expect(ref).toBe("A1:XFD1048576");
  });

  it("collapses single-cell range at max", () => {
    const ref = buildRangeReference(
      EXCEL_MAX_ROW_IDX, EXCEL_MAX_COL_IDX,
      EXCEL_MAX_ROW_IDX, EXCEL_MAX_COL_IDX,
      true, true, true, true,
    );
    expect(ref).toBe("$XFD$1048576");
  });

  it("builds range with sheet name at max", () => {
    const ref = buildRangeReference(
      0, 0, EXCEL_MAX_ROW_IDX, EXCEL_MAX_COL_IDX,
      false, false, false, false, "Sheet1",
    );
    expect(ref).toBe("Sheet1!A1:XFD1048576");
  });
});

// ============================================================================
// scrollUtils with 1M row grids
// ============================================================================

describe("scrollToVisibleRange with Excel-sized grid", () => {
  const config = excelConfig();
  const vpW = 1200;
  const vpH = 800;

  it("returns valid range at scroll origin", () => {
    const range = scrollToVisibleRange(0, 0, config, vpW, vpH);
    expect(range.startRow).toBe(0);
    expect(range.startCol).toBe(0);
    expect(range.endRow).toBeGreaterThan(0);
    expect(range.endCol).toBeGreaterThan(0);
  });

  it("clamps endRow to totalRows - 1 near bottom", () => {
    const scrollY = (EXCEL_MAX_ROW - 1) * config.defaultCellHeight;
    const range = scrollToVisibleRange(0, scrollY, config, vpW, vpH);
    expect(range.endRow).toBeLessThanOrEqual(EXCEL_MAX_ROW_IDX);
  });

  it("clamps endCol to totalCols - 1 near right edge", () => {
    const scrollX = (EXCEL_MAX_COL - 1) * config.defaultCellWidth;
    const range = scrollToVisibleRange(scrollX, 0, config, vpW, vpH);
    expect(range.endCol).toBeLessThanOrEqual(EXCEL_MAX_COL_IDX);
  });

  it("computes sub-cell offset for smooth scrolling", () => {
    const scrollY = 100; // not aligned to cell boundary
    const range = scrollToVisibleRange(0, scrollY, config, vpW, vpH);
    expect(range.offsetY).toBe(-(100 % config.defaultCellHeight));
  });
});

describe("clampScroll with Excel-sized grid", () => {
  const config = excelConfig();
  const vpW = 1200;
  const vpH = 800;

  it("clamps negative scroll to zero", () => {
    const result = clampScroll(-100, -200, config, vpW, vpH);
    expect(result.scrollX).toBe(0);
    expect(result.scrollY).toBe(0);
  });

  it("clamps excessive scroll to max", () => {
    const huge = 999_999_999;
    const result = clampScroll(huge, huge, config, vpW, vpH);
    const { maxScrollX, maxScrollY } = calculateMaxScroll(config, vpW, vpH);
    expect(result.scrollX).toBe(maxScrollX);
    expect(result.scrollY).toBe(maxScrollY);
  });

  it("computes startRow/startCol from clamped position", () => {
    const result = clampScroll(240, 72, config, vpW, vpH);
    expect(result.startRow).toBe(Math.floor(72 / config.defaultCellHeight));
    expect(result.startCol).toBe(Math.floor(240 / config.defaultCellWidth));
  });
});

describe("calculateMaxScroll with Excel-sized grid", () => {
  const config = excelConfig();
  const vpW = 1200;
  const vpH = 800;

  it("returns positive maxScrollY for 1M rows", () => {
    const { maxScrollY } = calculateMaxScroll(config, vpW, vpH);
    expect(maxScrollY).toBeGreaterThan(0);
    // Total content height = 1048576 * 24 = 25165824
    const expectedContentH = EXCEL_MAX_ROW * config.defaultCellHeight;
    const availableH = vpH - config.colHeaderHeight - 17; // SCROLLBAR_HEIGHT
    expect(maxScrollY).toBe(expectedContentH - availableH);
  });

  it("returns positive maxScrollX for 16384 columns", () => {
    const { maxScrollX } = calculateMaxScroll(config, vpW, vpH);
    expect(maxScrollX).toBeGreaterThan(0);
  });
});

describe("cellToScroll at Excel boundaries", () => {
  const config = excelConfig();

  it("scrolls to last row", () => {
    const { scrollY } = cellToScroll(EXCEL_MAX_ROW_IDX, 0, config);
    expect(scrollY).toBe(EXCEL_MAX_ROW_IDX * config.defaultCellHeight);
  });

  it("scrolls to last column", () => {
    const { scrollX } = cellToScroll(0, EXCEL_MAX_COL_IDX, config);
    expect(scrollX).toBe(EXCEL_MAX_COL_IDX * config.defaultCellWidth);
  });

  it("scrolls to bottom-right corner", () => {
    const { scrollX, scrollY } = cellToScroll(EXCEL_MAX_ROW_IDX, EXCEL_MAX_COL_IDX, config);
    expect(scrollX).toBe(EXCEL_MAX_COL_IDX * config.defaultCellWidth);
    expect(scrollY).toBe(EXCEL_MAX_ROW_IDX * config.defaultCellHeight);
  });
});

describe("getColumnXPosition / getRowYPosition at max", () => {
  const config = excelConfig();

  it("calculates X position for last column (no custom widths)", () => {
    const x = getColumnXPosition(EXCEL_MAX_COL_IDX, config);
    expect(x).toBe(EXCEL_MAX_COL_IDX * config.defaultCellWidth);
  });

  it("calculates Y position for last row (no custom heights)", () => {
    const y = getRowYPosition(EXCEL_MAX_ROW_IDX, config);
    expect(y).toBe(EXCEL_MAX_ROW_IDX * config.defaultCellHeight);
  });

  it("handles custom width on a column near the end", () => {
    const dims = { columnWidths: new Map([[EXCEL_MAX_COL_IDX - 1, 200]]) };
    const x = getColumnXPosition(EXCEL_MAX_COL_IDX, config, dims as any);
    const expected = EXCEL_MAX_COL_IDX * config.defaultCellWidth + (200 - config.defaultCellWidth);
    expect(x).toBe(expected);
  });
});

describe("calculateScrollDelta document-end with Excel grid", () => {
  const config = excelConfig();
  const viewport: Viewport = {
    startRow: 0, startCol: 0, rowCount: 30, colCount: 10,
    scrollX: 0, scrollY: 0,
  };

  it("scroll down to document end produces huge deltaY", () => {
    const { deltaY } = calculateScrollDelta("down", "document", config, viewport, 1200, 800);
    expect(deltaY).toBe(EXCEL_MAX_ROW * config.defaultCellHeight);
  });

  it("scroll right to document end produces huge deltaX", () => {
    const { deltaX } = calculateScrollDelta("right", "document", config, viewport, 1200, 800);
    expect(deltaX).toBe(EXCEL_MAX_COL * config.defaultCellWidth);
  });
});

describe("isCellVisible at boundaries", () => {
  const config = excelConfig();
  const viewport: Viewport = {
    startRow: 0, startCol: 0, rowCount: 30, colCount: 10,
    scrollX: 0, scrollY: 0,
  };

  it("cell A1 is visible at origin", () => {
    expect(isCellVisible(0, 0, viewport, config, 1200, 800)).toBe(true);
  });

  it("last cell is not visible at origin", () => {
    expect(isCellVisible(EXCEL_MAX_ROW_IDX, EXCEL_MAX_COL_IDX, viewport, config, 1200, 800)).toBe(false);
  });
});
