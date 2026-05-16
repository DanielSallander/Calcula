//! FILENAME: app/src/core/lib/__tests__/cellToScroll-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for scroll utility functions
// TARGET: 230+ tests via it.each

import { describe, it, expect } from "vitest";
import {
  cellToScroll,
  cellToCenteredScroll,
  scrollToMakeVisible,
  thumbPositionToScroll,
  getColumnXPosition,
  getRowYPosition,
  SCROLLBAR_WIDTH,
  SCROLLBAR_HEIGHT,
} from "../scrollUtils";
import type { GridConfig, Viewport, DimensionOverrides } from "../../types";
import { createEmptyDimensionOverrides } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides?: Partial<GridConfig>): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 24,
    rowHeaderWidth: 50,
    colHeaderHeight: 24,
    totalRows: 1000000,
    totalCols: 16384,
    minColumnWidth: 20,
    minRowHeight: 10,
    outlineBarWidth: 0,
    outlineBarHeight: 0,
    ...overrides,
  } as GridConfig;
}

function makeDims(): DimensionOverrides {
  return createEmptyDimensionOverrides();
}

// ============================================================================
// 1. cellToScroll: 100 cell combos
// ============================================================================

describe("cellToScroll - parameterized", () => {
  // Default dimensions: cellWidth=100, cellHeight=24
  const defaultCases: Array<{
    row: number;
    col: number;
    expectedX: number;
    expectedY: number;
  }> = [
    // Origin
    { row: 0, col: 0, expectedX: 0, expectedY: 0 },
    { row: 0, col: 1, expectedX: 100, expectedY: 0 },
    { row: 1, col: 0, expectedX: 0, expectedY: 24 },
    { row: 1, col: 1, expectedX: 100, expectedY: 24 },
    // Small indices
    { row: 0, col: 5, expectedX: 500, expectedY: 0 },
    { row: 5, col: 0, expectedX: 0, expectedY: 120 },
    { row: 5, col: 5, expectedX: 500, expectedY: 120 },
    { row: 10, col: 10, expectedX: 1000, expectedY: 240 },
    { row: 0, col: 25, expectedX: 2500, expectedY: 0 },
    { row: 25, col: 0, expectedX: 0, expectedY: 600 },
    // Medium indices
    { row: 50, col: 50, expectedX: 5000, expectedY: 1200 },
    { row: 100, col: 0, expectedX: 0, expectedY: 2400 },
    { row: 0, col: 100, expectedX: 10000, expectedY: 0 },
    { row: 100, col: 100, expectedX: 10000, expectedY: 2400 },
    { row: 200, col: 50, expectedX: 5000, expectedY: 4800 },
    { row: 500, col: 25, expectedX: 2500, expectedY: 12000 },
    { row: 999, col: 99, expectedX: 9900, expectedY: 23976 },
    // Large row indices
    { row: 1000, col: 0, expectedX: 0, expectedY: 24000 },
    { row: 5000, col: 0, expectedX: 0, expectedY: 120000 },
    { row: 10000, col: 0, expectedX: 0, expectedY: 240000 },
    { row: 50000, col: 0, expectedX: 0, expectedY: 1200000 },
    { row: 100000, col: 0, expectedX: 0, expectedY: 2400000 },
    { row: 500000, col: 0, expectedX: 0, expectedY: 12000000 },
    { row: 999999, col: 0, expectedX: 0, expectedY: 23999976 },
    // Large col indices
    { row: 0, col: 1000, expectedX: 100000, expectedY: 0 },
    { row: 0, col: 5000, expectedX: 500000, expectedY: 0 },
    { row: 0, col: 10000, expectedX: 1000000, expectedY: 0 },
    { row: 0, col: 16383, expectedX: 1638300, expectedY: 0 },
    // Combined large
    { row: 999999, col: 16383, expectedX: 1638300, expectedY: 23999976 },
    { row: 500000, col: 8000, expectedX: 800000, expectedY: 12000000 },
    // Various combos
    { row: 3, col: 7, expectedX: 700, expectedY: 72 },
    { row: 7, col: 3, expectedX: 300, expectedY: 168 },
    { row: 15, col: 15, expectedX: 1500, expectedY: 360 },
    { row: 30, col: 20, expectedX: 2000, expectedY: 720 },
    { row: 42, col: 42, expectedX: 4200, expectedY: 1008 },
    { row: 99, col: 1, expectedX: 100, expectedY: 2376 },
    { row: 1, col: 99, expectedX: 9900, expectedY: 24 },
    { row: 255, col: 255, expectedX: 25500, expectedY: 6120 },
    { row: 1024, col: 256, expectedX: 25600, expectedY: 24576 },
    { row: 65535, col: 255, expectedX: 25500, expectedY: 1572840 },
  ];

  it.each(defaultCases)(
    "row=$row col=$col => scrollX=$expectedX scrollY=$expectedY",
    ({ row, col, expectedX, expectedY }) => {
      const result = cellToScroll(row, col, makeConfig());
      expect(result.scrollX).toBe(expectedX);
      expect(result.scrollY).toBe(expectedY);
    }
  );

  // Custom dimension cases
  const customDimCases: Array<{
    name: string;
    row: number;
    col: number;
    colWidths: Array<[number, number]>;
    rowHeights: Array<[number, number]>;
  }> = [
    { name: "wide col0 target col1", row: 0, col: 1, colWidths: [[0, 200]], rowHeights: [] },
    { name: "wide col0 target col2", row: 0, col: 2, colWidths: [[0, 200]], rowHeights: [] },
    { name: "wide col0,1 target col2", row: 0, col: 2, colWidths: [[0, 200], [1, 200]], rowHeights: [] },
    { name: "tall row0 target row1", row: 1, col: 0, colWidths: [], rowHeights: [[0, 48]] },
    { name: "tall row0 target row2", row: 2, col: 0, colWidths: [], rowHeights: [[0, 48]] },
    { name: "tall row0,1 target row2", row: 2, col: 0, colWidths: [], rowHeights: [[0, 48], [1, 48]] },
    { name: "wide+tall target 1,1", row: 1, col: 1, colWidths: [[0, 200]], rowHeights: [[0, 48]] },
    { name: "narrow col0 target col1", row: 0, col: 1, colWidths: [[0, 30]], rowHeights: [] },
    { name: "narrow col0 target col5", row: 0, col: 5, colWidths: [[0, 30]], rowHeights: [] },
    { name: "short row0 target row1", row: 1, col: 0, colWidths: [], rowHeights: [[0, 12]] },
    { name: "custom col5 target col10", row: 0, col: 10, colWidths: [[5, 200]], rowHeights: [] },
    { name: "custom row10 target row20", row: 20, col: 0, colWidths: [], rowHeights: [[10, 48]] },
    { name: "many wide cols target col10", row: 0, col: 10, colWidths: Array.from({ length: 5 }, (_, i) => [i, 200] as [number, number]), rowHeights: [] },
    { name: "many tall rows target row10", row: 10, col: 0, colWidths: [], rowHeights: Array.from({ length: 5 }, (_, i) => [i, 48] as [number, number]) },
    { name: "mixed target 5,5", row: 5, col: 5, colWidths: [[0, 200], [2, 50]], rowHeights: [[0, 48], [3, 60]] },
  ];

  it.each(customDimCases)(
    "custom: $name",
    ({ row, col, colWidths, rowHeights }) => {
      const config = makeConfig();
      const dims = makeDims();
      for (const [c, w] of colWidths) dims.columnWidths.set(c, w);
      for (const [r, h] of rowHeights) dims.rowHeights.set(r, h);

      const result = cellToScroll(row, col, config, dims);

      // Verify against direct position calculation
      expect(result.scrollX).toBe(getColumnXPosition(col, config, dims));
      expect(result.scrollY).toBe(getRowYPosition(row, config, dims));
    }
  );

  // Hidden dimension cases
  const hiddenCases: Array<{
    name: string;
    row: number;
    col: number;
    hiddenCols: number[];
    hiddenRows: number[];
  }> = [
    { name: "hidden col0 target col1", row: 0, col: 1, hiddenCols: [0], hiddenRows: [] },
    { name: "hidden col0 target col5", row: 0, col: 5, hiddenCols: [0], hiddenRows: [] },
    { name: "hidden col0-2 target col3", row: 0, col: 3, hiddenCols: [0, 1, 2], hiddenRows: [] },
    { name: "hidden row0 target row1", row: 1, col: 0, hiddenCols: [], hiddenRows: [0] },
    { name: "hidden row0 target row5", row: 5, col: 0, hiddenCols: [], hiddenRows: [0] },
    { name: "hidden row0-4 target row5", row: 5, col: 0, hiddenCols: [], hiddenRows: [0, 1, 2, 3, 4] },
    { name: "hidden col0+row0 target 1,1", row: 1, col: 1, hiddenCols: [0], hiddenRows: [0] },
    { name: "hidden col2 target col5", row: 0, col: 5, hiddenCols: [2], hiddenRows: [] },
    { name: "hidden row5 target row10", row: 10, col: 0, hiddenCols: [], hiddenRows: [5] },
    { name: "hidden even cols target col10", row: 0, col: 10, hiddenCols: [0, 2, 4, 6, 8], hiddenRows: [] },
    { name: "hidden even rows target row10", row: 10, col: 0, hiddenCols: [], hiddenRows: [0, 2, 4, 6, 8] },
    { name: "hidden scattered target 20,20", row: 20, col: 20, hiddenCols: [3, 7, 15], hiddenRows: [2, 8, 12] },
    { name: "hidden col0 target col0", row: 0, col: 0, hiddenCols: [0], hiddenRows: [] },
    { name: "hidden row0 target row0", row: 0, col: 0, hiddenCols: [], hiddenRows: [0] },
    { name: "many hidden target far", row: 100, col: 50, hiddenCols: [1, 3, 5, 7, 9], hiddenRows: [2, 4, 6, 8, 10] },
  ];

  it.each(hiddenCases)(
    "hidden: $name",
    ({ row, col, hiddenCols, hiddenRows }) => {
      const config = makeConfig();
      const dims = makeDims();
      dims.hiddenCols = new Set(hiddenCols);
      dims.hiddenRows = new Set(hiddenRows);

      const result = cellToScroll(row, col, config, dims);

      // Verify against direct position calculation
      expect(result.scrollX).toBe(getColumnXPosition(col, config, dims));
      expect(result.scrollY).toBe(getRowYPosition(row, config, dims));

      // If target col has hidden cols before it, scrollX should be less than col*100
      const hiddenBefore = hiddenCols.filter(c => c < col).length;
      if (hiddenBefore > 0) {
        expect(result.scrollX).toBeLessThan(col * 100);
      }
      const hiddenRowsBefore = hiddenRows.filter(r => r < row).length;
      if (hiddenRowsBefore > 0) {
        expect(result.scrollY).toBeLessThan(row * 24);
      }
    }
  );
});

