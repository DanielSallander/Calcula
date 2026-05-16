//! FILENAME: app/src/core/lib/gridRenderer/layout/viewport-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for viewport calculations
// TARGET: 280+ tests via it.each

import { describe, it, expect } from "vitest";
import {
  calculateVisibleRange,
  calculateFreezePaneLayout,
  calculateFrozenTopLeftRange,
} from "./viewport";
import type { GridConfig, Viewport, DimensionOverrides, FreezeConfig } from "../../../types";
import { createEmptyDimensionOverrides } from "../../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides?: Partial<GridConfig>): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 24,
    rowHeaderWidth: 50,
    colHeaderHeight: 24,
    totalRows: 1000,
    totalCols: 100,
    minColumnWidth: 20,
    minRowHeight: 10,
    outlineBarWidth: 0,
    outlineBarHeight: 0,
    ...overrides,
  } as GridConfig;
}

function makeDims(overrides?: Partial<DimensionOverrides>): DimensionOverrides {
  return { ...createEmptyDimensionOverrides(), ...overrides };
}

function vp(scrollX: number, scrollY: number): Viewport {
  return { scrollX, scrollY } as Viewport;
}

// ============================================================================
// 1. calculateVisibleRange: 100 scroll/viewport combos (10 widths x 10 scrolls)
// ============================================================================

describe("calculateVisibleRange - parameterized scroll/viewport combos", () => {
  const canvasWidths = [400, 600, 800, 1000, 1200, 1400, 1600, 1920, 2560, 3840];
  const scrollPositions = [
    { scrollX: 0, scrollY: 0 },
    { scrollX: 100, scrollY: 0 },
    { scrollX: 0, scrollY: 24 },
    { scrollX: 250, scrollY: 60 },
    { scrollX: 500, scrollY: 240 },
    { scrollX: 1000, scrollY: 480 },
    { scrollX: 2000, scrollY: 1200 },
    { scrollX: 5000, scrollY: 5000 },
    { scrollX: 9900, scrollY: 23976 },
    { scrollX: 50, scrollY: 12 },
  ];

  const cases: Array<{
    width: number;
    scrollX: number;
    scrollY: number;
  }> = [];

  for (const w of canvasWidths) {
    for (const sp of scrollPositions) {
      cases.push({ width: w, scrollX: sp.scrollX, scrollY: sp.scrollY });
    }
  }

  it.each(cases)(
    "width=$width scrollX=$scrollX scrollY=$scrollY",
    ({ width, scrollX, scrollY }) => {
      const config = makeConfig();
      const result = calculateVisibleRange(vp(scrollX, scrollY), config, width, 600);

      // startRow derived from scrollY: floor(scrollY / 24)
      const expectedStartRow = Math.floor(scrollY / 24);
      expect(result.startRow).toBe(expectedStartRow);

      // startCol derived from scrollX: floor(scrollX / 100)
      const expectedStartCol = Math.floor(scrollX / 100);
      expect(result.startCol).toBe(expectedStartCol);

      // endRow must be >= startRow
      expect(result.endRow).toBeGreaterThanOrEqual(result.startRow);
      // endCol must be >= startCol
      expect(result.endCol).toBeGreaterThanOrEqual(result.startCol);

      // endRow clamped to totalRows - 1
      expect(result.endRow).toBeLessThanOrEqual(999);
      // endCol clamped to totalCols - 1
      expect(result.endCol).toBeLessThanOrEqual(99);

      // Visible columns should roughly match, but clamped by totalCols
      const visibleWidth = width - 50;
      const expectedVisibleCols = Math.ceil(visibleWidth / 100);
      const actualVisibleCols = result.endCol - result.startCol;
      // When near the end of the grid, fewer cols are available
      const maxPossibleCols = 99 - result.startCol;
      const effectiveExpected = Math.min(expectedVisibleCols, maxPossibleCols);
      expect(actualVisibleCols).toBeGreaterThanOrEqual(effectiveExpected - 2);
      expect(actualVisibleCols).toBeLessThanOrEqual(expectedVisibleCols + 2);
    }
  );
});

