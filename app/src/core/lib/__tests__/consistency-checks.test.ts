//! FILENAME: app/src/core/lib/__tests__/consistency-checks.test.ts
// PURPOSE: Integration-level consistency checks verifying that multiple core
//          modules produce consistent results when working together.

import { describe, it, expect } from "vitest";
import { columnToLetter, letterToColumn } from "../../types/types";
import { parseFormulaReferences } from "../formulaRefParser";
import {
  scrollToVisibleRange,
  isCellVisible,
  getColumnXPosition,
  getRowYPosition,
  getColumnWidthFromDimensions,
  getRowHeightFromDimensions,
  calculateScrollbarMetrics,
} from "../scrollUtils";
import type { GridConfig, Viewport, DimensionOverrides } from "../../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<GridConfig>): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 25,
    rowHeaderWidth: 50,
    colHeaderHeight: 25,
    totalRows: 1000,
    totalCols: 100,
    minColumnWidth: 20,
    minRowHeight: 10,
    ...overrides,
  };
}

function makeDimensions(overrides?: Partial<DimensionOverrides>): DimensionOverrides {
  return {
    columnWidths: new Map(),
    rowHeights: new Map(),
    hiddenRows: new Set(),
    hiddenCols: new Set(),
    ...overrides,
  };
}

// ===========================================================================
// columnToLetter / letterToColumn round-trip
// ===========================================================================

describe("columnToLetter and letterToColumn are true inverses", () => {
  it("round-trips all 16384 columns (0..16383)", () => {
    for (let col = 0; col < 16384; col++) {
      const letter = columnToLetter(col);
      const back = letterToColumn(letter);
      if (back !== col) {
        // Fail with a useful message on first mismatch
        expect(back).toBe(col);
      }
    }
  });

  it("letterToColumn -> columnToLetter round-trips single letters", () => {
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      expect(columnToLetter(letterToColumn(letter))).toBe(letter);
    }
  });

  it("letterToColumn -> columnToLetter round-trips two-letter combos", () => {
    for (let a = 0; a < 26; a++) {
      for (let b = 0; b < 26; b++) {
        const letters = String.fromCharCode(65 + a) + String.fromCharCode(65 + b);
        expect(columnToLetter(letterToColumn(letters))).toBe(letters);
      }
    }
  });
});

// ===========================================================================
// parseFormulaReferences coordinate consistency
// ===========================================================================

describe("parseFormulaReferences returns consistent 0-based coordinates", () => {
  it("single cell A1 is (0,0)", () => {
    const refs = parseFormulaReferences("=A1");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(0);
    expect(refs[0].startCol).toBe(0);
    expect(refs[0].endRow).toBe(0);
    expect(refs[0].endCol).toBe(0);
  });

  it("range B2:D5 is 0-based inclusive", () => {
    const refs = parseFormulaReferences("=B2:D5");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBe(1);
    expect(refs[0].startCol).toBe(1);
    expect(refs[0].endRow).toBe(4);
    expect(refs[0].endCol).toBe(3);
  });

  it("all references in a complex formula are 0-based", () => {
    const refs = parseFormulaReferences("=SUM(A1,Z26,AA27:AZ52)");
    for (const ref of refs) {
      expect(ref.startRow).toBeGreaterThanOrEqual(0);
      expect(ref.startCol).toBeGreaterThanOrEqual(0);
      expect(ref.endRow).toBeGreaterThanOrEqual(ref.startRow);
      expect(ref.endCol).toBeGreaterThanOrEqual(ref.startCol);
    }
  });

  it("reversed range coordinates are normalised (start <= end)", () => {
    // D5:B2 should still have startRow <= endRow, startCol <= endCol
    const refs = parseFormulaReferences("=D5:B2");
    expect(refs).toHaveLength(1);
    expect(refs[0].startRow).toBeLessThanOrEqual(refs[0].endRow);
    expect(refs[0].startCol).toBeLessThanOrEqual(refs[0].endCol);
  });
});

// ===========================================================================
// scrollToVisibleRange and isCellVisible agreement
// ===========================================================================