// ============================================================================
// 2. cellToCenteredScroll: 50 combos
// ============================================================================

describe("cellToCenteredScroll - parameterized", () => {
  const cases: Array<{
    row: number;
    col: number;
    vpW: number;
    vpH: number;
    cellW?: number;
    cellH?: number;
  }> = [
    // Standard viewport
    { row: 0, col: 0, vpW: 800, vpH: 600 },
    { row: 0, col: 5, vpW: 800, vpH: 600 },
    { row: 5, col: 0, vpW: 800, vpH: 600 },
    { row: 5, col: 5, vpW: 800, vpH: 600 },
    { row: 10, col: 10, vpW: 800, vpH: 600 },
    { row: 50, col: 50, vpW: 800, vpH: 600 },
    { row: 100, col: 50, vpW: 800, vpH: 600 },
    { row: 500, col: 25, vpW: 800, vpH: 600 },
    { row: 999, col: 99, vpW: 800, vpH: 600 },
    { row: 0, col: 0, vpW: 1920, vpH: 1080 },
    // HD viewport
    { row: 10, col: 10, vpW: 1920, vpH: 1080 },
    { row: 50, col: 50, vpW: 1920, vpH: 1080 },
    { row: 100, col: 100, vpW: 1920, vpH: 1080 },
    { row: 500, col: 200, vpW: 1920, vpH: 1080 },
    { row: 1000, col: 100, vpW: 1920, vpH: 1080 },
    // 4K viewport
    { row: 0, col: 0, vpW: 3840, vpH: 2160 },
    { row: 50, col: 50, vpW: 3840, vpH: 2160 },
    { row: 500, col: 500, vpW: 3840, vpH: 2160 },
    // Small viewport
    { row: 0, col: 0, vpW: 400, vpH: 300 },
    { row: 10, col: 5, vpW: 400, vpH: 300 },
    { row: 50, col: 25, vpW: 400, vpH: 300 },
    // Very small viewport
    { row: 0, col: 0, vpW: 200, vpH: 200 },
    { row: 5, col: 3, vpW: 200, vpH: 200 },
    // Large cell indices
    { row: 10000, col: 1000, vpW: 800, vpH: 600 },
    { row: 100000, col: 5000, vpW: 800, vpH: 600 },
    { row: 999999, col: 16383, vpW: 800, vpH: 600 },
    // With custom cell sizes
    { row: 5, col: 5, vpW: 800, vpH: 600, cellW: 200, cellH: 48 },
    { row: 10, col: 10, vpW: 800, vpH: 600, cellW: 200, cellH: 48 },
    { row: 0, col: 0, vpW: 800, vpH: 600, cellW: 50, cellH: 12 },
    { row: 50, col: 50, vpW: 800, vpH: 600, cellW: 50, cellH: 12 },
    { row: 0, col: 0, vpW: 1920, vpH: 1080, cellW: 150, cellH: 30 },
    { row: 100, col: 50, vpW: 1920, vpH: 1080, cellW: 150, cellH: 30 },
    // Edge: row/col 0 various viewports
    { row: 0, col: 0, vpW: 300, vpH: 200 },
    { row: 0, col: 0, vpW: 500, vpH: 400 },
    { row: 0, col: 0, vpW: 1000, vpH: 800 },
    { row: 0, col: 0, vpW: 2000, vpH: 1500 },
    // Mid-range
    { row: 25, col: 12, vpW: 800, vpH: 600 },
    { row: 75, col: 37, vpW: 800, vpH: 600 },
    { row: 150, col: 75, vpW: 1200, vpH: 900 },
    { row: 300, col: 150, vpW: 1200, vpH: 900 },
    // Various aspect ratios
    { row: 10, col: 10, vpW: 1600, vpH: 400 },
    { row: 10, col: 10, vpW: 400, vpH: 1600 },
    { row: 50, col: 50, vpW: 1600, vpH: 400 },
    { row: 50, col: 50, vpW: 400, vpH: 1600 },
    // Near boundaries
    { row: 999998, col: 16382, vpW: 800, vpH: 600 },
    { row: 1, col: 1, vpW: 800, vpH: 600 },
    { row: 2, col: 2, vpW: 800, vpH: 600 },
    { row: 3, col: 3, vpW: 800, vpH: 600 },
    { row: 999, col: 999, vpW: 800, vpH: 600 },
    { row: 9999, col: 9999, vpW: 800, vpH: 600 },
  ];

  it.each(cases)(
    "row=$row col=$col vpW=$vpW vpH=$vpH",
    ({ row, col, vpW, vpH, cellW, cellH }) => {
      const config = makeConfig({
        defaultCellWidth: cellW ?? 100,
        defaultCellHeight: cellH ?? 24,
      });

      const result = cellToCenteredScroll(row, col, config, vpW, vpH);

      // Calculate expected centered position
      const cw = cellW ?? 100;
      const ch = cellH ?? 24;
      const cellX = col * cw;
      const cellY = row * ch;
      const availW = vpW - 50 - SCROLLBAR_WIDTH;
      const availH = vpH - 24 - SCROLLBAR_HEIGHT;
      const expectedX = cellX - availW / 2 + cw / 2;
      const expectedY = cellY - availH / 2 + ch / 2;

      expect(result.scrollX).toBeCloseTo(expectedX, 5);
      expect(result.scrollY).toBeCloseTo(expectedY, 5);
    }
  );
});