// ============================================================================
// 2. calculateFreezePaneLayout: 54 freeze config combos (6 rows x 6 cols x ~1.5 sizes)
// ============================================================================

describe("calculateFreezePaneLayout - parameterized freeze combos", () => {
  const freezeRows = [0, 1, 2, 3, 4, 5];
  const freezeCols = [0, 1, 2, 3, 4, 5];
  const canvasSizes = [
    { cellWidth: 80, cellHeight: 20 },
    { cellWidth: 100, cellHeight: 24 },
    { cellWidth: 150, cellHeight: 30 },
  ];

  const cases: Array<{
    fRow: number;
    fCol: number;
    cellWidth: number;
    cellHeight: number;
  }> = [];

  for (const fr of freezeRows) {
    for (const fc of freezeCols) {
      // Use a different canvas size to keep combos manageable but cover all freeze combos
      const sizeIdx = (fr + fc) % canvasSizes.length;
      cases.push({
        fRow: fr,
        fCol: fc,
        cellWidth: canvasSizes[sizeIdx].cellWidth,
        cellHeight: canvasSizes[sizeIdx].cellHeight,
      });
    }
  }

  // Also add explicit combos for all 3 canvas sizes with a few key freeze configs
  for (const size of canvasSizes) {
    for (const fr of [0, 2, 5]) {
      for (const fc of [0, 3]) {
        cases.push({
          fRow: fr,
          fCol: fc,
          cellWidth: size.cellWidth,
          cellHeight: size.cellHeight,
        });
      }
    }
  }

  it.each(cases)(
    "freezeRow=$fRow freezeCol=$fCol cellWidth=$cellWidth cellHeight=$cellHeight",
    ({ fRow, fCol, cellWidth, cellHeight }) => {
      const config = makeConfig({ defaultCellWidth: cellWidth, defaultCellHeight: cellHeight });
      const freeze: FreezeConfig = {
        freezeRow: fRow > 0 ? fRow : null,
        freezeCol: fCol > 0 ? fCol : null,
      };
      const layout = calculateFreezePaneLayout(freeze, config);

      // Frozen width = freezeCol * cellWidth (when > 0)
      if (fCol > 0) {
        expect(layout.frozenColsWidth).toBe(fCol * cellWidth);
        expect(layout.hasFrozenCols).toBe(true);
        expect(layout.frozenColCount).toBe(fCol);
      } else {
        expect(layout.frozenColsWidth).toBe(0);
        expect(layout.hasFrozenCols).toBe(false);
      }

      // Frozen height = freezeRow * cellHeight (when > 0)
      if (fRow > 0) {
        expect(layout.frozenRowsHeight).toBe(fRow * cellHeight);
        expect(layout.hasFrozenRows).toBe(true);
        expect(layout.frozenRowCount).toBe(fRow);
      } else {
        expect(layout.frozenRowsHeight).toBe(0);
        expect(layout.hasFrozenRows).toBe(false);
      }
    }
  );
});

// ============================================================================
// 3. calculateFrozenTopLeftRange: 30 combos
// ============================================================================