describe("scrollToVisibleRange and isCellVisible agree", () => {
  const config = makeConfig();
  const vpWidth = 1200;
  const vpHeight = 800;

  it("all cells in visible range report as visible", () => {
    const scrollX = 200;
    const scrollY = 500;
    const range = scrollToVisibleRange(scrollX, scrollY, config, vpWidth, vpHeight);

    const viewport: Viewport = {
      startRow: range.startRow,
      startCol: range.startCol,
      rowCount: range.endRow - range.startRow + 1,
      colCount: range.endCol - range.startCol + 1,
      scrollX,
      scrollY,
    };

    for (let r = range.startRow; r <= range.endRow; r++) {
      for (let c = range.startCol; c <= range.endCol; c++) {
        expect(isCellVisible(r, c, viewport, config, vpWidth, vpHeight)).toBe(true);
      }
    }
  });

  it("cells before visible range are not visible", () => {
    const range = scrollToVisibleRange(300, 400, config, vpWidth, vpHeight);
    const viewport: Viewport = {
      startRow: range.startRow,
      startCol: range.startCol,
      rowCount: range.endRow - range.startRow + 1,
      colCount: range.endCol - range.startCol + 1,
      scrollX: 300,
      scrollY: 400,
    };

    if (range.startRow > 0) {
      expect(isCellVisible(range.startRow - 1, range.startCol, viewport, config, vpWidth, vpHeight)).toBe(false);
    }
    if (range.startCol > 0) {
      expect(isCellVisible(range.startRow, range.startCol - 1, viewport, config, vpWidth, vpHeight)).toBe(false);
    }
  });
});

// ===========================================================================
// getColumnXPosition accumulation consistency
// ===========================================================================

describe("getColumnXPosition accumulates correctly", () => {
  it("pos[n+1] = pos[n] + width[n] with default dimensions", () => {
    const config = makeConfig();
    for (let col = 0; col < 50; col++) {
      const pos = getColumnXPosition(col, config);
      const width = getColumnWidthFromDimensions(col, config);
      const nextPos = getColumnXPosition(col + 1, config);
      expect(nextPos).toBe(pos + width);
    }
  });

  it("pos[n+1] = pos[n] + width[n] with custom widths", () => {
    const config = makeConfig();
    const dims = makeDimensions({
      columnWidths: new Map([[2, 200], [5, 50], [10, 300]]),
    });
    for (let col = 0; col < 20; col++) {
      const pos = getColumnXPosition(col, config, dims);
      const width = getColumnWidthFromDimensions(col, config, dims);
      const nextPos = getColumnXPosition(col + 1, config, dims);
      expect(nextPos).toBe(pos + width);
    }
  });

  it("pos[n+1] = pos[n] + width[n] with hidden columns", () => {
    const config = makeConfig();
    const dims = makeDimensions({
      hiddenCols: new Set([3, 7]),
    });
    for (let col = 0; col < 15; col++) {
      const pos = getColumnXPosition(col, config, dims);
      const width = getColumnWidthFromDimensions(col, config, dims);
      const nextPos = getColumnXPosition(col + 1, config, dims);
      expect(nextPos).toBe(pos + width);
    }
  });
});

// ===========================================================================
// getRowYPosition accumulation consistency
// ===========================================================================

describe("getRowYPosition accumulates correctly", () => {
  it("pos[n+1] = pos[n] + height[n] with default dimensions", () => {
    const config = makeConfig();
    for (let row = 0; row < 50; row++) {
      const pos = getRowYPosition(row, config);
      const height = getRowHeightFromDimensions(row, config);
      const nextPos = getRowYPosition(row + 1, config);
      expect(nextPos).toBe(pos + height);
    }
  });

  it("pos[n+1] = pos[n] + height[n] with custom heights", () => {
    const config = makeConfig();
    const dims = makeDimensions({
      rowHeights: new Map([[1, 50], [4, 10], [9, 80]]),
    });
    for (let row = 0; row < 20; row++) {
      const pos = getRowYPosition(row, config, dims);
      const height = getRowHeightFromDimensions(row, config, dims);
      const nextPos = getRowYPosition(row + 1, config, dims);
      expect(nextPos).toBe(pos + height);
    }
  });

  it("pos[n+1] = pos[n] + height[n] with hidden rows", () => {
    const config = makeConfig();
    const dims = makeDimensions({
      hiddenRows: new Set([2, 6]),
    });
    for (let row = 0; row < 15; row++) {
      const pos = getRowYPosition(row, config, dims);
      const height = getRowHeightFromDimensions(row, config, dims);
      const nextPos = getRowYPosition(row + 1, config, dims);
      expect(nextPos).toBe(pos + height);
    }
  });
});