// ============================================================================
// 3. scrollToMakeVisible: 50 combos
// ============================================================================

describe("scrollToMakeVisible - parameterized", () => {
  const config = makeConfig({ totalRows: 1000, totalCols: 100 });
  const vpW = 800;
  const vpH = 600;
  const availW = vpW - 50 - SCROLLBAR_WIDTH; // 733
  const availH = vpH - 24 - SCROLLBAR_HEIGHT; // 559

  const cases: Array<{
    name: string;
    row: number;
    col: number;
    scrollX: number;
    scrollY: number;
    expectNull: boolean;
    expectDir?: string;
  }> = [
    // Already visible - should return null
    { name: "origin visible at origin", row: 0, col: 0, scrollX: 0, scrollY: 0, expectNull: true },
    { name: "row1 col1 visible at origin", row: 1, col: 1, scrollX: 0, scrollY: 0, expectNull: true },
    { name: "row5 col3 visible at origin", row: 5, col: 3, scrollX: 0, scrollY: 0, expectNull: true },
    { name: "row10 col5 visible", row: 10, col: 5, scrollX: 0, scrollY: 0, expectNull: true },
    { name: "last visible row at origin", row: 22, col: 0, scrollX: 0, scrollY: 0, expectNull: true },
    { name: "last visible col at origin", row: 0, col: 6, scrollX: 0, scrollY: 0, expectNull: true },
    { name: "mid-visible cell", row: 12, col: 4, scrollX: 0, scrollY: 0, expectNull: true },
    { name: "cell visible with scroll", row: 15, col: 5, scrollX: 300, scrollY: 200, expectNull: true },
    { name: "cell visible with scroll 2", row: 20, col: 8, scrollX: 500, scrollY: 300, expectNull: true },
    { name: "cell visible edge", row: 10, col: 3, scrollX: 100, scrollY: 100, expectNull: true },
    // Need scroll down
    { name: "scroll down for row 30", row: 30, col: 0, scrollX: 0, scrollY: 0, expectNull: false, expectDir: "down" },
    { name: "scroll down for row 50", row: 50, col: 0, scrollX: 0, scrollY: 0, expectNull: false, expectDir: "down" },
    { name: "scroll down for row 100", row: 100, col: 0, scrollX: 0, scrollY: 0, expectNull: false, expectDir: "down" },
    { name: "scroll down for row 500", row: 500, col: 0, scrollX: 0, scrollY: 0, expectNull: false, expectDir: "down" },
    { name: "scroll down for row 999", row: 999, col: 0, scrollX: 0, scrollY: 0, expectNull: false, expectDir: "down" },
    { name: "scroll down slightly", row: 25, col: 0, scrollX: 0, scrollY: 0, expectNull: false, expectDir: "down" },
    // Need scroll up
    { name: "scroll up for row 0 from scroll", row: 0, col: 0, scrollX: 0, scrollY: 500, expectNull: false, expectDir: "up" },
    { name: "scroll up for row 5 from scroll", row: 5, col: 0, scrollX: 0, scrollY: 500, expectNull: false, expectDir: "up" },
    { name: "scroll up for row 10 from 1000", row: 10, col: 0, scrollX: 0, scrollY: 1000, expectNull: false, expectDir: "up" },
    { name: "scroll up for row 0 from 2400", row: 0, col: 0, scrollX: 0, scrollY: 2400, expectNull: false, expectDir: "up" },
    { name: "scroll up slightly", row: 20, col: 0, scrollX: 0, scrollY: 600, expectNull: false, expectDir: "up" },
    // Need scroll right
    { name: "scroll right for col 10", row: 0, col: 10, scrollX: 0, scrollY: 0, expectNull: false, expectDir: "right" },
    { name: "scroll right for col 20", row: 0, col: 20, scrollX: 0, scrollY: 0, expectNull: false, expectDir: "right" },
    { name: "scroll right for col 50", row: 0, col: 50, scrollX: 0, scrollY: 0, expectNull: false, expectDir: "right" },
    { name: "scroll right for col 99", row: 0, col: 99, scrollX: 0, scrollY: 0, expectNull: false, expectDir: "right" },
    { name: "scroll right slightly", row: 0, col: 8, scrollX: 0, scrollY: 0, expectNull: false, expectDir: "right" },
    // Need scroll left
    { name: "scroll left for col 0 from scroll", row: 0, col: 0, scrollX: 500, scrollY: 0, expectNull: false, expectDir: "left" },
    { name: "scroll left for col 2 from scroll", row: 0, col: 2, scrollX: 500, scrollY: 0, expectNull: false, expectDir: "left" },
    { name: "scroll left for col 0 from 2000", row: 0, col: 0, scrollX: 2000, scrollY: 0, expectNull: false, expectDir: "left" },
    { name: "scroll left for col 5 from 1000", row: 0, col: 5, scrollX: 1000, scrollY: 0, expectNull: false, expectDir: "left" },
    { name: "scroll left slightly", row: 0, col: 4, scrollX: 600, scrollY: 0, expectNull: false, expectDir: "left" },
    // Diagonal scrolling needed
    { name: "scroll down-right", row: 50, col: 20, scrollX: 0, scrollY: 0, expectNull: false },
    { name: "scroll up-left", row: 0, col: 0, scrollX: 1000, scrollY: 1000, expectNull: false },
    { name: "scroll down-left", row: 50, col: 0, scrollX: 500, scrollY: 0, expectNull: false },
    { name: "scroll up-right", row: 0, col: 20, scrollX: 0, scrollY: 500, expectNull: false },
    // Edge cells
    { name: "last row", row: 999, col: 0, scrollX: 0, scrollY: 0, expectNull: false },
    { name: "last col", row: 0, col: 99, scrollX: 0, scrollY: 0, expectNull: false },
    { name: "last cell", row: 999, col: 99, scrollX: 0, scrollY: 0, expectNull: false },
    // Boundary cases with scroll
    { name: "row at bottom edge", row: 24, col: 0, scrollX: 0, scrollY: 0, expectNull: false },
    { name: "col at right edge", row: 0, col: 8, scrollX: 0, scrollY: 0, expectNull: false },
    // Custom dims - need separate verification
    { name: "wide col visible", row: 0, col: 3, scrollX: 0, scrollY: 0, expectNull: true },
    { name: "tall row visible", row: 3, col: 0, scrollX: 0, scrollY: 0, expectNull: true },
    { name: "far cell scroll needed", row: 200, col: 50, scrollX: 100, scrollY: 100, expectNull: false },
    { name: "medium cell scroll needed", row: 30, col: 15, scrollX: 200, scrollY: 100, expectNull: false },
    { name: "visible after partial scroll", row: 15, col: 7, scrollX: 200, scrollY: 200, expectNull: true },
    { name: "just barely needs scroll down", row: 24, col: 0, scrollX: 0, scrollY: 1, expectNull: false },
    { name: "cell visible mid scroll", row: 25, col: 5, scrollX: 200, scrollY: 400, expectNull: true },
    { name: "cell below at large scroll", row: 900, col: 50, scrollX: 2000, scrollY: 10000, expectNull: false },
    { name: "cell above at large scroll", row: 100, col: 10, scrollX: 500, scrollY: 5000, expectNull: false, expectDir: "up" },
    { name: "cell left at large scroll", row: 50, col: 5, scrollX: 3000, scrollY: 1000, expectNull: false, expectDir: "left" },
  ];

  it.each(cases)(
    "$name",
    ({ row, col, scrollX, scrollY, expectNull, expectDir }) => {
      const viewport = { scrollX, scrollY } as Viewport;
      const result = scrollToMakeVisible(row, col, viewport, config, vpW, vpH);

      if (expectNull) {
        expect(result).toBeNull();
      } else {
        expect(result).not.toBeNull();

        // Verify direction if specified
        if (expectDir === "down") {
          expect(result!.scrollY).toBeGreaterThan(scrollY);
        } else if (expectDir === "up") {
          expect(result!.scrollY).toBeLessThan(scrollY);
        } else if (expectDir === "right") {
          expect(result!.scrollX).toBeGreaterThan(scrollX);
        } else if (expectDir === "left") {
          expect(result!.scrollX).toBeLessThan(scrollX);
        }

        // Scroll values should be non-negative
        expect(result!.scrollX).toBeGreaterThanOrEqual(0);
        expect(result!.scrollY).toBeGreaterThanOrEqual(0);
      }
    }
  );
});