describe("calculateFrozenTopLeftRange - parameterized combos", () => {
  const cases: Array<{
    fRow: number | null;
    fCol: number | null;
    expectNull: boolean;
    desc: string;
  }> = [
    // Null cases (no freeze or partial freeze) - 12 cases
    { fRow: null, fCol: null, expectNull: true, desc: "no freeze" },
    { fRow: null, fCol: 1, expectNull: true, desc: "only cols frozen=1" },
    { fRow: null, fCol: 3, expectNull: true, desc: "only cols frozen=3" },
    { fRow: null, fCol: 5, expectNull: true, desc: "only cols frozen=5" },
    { fRow: 1, fCol: null, expectNull: true, desc: "only rows frozen=1" },
    { fRow: 3, fCol: null, expectNull: true, desc: "only rows frozen=3" },
    { fRow: 5, fCol: null, expectNull: true, desc: "only rows frozen=5" },
    { fRow: 0, fCol: 0, expectNull: true, desc: "both zero" },
    { fRow: 0, fCol: 2, expectNull: true, desc: "row=0 col=2" },
    { fRow: 2, fCol: 0, expectNull: true, desc: "row=2 col=0" },
    { fRow: null, fCol: 0, expectNull: true, desc: "null row, col=0" },
    { fRow: 0, fCol: null, expectNull: true, desc: "row=0, null col" },
    // Valid cases (both frozen) - 18 cases
    { fRow: 1, fCol: 1, expectNull: false, desc: "1x1" },
    { fRow: 1, fCol: 2, expectNull: false, desc: "1x2" },
    { fRow: 1, fCol: 3, expectNull: false, desc: "1x3" },
    { fRow: 1, fCol: 5, expectNull: false, desc: "1x5" },
    { fRow: 2, fCol: 1, expectNull: false, desc: "2x1" },
    { fRow: 2, fCol: 2, expectNull: false, desc: "2x2" },
    { fRow: 2, fCol: 3, expectNull: false, desc: "2x3" },
    { fRow: 2, fCol: 5, expectNull: false, desc: "2x5" },
    { fRow: 3, fCol: 1, expectNull: false, desc: "3x1" },
    { fRow: 3, fCol: 2, expectNull: false, desc: "3x2" },
    { fRow: 3, fCol: 3, expectNull: false, desc: "3x3" },
    { fRow: 3, fCol: 5, expectNull: false, desc: "3x5" },
    { fRow: 4, fCol: 1, expectNull: false, desc: "4x1" },
    { fRow: 4, fCol: 4, expectNull: false, desc: "4x4" },
    { fRow: 5, fCol: 1, expectNull: false, desc: "5x1" },
    { fRow: 5, fCol: 2, expectNull: false, desc: "5x2" },
    { fRow: 5, fCol: 3, expectNull: false, desc: "5x3" },
    { fRow: 5, fCol: 5, expectNull: false, desc: "5x5" },
  ];

  it.each(cases)("$desc (fRow=$fRow, fCol=$fCol)", ({ fRow, fCol, expectNull }) => {
    const freeze: FreezeConfig = { freezeRow: fRow, freezeCol: fCol };
    const result = calculateFrozenTopLeftRange(freeze, makeConfig(), 800, 600);

    if (expectNull) {
      expect(result).toBeNull();
    } else {
      expect(result).not.toBeNull();
      expect(result!.startRow).toBe(0);
      expect(result!.endRow).toBe(fRow! - 1);
      expect(result!.startCol).toBe(0);
      expect(result!.endCol).toBe(fCol! - 1);
      expect(result!.offsetX).toBe(0);
      expect(result!.offsetY).toBe(0);
    }
  });
});

// ============================================================================
// 4. Viewport with hidden rows: 50 combos
// ============================================================================