// ===========================================================================
// calculateScrollbarMetrics consistency
// ===========================================================================

describe("calculateScrollbarMetrics thumb + track positions are consistent", () => {
  const config = makeConfig({ totalRows: 10000, totalCols: 200 });
  const vpWidth = 1200;
  const vpHeight = 800;

  it("thumb position is within [0, trackSize - thumbSize]", () => {
    for (const scrollX of [0, 500, 5000]) {
      for (const scrollY of [0, 1000, 50000]) {
        const viewport: Viewport = {
          startRow: 0, startCol: 0, rowCount: 30, colCount: 10,
          scrollX, scrollY,
        };
        const m = calculateScrollbarMetrics(config, viewport, vpWidth, vpHeight);

        expect(m.horizontal.thumbPosition).toBeGreaterThanOrEqual(0);
        expect(m.horizontal.thumbPosition).toBeLessThanOrEqual(
          m.horizontal.trackSize - m.horizontal.thumbSize + 0.001
        );
        expect(m.vertical.thumbPosition).toBeGreaterThanOrEqual(0);
        expect(m.vertical.thumbPosition).toBeLessThanOrEqual(
          m.vertical.trackSize - m.vertical.thumbSize + 0.001
        );
      }
    }
  });

  it("thumb size does not exceed track size", () => {
    const viewport: Viewport = {
      startRow: 0, startCol: 0, rowCount: 30, colCount: 10,
      scrollX: 0, scrollY: 0,
    };
    const m = calculateScrollbarMetrics(config, viewport, vpWidth, vpHeight);
    expect(m.horizontal.thumbSize).toBeLessThanOrEqual(m.horizontal.trackSize);
    expect(m.vertical.thumbSize).toBeLessThanOrEqual(m.vertical.trackSize);
  });

  it("scroll at 0 gives thumb position 0", () => {
    const viewport: Viewport = {
      startRow: 0, startCol: 0, rowCount: 30, colCount: 10,
      scrollX: 0, scrollY: 0,
    };
    const m = calculateScrollbarMetrics(config, viewport, vpWidth, vpHeight);
    expect(m.horizontal.thumbPosition).toBe(0);
    expect(m.vertical.thumbPosition).toBe(0);
  });
});

// ===========================================================================
// Determinism: same arguments produce identical results
// ===========================================================================

describe("determinism: multiple calls with same arguments produce identical results", () => {
  it("columnToLetter is deterministic", () => {
    for (let i = 0; i < 100; i++) {
      expect(columnToLetter(702)).toBe("AAA");
    }
  });

  it("parseFormulaReferences is deterministic", () => {
    const formula = "=SUM(A1:B10,Sheet1!C5,$D$3)";
    const first = parseFormulaReferences(formula);
    for (let i = 0; i < 10; i++) {
      const result = parseFormulaReferences(formula);
      expect(result).toEqual(first);
    }
  });

  it("scrollToVisibleRange is deterministic", () => {
    const config = makeConfig();
    const first = scrollToVisibleRange(150, 300, config, 1200, 800);
    for (let i = 0; i < 10; i++) {
      expect(scrollToVisibleRange(150, 300, config, 1200, 800)).toEqual(first);
    }
  });

  it("getColumnXPosition is deterministic", () => {
    const config = makeConfig();
    const dims = makeDimensions({ columnWidths: new Map([[3, 200]]) });
    const first = getColumnXPosition(10, config, dims);
    for (let i = 0; i < 10; i++) {
      expect(getColumnXPosition(10, config, dims)).toBe(first);
    }
  });

  it("calculateScrollbarMetrics is deterministic", () => {
    const config = makeConfig();
    const vp: Viewport = {
      startRow: 0, startCol: 0, rowCount: 30, colCount: 10,
      scrollX: 500, scrollY: 1000,
    };
    const first = calculateScrollbarMetrics(config, vp, 1200, 800);
    for (let i = 0; i < 10; i++) {
      expect(calculateScrollbarMetrics(config, vp, 1200, 800)).toEqual(first);
    }
  });
});