// ============================================================================
// 4. thumbPositionToScroll: 30 combos
// ============================================================================

describe("thumbPositionToScroll - parameterized", () => {
  const cases: Array<{
    name: string;
    thumbPos: number;
    thumbSize: number;
    trackSize: number;
    contentSize: number;
    viewportSize: number;
    expected: number;
  }> = [
    // Basic cases
    { name: "thumb at start", thumbPos: 0, thumbSize: 50, trackSize: 500, contentSize: 5000, viewportSize: 500, expected: 0 },
    { name: "thumb at end", thumbPos: 450, thumbSize: 50, trackSize: 500, contentSize: 5000, viewportSize: 500, expected: 4500 },
    { name: "thumb at middle", thumbPos: 225, thumbSize: 50, trackSize: 500, contentSize: 5000, viewportSize: 500, expected: 2250 },
    // Different thumb sizes
    { name: "large thumb at start", thumbPos: 0, thumbSize: 200, trackSize: 500, contentSize: 2000, viewportSize: 500, expected: 0 },
    { name: "large thumb at end", thumbPos: 300, thumbSize: 200, trackSize: 500, contentSize: 2000, viewportSize: 500, expected: 1500 },
    { name: "large thumb at mid", thumbPos: 150, thumbSize: 200, trackSize: 500, contentSize: 2000, viewportSize: 500, expected: 750 },
    { name: "tiny thumb at start", thumbPos: 0, thumbSize: 30, trackSize: 500, contentSize: 50000, viewportSize: 500, expected: 0 },
    { name: "tiny thumb at end", thumbPos: 470, thumbSize: 30, trackSize: 500, contentSize: 50000, viewportSize: 500, expected: 49500 },
    { name: "tiny thumb at quarter", thumbPos: 117.5, thumbSize: 30, trackSize: 500, contentSize: 50000, viewportSize: 500, expected: 12375 },
    // Edge cases
    { name: "thumb fills track", thumbPos: 0, thumbSize: 500, trackSize: 500, contentSize: 500, viewportSize: 500, expected: 0 },
    { name: "content equals viewport", thumbPos: 100, thumbSize: 500, trackSize: 500, contentSize: 500, viewportSize: 500, expected: 0 },
    { name: "content smaller than viewport", thumbPos: 50, thumbSize: 500, trackSize: 500, contentSize: 300, viewportSize: 500, expected: 0 },
    { name: "zero track size", thumbPos: 0, thumbSize: 0, trackSize: 0, contentSize: 1000, viewportSize: 500, expected: 0 },
    // Different track sizes
    { name: "small track start", thumbPos: 0, thumbSize: 30, trackSize: 200, contentSize: 10000, viewportSize: 200, expected: 0 },
    { name: "small track end", thumbPos: 170, thumbSize: 30, trackSize: 200, contentSize: 10000, viewportSize: 200, expected: 9800 },
    { name: "small track mid", thumbPos: 85, thumbSize: 30, trackSize: 200, contentSize: 10000, viewportSize: 200, expected: 4900 },
    { name: "large track start", thumbPos: 0, thumbSize: 100, trackSize: 1000, contentSize: 10000, viewportSize: 1000, expected: 0 },
    { name: "large track end", thumbPos: 900, thumbSize: 100, trackSize: 1000, contentSize: 10000, viewportSize: 1000, expected: 9000 },
    { name: "large track mid", thumbPos: 450, thumbSize: 100, trackSize: 1000, contentSize: 10000, viewportSize: 1000, expected: 4500 },
    // Proportional verification
    { name: "10% position", thumbPos: 45, thumbSize: 50, trackSize: 500, contentSize: 5000, viewportSize: 500, expected: 450 },
    { name: "25% position", thumbPos: 112.5, thumbSize: 50, trackSize: 500, contentSize: 5000, viewportSize: 500, expected: 1125 },
    { name: "75% position", thumbPos: 337.5, thumbSize: 50, trackSize: 500, contentSize: 5000, viewportSize: 500, expected: 3375 },
    { name: "90% position", thumbPos: 405, thumbSize: 50, trackSize: 500, contentSize: 5000, viewportSize: 500, expected: 4050 },
    // Realistic scrollbar dimensions
    { name: "vertical 1M rows start", thumbPos: 0, thumbSize: 30, trackSize: 559, contentSize: 24000000, viewportSize: 559, expected: 0 },
    { name: "vertical 1M rows end", thumbPos: 529, thumbSize: 30, trackSize: 559, contentSize: 24000000, viewportSize: 559, expected: 23999441 },
    { name: "vertical 1M rows 50%", thumbPos: 264.5, thumbSize: 30, trackSize: 559, contentSize: 24000000, viewportSize: 559, expected: 11999720.5 },
    { name: "horizontal 16K cols start", thumbPos: 0, thumbSize: 30, trackSize: 733, contentSize: 1638400, viewportSize: 733, expected: 0 },
    { name: "horizontal 16K cols end", thumbPos: 703, thumbSize: 30, trackSize: 733, contentSize: 1638400, viewportSize: 733, expected: 1637667 },
    { name: "horizontal 16K cols 50%", thumbPos: 351.5, thumbSize: 30, trackSize: 733, contentSize: 1638400, viewportSize: 733, expected: 818833.5 },
  ];

  it.each(cases)(
    "$name",
    ({ thumbPos, thumbSize, trackSize, contentSize, viewportSize, expected }) => {
      const result = thumbPositionToScroll(thumbPos, thumbSize, trackSize, contentSize, viewportSize);
      expect(result).toBeCloseTo(expected, 0);
    }
  );
});