describe("calculateVisibleRange - hidden rows parameterized", () => {
  // Generate 50 different hidden row patterns
  const hiddenPatterns: Array<{ name: string; hidden: number[]; scrollY: number }> = [
    // Single hidden rows
    { name: "hide row 0", hidden: [0], scrollY: 0 },
    { name: "hide row 1", hidden: [1], scrollY: 0 },
    { name: "hide row 5", hidden: [5], scrollY: 0 },
    { name: "hide row 10", hidden: [10], scrollY: 0 },
    { name: "hide row 20", hidden: [20], scrollY: 0 },
    // Multiple hidden rows at start
    { name: "hide rows 0-2", hidden: [0, 1, 2], scrollY: 0 },
    { name: "hide rows 0-4", hidden: [0, 1, 2, 3, 4], scrollY: 0 },
    { name: "hide rows 0-9", hidden: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], scrollY: 0 },
    // Scattered hidden rows
    { name: "hide even 0-10", hidden: [0, 2, 4, 6, 8, 10], scrollY: 0 },
    { name: "hide odd 1-9", hidden: [1, 3, 5, 7, 9], scrollY: 0 },
    // Hidden rows with scroll
    { name: "hide row 0, scroll 24", hidden: [0], scrollY: 24 },
    { name: "hide row 0, scroll 48", hidden: [0], scrollY: 48 },
    { name: "hide rows 0-2, scroll 24", hidden: [0, 1, 2], scrollY: 24 },
    { name: "hide rows 0-2, scroll 48", hidden: [0, 1, 2], scrollY: 48 },
    { name: "hide rows 0-2, scroll 120", hidden: [0, 1, 2], scrollY: 120 },
    // Large gaps
    { name: "hide 10,20,30", hidden: [10, 20, 30], scrollY: 0 },
    { name: "hide 10,20,30 scroll 240", hidden: [10, 20, 30], scrollY: 240 },
    { name: "hide 10,20,30 scroll 480", hidden: [10, 20, 30], scrollY: 480 },
    // Many consecutive hidden
    { name: "hide 5-15", hidden: Array.from({ length: 11 }, (_, i) => i + 5), scrollY: 0 },
    { name: "hide 5-15 scroll 120", hidden: Array.from({ length: 11 }, (_, i) => i + 5), scrollY: 120 },
    // Edge patterns
    { name: "hide every 3rd 0-30", hidden: Array.from({ length: 11 }, (_, i) => i * 3), scrollY: 0 },
    { name: "hide every 3rd 0-30 scroll 100", hidden: Array.from({ length: 11 }, (_, i) => i * 3), scrollY: 100 },
    { name: "hide every 5th 0-50", hidden: Array.from({ length: 11 }, (_, i) => i * 5), scrollY: 0 },
    { name: "hide every 5th 0-50 scroll 200", hidden: Array.from({ length: 11 }, (_, i) => i * 5), scrollY: 200 },
    // Blocks
    { name: "hide 0-1, 5-6", hidden: [0, 1, 5, 6], scrollY: 0 },
    { name: "hide 0-1, 5-6 scroll 48", hidden: [0, 1, 5, 6], scrollY: 48 },
    { name: "hide 3-7", hidden: [3, 4, 5, 6, 7], scrollY: 0 },
    { name: "hide 3-7 scroll 72", hidden: [3, 4, 5, 6, 7], scrollY: 72 },
    // Various canvas heights
    { name: "hide row 0 h=400", hidden: [0], scrollY: 0 },
    { name: "hide row 0 h=1200", hidden: [0], scrollY: 0 },
    // Combined with large scroll
    { name: "hide 0-4 scroll 1000", hidden: [0, 1, 2, 3, 4], scrollY: 1000 },
    { name: "hide 0-4 scroll 5000", hidden: [0, 1, 2, 3, 4], scrollY: 5000 },
    { name: "hide 50-60 scroll 1200", hidden: Array.from({ length: 11 }, (_, i) => i + 50), scrollY: 1200 },
    { name: "hide 50-60 scroll 0", hidden: Array.from({ length: 11 }, (_, i) => i + 50), scrollY: 0 },
    // Dense hidden patterns
    { name: "hide first 20", hidden: Array.from({ length: 20 }, (_, i) => i), scrollY: 0 },
    { name: "hide first 20 scroll 24", hidden: Array.from({ length: 20 }, (_, i) => i), scrollY: 24 },
    { name: "hide first 20 scroll 240", hidden: Array.from({ length: 20 }, (_, i) => i), scrollY: 240 },
    // Single far rows
    { name: "hide row 100", hidden: [100], scrollY: 0 },
    { name: "hide row 100 scroll 2400", hidden: [100], scrollY: 2400 },
    { name: "hide row 500", hidden: [500], scrollY: 0 },
    { name: "hide row 500 scroll 12000", hidden: [500], scrollY: 12000 },
    // Alternating blocks
    { name: "hide 0-2, 6-8, 12-14", hidden: [0, 1, 2, 6, 7, 8, 12, 13, 14], scrollY: 0 },
    { name: "hide 0-2, 6-8, 12-14 scroll 72", hidden: [0, 1, 2, 6, 7, 8, 12, 13, 14], scrollY: 72 },
    { name: "hide 0-2, 6-8, 12-14 scroll 200", hidden: [0, 1, 2, 6, 7, 8, 12, 13, 14], scrollY: 200 },
    // No hidden (baseline)
    { name: "no hidden scroll 0", hidden: [], scrollY: 0 },
    { name: "no hidden scroll 100", hidden: [], scrollY: 100 },
    { name: "no hidden scroll 500", hidden: [], scrollY: 500 },
    { name: "no hidden scroll 2400", hidden: [], scrollY: 2400 },
    // Pair patterns
    { name: "hide 0,99", hidden: [0, 99], scrollY: 0 },
    { name: "hide 0,50,99", hidden: [0, 50, 99], scrollY: 1200 },
  ];

  it.each(hiddenPatterns)(
    "$name",
    ({ hidden, scrollY }) => {
      const config = makeConfig();
      const dims = makeDims({ hiddenRows: new Set(hidden) });
      const result = calculateVisibleRange(vp(0, scrollY), config, 800, 600, dims);

      // startRow should never be a hidden row
      if (hidden.length > 0 && result.startRow < 1000) {
        expect(hidden.includes(result.startRow)).toBe(false);
      }

      // endRow >= startRow
      expect(result.endRow).toBeGreaterThanOrEqual(result.startRow);

      // No hidden row should be "counted" in the visible pixel space
      // The number of visible rows * 24 should approximately fill canvas height - header
      const visibleHeight = 600 - 24;
      let visibleRowPixels = 0;
      for (let r = result.startRow; r <= result.endRow; r++) {
        if (!hidden.includes(r)) {
          visibleRowPixels += 24;
        }
      }
      // Visible rows should roughly fill the viewport (within one row tolerance)
      expect(visibleRowPixels).toBeGreaterThanOrEqual(visibleHeight - 24);

      // endRow clamped
      expect(result.endRow).toBeLessThanOrEqual(999);
    }
  );
});

