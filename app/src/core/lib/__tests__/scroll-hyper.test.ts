/**
 * FILENAME: app/src/core/lib/__tests__/scroll-hyper.test.ts
 * PURPOSE: Hyper-massive parameterized tests for scroll utilities.
 * TARGET: 3000+ tests via programmatic it.each arrays.
 */

import { describe, it, expect } from "vitest";
import {
  getColumnXPosition,
  getRowYPosition,
  isCellVisible,
  calculateScrollbarMetrics,
} from "../scrollUtils";
import type { GridConfig, Viewport } from "../../types";

// ---------------------------------------------------------------------------
// Shared config
// ---------------------------------------------------------------------------
const defaultConfig: GridConfig = {
  defaultCellWidth: 100,
  defaultCellHeight: 25,
  rowHeaderWidth: 50,
  colHeaderHeight: 30,
  totalRows: 1_048_576,
  totalCols: 16_384,
  minColumnWidth: 20,
  minRowHeight: 10,
  outlineBarWidth: 0,
};

// ===========================================================================
// 1. getColumnXPosition for columns 500-1499 (1000 tests)
// ===========================================================================
const colXCases: [number, number][] = Array.from({ length: 1000 }, (_, i) => [
  500 + i,
  (500 + i) * 100,
]);

describe("getColumnXPosition columns 500-1499", () => {
  it.each(colXCases)("col %i => x %i", (col, expected) => {
    expect(getColumnXPosition(col, defaultConfig)).toBe(expected);
  });
});

// ===========================================================================
// 2. getRowYPosition for rows 500-1499 (1000 tests)
// ===========================================================================
const rowYCases: [number, number][] = Array.from({ length: 1000 }, (_, i) => [
  500 + i,
  (500 + i) * 25,
]);

describe("getRowYPosition rows 500-1499", () => {
  it.each(rowYCases)("row %i => y %i", (row, expected) => {
    expect(getRowYPosition(row, defaultConfig)).toBe(expected);
  });
});

// ===========================================================================
// 3. isCellVisible: 500 systematic row/col/viewport combos
// ===========================================================================
const viewportWidth = 1000; // 10 cols visible at 100px
const viewportHeight = 500; // 20 rows visible at 25px

const visibilityCases: [number, number, number, number, boolean][] = Array.from(
  { length: 500 },
  (_, i) => {
    // Vary scrollX and scrollY systematically
    const scrollX = (i % 25) * 200; // 0..4800
    const scrollY = Math.floor(i / 25) * 100; // 0..1900
    const testRow = Math.floor(scrollY / 25) + (i % 5); // near top of viewport
    const testCol = Math.floor(scrollX / 100) + (i % 3); // near left of viewport
    // Cell is visible if within the visible range
    const startRow = Math.floor(scrollY / 25);
    const endRow = Math.ceil((scrollY + viewportHeight) / 25);
    const startCol = Math.floor(scrollX / 100);
    const endCol = Math.ceil((scrollX + viewportWidth) / 100);
    const visible =
      testRow >= startRow &&
      testRow <= endRow &&
      testCol >= startCol &&
      testCol <= endCol;
    return [testRow, testCol, scrollX, scrollY, visible];
  }
);

describe("isCellVisible 500 combos", () => {
  it.each(visibilityCases)(
    "row=%i col=%i scrollX=%i scrollY=%i => %s",
    (row, col, scrollX, scrollY, expected) => {
      const viewport: Viewport = {
        startRow: 0,
        startCol: 0,
        rowCount: 20,
        colCount: 10,
        scrollX,
        scrollY,
      };
      expect(
        isCellVisible(row, col, viewport, defaultConfig, viewportWidth, viewportHeight)
      ).toBe(expected);
    }
  );
});

// ===========================================================================
// 4. calculateScrollbarMetrics: 500 viewport/content/scroll combos
// ===========================================================================
const scrollbarCases: [number, number, number, number, number, number][] = Array.from(
  { length: 500 },
  (_, i) => {
    const vpWidth = 800 + (i % 10) * 100; // 800..1700
    const vpHeight = 600 + (i % 8) * 50; // 600..950
    const totalRows = 1000 + i * 200;
    const totalCols = 100 + i * 10;
    const scrollX = (i * 73) % (totalCols * 100); // pseudo-random scroll
    const scrollY = (i * 137) % (totalRows * 25);
    return [vpWidth, vpHeight, totalRows, totalCols, scrollX, scrollY];
  }
);

describe("calculateScrollbarMetrics 500 combos", () => {
  it.each(scrollbarCases)(
    "vw=%i vh=%i rows=%i cols=%i sx=%i sy=%i",
    (vpWidth, vpHeight, totalRows, totalCols, scrollX, scrollY) => {
      const config: GridConfig = {
        ...defaultConfig,
        totalRows,
        totalCols,
      };
      const viewport: Viewport = {
        startRow: 0,
        startCol: 0,
        rowCount: 20,
        colCount: 10,
        scrollX,
        scrollY,
      };
      const result = calculateScrollbarMetrics(config, viewport, vpWidth, vpHeight);

      // thumbSize must be > 0
      expect(result.horizontal.thumbSize).toBeGreaterThan(0);
      expect(result.vertical.thumbSize).toBeGreaterThan(0);

      // thumbPosition must be >= 0
      expect(result.horizontal.thumbPosition).toBeGreaterThanOrEqual(0);
      expect(result.vertical.thumbPosition).toBeGreaterThanOrEqual(0);

      // thumbPosition must be within track bounds
      expect(result.horizontal.thumbPosition).toBeLessThanOrEqual(
        result.horizontal.trackSize
      );
      expect(result.vertical.thumbPosition).toBeLessThanOrEqual(
        result.vertical.trackSize
      );
    }
  );
});