// ============================================================================
// 5. Additional cellToScroll with various config sizes: 20 combos
// ============================================================================

describe("cellToScroll - various default dimensions", () => {
  const configCases: Array<{
    name: string;
    row: number;
    col: number;
    cellW: number;
    cellH: number;
  }> = [
    { name: "narrow cells r0c0", row: 0, col: 0, cellW: 50, cellH: 16 },
    { name: "narrow cells r10c10", row: 10, col: 10, cellW: 50, cellH: 16 },
    { name: "narrow cells r100c50", row: 100, col: 50, cellW: 50, cellH: 16 },
    { name: "narrow cells r1000c100", row: 1000, col: 100, cellW: 50, cellH: 16 },
    { name: "wide cells r0c0", row: 0, col: 0, cellW: 200, cellH: 40 },
    { name: "wide cells r5c5", row: 5, col: 5, cellW: 200, cellH: 40 },
    { name: "wide cells r50c25", row: 50, col: 25, cellW: 200, cellH: 40 },
    { name: "wide cells r500c100", row: 500, col: 100, cellW: 200, cellH: 40 },
    { name: "square cells r0c0", row: 0, col: 0, cellW: 100, cellH: 100 },
    { name: "square cells r10c10", row: 10, col: 10, cellW: 100, cellH: 100 },
    { name: "square cells r100c100", row: 100, col: 100, cellW: 100, cellH: 100 },
    { name: "tiny cells r0c0", row: 0, col: 0, cellW: 20, cellH: 10 },
    { name: "tiny cells r100c100", row: 100, col: 100, cellW: 20, cellH: 10 },
    { name: "tiny cells r10000c1000", row: 10000, col: 1000, cellW: 20, cellH: 10 },
    { name: "large cells r0c0", row: 0, col: 0, cellW: 300, cellH: 60 },
    { name: "large cells r20c10", row: 20, col: 10, cellW: 300, cellH: 60 },
    { name: "asymmetric r0c0", row: 0, col: 0, cellW: 30, cellH: 100 },
    { name: "asymmetric r50c50", row: 50, col: 50, cellW: 30, cellH: 100 },
    { name: "asymmetric2 r0c0", row: 0, col: 0, cellW: 200, cellH: 12 },
    { name: "asymmetric2 r100c20", row: 100, col: 20, cellW: 200, cellH: 12 },
  ];

  it.each(configCases)(
    "$name (cellW=$cellW cellH=$cellH)",
    ({ row, col, cellW, cellH }) => {
      const config = makeConfig({ defaultCellWidth: cellW, defaultCellHeight: cellH });
      const result = cellToScroll(row, col, config);
      expect(result.scrollX).toBe(col * cellW);
      expect(result.scrollY).toBe(row * cellH);
    }
  );
});