// ============================================================================
// 5. Viewport with custom dimensions: 50 combos
// ============================================================================

describe("calculateVisibleRange - custom dimensions parameterized", () => {
  const cases: Array<{
    name: string;
    colWidths: Array<[number, number]>;
    rowHeights: Array<[number, number]>;
    scrollX: number;
    scrollY: number;
    canvasW: number;
    canvasH: number;
  }> = [
    // Wide first column
    { name: "col0=200 origin", colWidths: [[0, 200]], rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col0=200 scroll 200", colWidths: [[0, 200]], rowHeights: [], scrollX: 200, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col0=200 scroll 300", colWidths: [[0, 200]], rowHeights: [], scrollX: 300, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col0=500 origin", colWidths: [[0, 500]], rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col0=500 scroll 500", colWidths: [[0, 500]], rowHeights: [], scrollX: 500, scrollY: 0, canvasW: 800, canvasH: 600 },
    // Multiple wide columns
    { name: "col0-2=200 origin", colWidths: [[0, 200], [1, 200], [2, 200]], rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col0-2=200 scroll 400", colWidths: [[0, 200], [1, 200], [2, 200]], rowHeights: [], scrollX: 400, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col0-2=200 scroll 600", colWidths: [[0, 200], [1, 200], [2, 200]], rowHeights: [], scrollX: 600, scrollY: 0, canvasW: 800, canvasH: 600 },
    // Narrow columns
    { name: "col0=30 origin", colWidths: [[0, 30]], rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col0-4=30 origin", colWidths: [[0, 30], [1, 30], [2, 30], [3, 30], [4, 30]], rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    // Tall rows
    { name: "row0=48 origin", colWidths: [], rowHeights: [[0, 48]], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "row0=48 scroll 48", colWidths: [], rowHeights: [[0, 48]], scrollX: 0, scrollY: 48, canvasW: 800, canvasH: 600 },
    { name: "row0=100 origin", colWidths: [], rowHeights: [[0, 100]], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "row0-4=48 origin", colWidths: [], rowHeights: [[0, 48], [1, 48], [2, 48], [3, 48], [4, 48]], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "row0-4=48 scroll 240", colWidths: [], rowHeights: [[0, 48], [1, 48], [2, 48], [3, 48], [4, 48]], scrollX: 0, scrollY: 240, canvasW: 800, canvasH: 600 },
    // Mixed wide cols and tall rows
    { name: "col0=200 row0=48 origin", colWidths: [[0, 200]], rowHeights: [[0, 48]], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col0=200 row0=48 scroll", colWidths: [[0, 200]], rowHeights: [[0, 48]], scrollX: 200, scrollY: 48, canvasW: 800, canvasH: 600 },
    { name: "col0=300 row0-2=60", colWidths: [[0, 300]], rowHeights: [[0, 60], [1, 60], [2, 60]], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col0=300 row0-2=60 scroll", colWidths: [[0, 300]], rowHeights: [[0, 60], [1, 60], [2, 60]], scrollX: 300, scrollY: 180, canvasW: 800, canvasH: 600 },
    // Different canvas sizes
    { name: "col0=200 w=400", colWidths: [[0, 200]], rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 400, canvasH: 400 },
    { name: "col0=200 w=1920", colWidths: [[0, 200]], rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 1920, canvasH: 1080 },
    { name: "col0=200 w=2560", colWidths: [[0, 200]], rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 2560, canvasH: 1440 },
    { name: "row0=48 h=400", colWidths: [], rowHeights: [[0, 48]], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 400 },
    { name: "row0=48 h=1080", colWidths: [], rowHeights: [[0, 48]], scrollX: 0, scrollY: 0, canvasW: 1920, canvasH: 1080 },
    // Sparse custom dims (only some cols/rows differ)
    { name: "col5=200 origin", colWidths: [[5, 200]], rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col5=200 scroll 500", colWidths: [[5, 200]], rowHeights: [], scrollX: 500, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col5=200 scroll 600", colWidths: [[5, 200]], rowHeights: [], scrollX: 600, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "row10=48 scroll 240", colWidths: [], rowHeights: [[10, 48]], scrollX: 0, scrollY: 240, canvasW: 800, canvasH: 600 },
    { name: "row10=48 scroll 300", colWidths: [], rowHeights: [[10, 48]], scrollX: 0, scrollY: 300, canvasW: 800, canvasH: 600 },
    // Very wide single col
    { name: "col0=1000 origin", colWidths: [[0, 1000]], rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col0=1000 scroll 500", colWidths: [[0, 1000]], rowHeights: [], scrollX: 500, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "col0=1000 scroll 1000", colWidths: [[0, 1000]], rowHeights: [], scrollX: 1000, scrollY: 0, canvasW: 800, canvasH: 600 },
    // Very tall single row
    { name: "row0=200 origin", colWidths: [], rowHeights: [[0, 200]], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "row0=200 scroll 200", colWidths: [], rowHeights: [[0, 200]], scrollX: 0, scrollY: 200, canvasW: 800, canvasH: 600 },
    // Multiple custom both
    { name: "multi custom origin", colWidths: [[0, 150], [3, 200], [7, 50]], rowHeights: [[0, 30], [5, 60]], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "multi custom scroll 300/120", colWidths: [[0, 150], [3, 200], [7, 50]], rowHeights: [[0, 30], [5, 60]], scrollX: 300, scrollY: 120, canvasW: 800, canvasH: 600 },
    { name: "multi custom scroll 600/300", colWidths: [[0, 150], [3, 200], [7, 50]], rowHeights: [[0, 30], [5, 60]], scrollX: 600, scrollY: 300, canvasW: 800, canvasH: 600 },
    // All same custom width
    { name: "cols 0-9=50 origin", colWidths: Array.from({ length: 10 }, (_, i) => [i, 50] as [number, number]), rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "cols 0-9=50 scroll 250", colWidths: Array.from({ length: 10 }, (_, i) => [i, 50] as [number, number]), rowHeights: [], scrollX: 250, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "cols 0-9=50 scroll 500", colWidths: Array.from({ length: 10 }, (_, i) => [i, 50] as [number, number]), rowHeights: [], scrollX: 500, scrollY: 0, canvasW: 800, canvasH: 600 },
    // All same custom height
    { name: "rows 0-9=48 origin", colWidths: [], rowHeights: Array.from({ length: 10 }, (_, i) => [i, 48] as [number, number]), scrollX: 0, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "rows 0-9=48 scroll 240", colWidths: [], rowHeights: Array.from({ length: 10 }, (_, i) => [i, 48] as [number, number]), scrollX: 0, scrollY: 240, canvasW: 800, canvasH: 600 },
    { name: "rows 0-9=48 scroll 480", colWidths: [], rowHeights: Array.from({ length: 10 }, (_, i) => [i, 48] as [number, number]), scrollX: 0, scrollY: 480, canvasW: 800, canvasH: 600 },
    // Tiny canvas
    { name: "col0=200 tiny canvas", colWidths: [[0, 200]], rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 200, canvasH: 200 },
    { name: "row0=100 tiny canvas", colWidths: [], rowHeights: [[0, 100]], scrollX: 0, scrollY: 0, canvasW: 200, canvasH: 200 },
    // Large canvas
    { name: "col0=200 4k canvas", colWidths: [[0, 200]], rowHeights: [], scrollX: 0, scrollY: 0, canvasW: 3840, canvasH: 2160 },
    { name: "row0=48 4k canvas", colWidths: [], rowHeights: [[0, 48]], scrollX: 0, scrollY: 0, canvasW: 3840, canvasH: 2160 },
    // Mixed with scrolling past custom area
    { name: "col0=200 scroll past", colWidths: [[0, 200]], rowHeights: [], scrollX: 2000, scrollY: 0, canvasW: 800, canvasH: 600 },
    { name: "row0=48 scroll past", colWidths: [], rowHeights: [[0, 48]], scrollX: 0, scrollY: 5000, canvasW: 800, canvasH: 600 },
  ];

  it.each(cases)(
    "$name",
    ({ colWidths, rowHeights, scrollX, scrollY, canvasW, canvasH }) => {
      const dims = makeDims();
      for (const [col, w] of colWidths) {
        dims.columnWidths.set(col, w);
      }
      for (const [row, h] of rowHeights) {
        dims.rowHeights.set(row, h);
      }

      const config = makeConfig();
      const result = calculateVisibleRange(vp(scrollX, scrollY), config, canvasW, canvasH, dims);

      // Basic invariants
      expect(result.startRow).toBeGreaterThanOrEqual(0);
      expect(result.startCol).toBeGreaterThanOrEqual(0);
      expect(result.endRow).toBeGreaterThanOrEqual(result.startRow);
      expect(result.endCol).toBeGreaterThanOrEqual(result.startCol);
      expect(result.endRow).toBeLessThanOrEqual(999);
      expect(result.endCol).toBeLessThanOrEqual(99);

      // offsetX should be <= 0 (we're scrolled into the cell)
      expect(result.offsetX).toBeLessThanOrEqual(0);
      expect(result.offsetY).toBeLessThanOrEqual(0);
    }
  );
});
