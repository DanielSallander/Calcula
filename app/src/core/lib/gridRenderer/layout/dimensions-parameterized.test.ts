//! FILENAME: app/src/core/lib/gridRenderer/layout/dimensions-parameterized.test.ts
// PURPOSE: Heavily parameterized tests for column/row dimension calculations
// TARGET: 500+ tests via it.each

import { describe, it, expect } from "vitest";
import { getColumnWidth, getRowHeight, getColumnX, getRowY } from "./dimensions";
import type { GridConfig, DimensionOverrides, InsertionAnimation } from "../../../types";
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

// ============================================================================
// 1. getColumnWidth: 100 columns x 4 configs = 400 tests
// ============================================================================

const cols0to99 = Array.from({ length: 100 }, (_, i) => i);

describe("getColumnWidth - parameterized", () => {
  // --- Config A: default width (100px) ---
  describe("default config (100px)", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    const dims = makeDims();

    it.each(cols0to99)("col %i returns default width 100", (col) => {
      expect(getColumnWidth(col, config, dims)).toBe(100);
    });
  });

  // --- Config B: custom widths (50-500px, cycling) ---
  describe("custom widths (50-500px)", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    const dims = makeDims();
    const customWidths = cols0to99.map((col) => {
      const w = 50 + ((col * 47) % 451); // deterministic spread 50-500
      dims.columnWidths.set(col, w);
      return [col, w] as const;
    });

    it.each(customWidths)("col %i returns custom width %i", (col, expected) => {
      expect(getColumnWidth(col, config, dims)).toBe(expected);
    });
  });

  // --- Config C: hidden columns (all 100 hidden) ---
  describe("hidden columns (width=0)", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    const hiddenSet = new Set(cols0to99);
    const dims = makeDims({ hiddenCols: hiddenSet });

    it.each(cols0to99)("col %i returns 0 when hidden", (col) => {
      expect(getColumnWidth(col, config, dims)).toBe(0);
    });
  });

  // --- Config D: alternate default width (80px, simulating frozen pane config) ---
  describe("frozen-style config (80px default)", () => {
    const config = makeConfig({ defaultCellWidth: 80 });
    const dims = makeDims();

    it.each(cols0to99)("col %i returns frozen default 80", (col) => {
      expect(getColumnWidth(col, config, dims)).toBe(80);
    });
  });
});

// ============================================================================
// 2. getRowHeight: 100 rows x 1 base config = 100 tests
//    (mirrors column pattern with row-specific scenarios)
// ============================================================================

const rows0to99 = Array.from({ length: 100 }, (_, i) => i);

describe("getRowHeight - parameterized", () => {
  // --- Default height ---
  describe("default config (24px)", () => {
    const config = makeConfig({ defaultCellHeight: 24 });
    const dims = makeDims();

    it.each(rows0to99.slice(0, 25))("row %i returns default height 24", (row) => {
      expect(getRowHeight(row, config, dims)).toBe(24);
    });
  });

  // --- Custom heights ---
  describe("custom heights (15-120px)", () => {
    const config = makeConfig({ defaultCellHeight: 24 });
    const dims = makeDims();
    const customHeights = rows0to99.slice(0, 25).map((row) => {
      const h = 15 + ((row * 43) % 106); // 15-120
      dims.rowHeights.set(row, h);
      return [row, h] as const;
    });

    it.each(customHeights)("row %i returns custom height %i", (row, expected) => {
      expect(getRowHeight(row, config, dims)).toBe(expected);
    });
  });

  // --- Hidden rows ---
  describe("hidden rows", () => {
    const config = makeConfig({ defaultCellHeight: 24 });
    const hiddenSet = new Set(rows0to99.slice(0, 25));
    const dims = makeDims({ hiddenRows: hiddenSet });

    it.each(rows0to99.slice(0, 25))("row %i returns 0 when hidden", (row) => {
      expect(getRowHeight(row, config, dims)).toBe(0);
    });
  });

  // --- Alternate default ---
  describe("alternate default (36px)", () => {
    const config = makeConfig({ defaultCellHeight: 36 });
    const dims = makeDims();

    it.each(rows0to99.slice(0, 25))("row %i returns 36", (row) => {
      expect(getRowHeight(row, config, dims)).toBe(36);
    });
  });
});

// ============================================================================
// 3. getColumnX accumulation: 50 combos
//    Verify pos[n] = rowHeaderWidth + sum(widths[0..n-1])
// ============================================================================

describe("getColumnX accumulation - parameterized", () => {
  // Uniform widths
  describe("uniform widths (100px)", () => {
    const config = makeConfig({ rowHeaderWidth: 50, defaultCellWidth: 100 });
    const dims = makeDims();
    const cases = Array.from({ length: 25 }, (_, i) => [i, 50 + i * 100] as const);

    it.each(cases)("col %i has x=%i", (col, expectedX) => {
      expect(getColumnX(col, config, dims, 0, 0)).toBe(expectedX);
    });
  });

  // Mixed custom widths - precompute expected positions
  describe("mixed custom widths", () => {
    const config = makeConfig({ rowHeaderWidth: 50, defaultCellWidth: 100 });
    const dims = makeDims();
    // Set custom widths for even columns
    for (let c = 0; c < 25; c++) {
      if (c % 2 === 0) dims.columnWidths.set(c, 150);
    }

    const cases: [number, number][] = [];
    let runningX = 50; // rowHeaderWidth
    for (let c = 0; c < 25; c++) {
      cases.push([c, runningX]);
      runningX += c % 2 === 0 ? 150 : 100;
    }

    it.each(cases)("col %i has x=%i with mixed widths", (col, expectedX) => {
      expect(getColumnX(col, config, dims, 0, 0)).toBe(expectedX);
    });
  });
});

// ============================================================================
// 4. getRowY accumulation: 50 combos
// ============================================================================

describe("getRowY accumulation - parameterized", () => {
  // Uniform heights
  describe("uniform heights (24px)", () => {
    const config = makeConfig({ colHeaderHeight: 24, defaultCellHeight: 24 });
    const dims = makeDims();
    const cases = Array.from({ length: 25 }, (_, i) => [i, 24 + i * 24] as const);

    it.each(cases)("row %i has y=%i", (row, expectedY) => {
      expect(getRowY(row, config, dims, 0, 0)).toBe(expectedY);
    });
  });

  // Mixed custom heights
  describe("mixed custom heights", () => {
    const config = makeConfig({ colHeaderHeight: 24, defaultCellHeight: 24 });
    const dims = makeDims();
    for (let r = 0; r < 25; r++) {
      if (r % 3 === 0) dims.rowHeights.set(r, 48);
    }

    const cases: [number, number][] = [];
    let runningY = 24; // colHeaderHeight
    for (let r = 0; r < 25; r++) {
      cases.push([r, runningY]);
      runningY += r % 3 === 0 ? 48 : 24;
    }

    it.each(cases)("row %i has y=%i with mixed heights", (row, expectedY) => {
      expect(getRowY(row, config, dims, 0, 0)).toBe(expectedY);
    });
  });
});

// ============================================================================
// 5. Insert/delete animation: 30 progress values x 2 (col/row) = 60 tests
// ============================================================================

const progressSteps = Array.from({ length: 30 }, (_, i) => +(i / 29).toFixed(4));

describe("insertion animation - parameterized", () => {
  describe("column insert animation", () => {
    const config = makeConfig({ rowHeaderWidth: 50, defaultCellWidth: 100 });
    const dims = makeDims();
    const baseX = 50 + 5 * 100; // col 5, no animation = 550

    const cases = progressSteps.map((p) => {
      const remaining = (1 - p) * 100; // targetSize=100, count=1
      return [p, baseX - remaining] as const;
    });

    it.each(cases)("progress=%f -> x=%f for col insert", (progress, expectedX) => {
      const anim: InsertionAnimation = {
        type: "column",
        index: 2,
        count: 1,
        targetSize: 100,
        progress,
        direction: "insert",
      };
      expect(getColumnX(5, config, dims, 0, 0, anim)).toBeCloseTo(expectedX, 2);
    });
  });

  describe("column delete animation", () => {
    const config = makeConfig({ rowHeaderWidth: 50, defaultCellWidth: 100 });
    const dims = makeDims();
    const baseX = 50 + 5 * 100; // 550

    const cases = progressSteps.map((p) => {
      const remaining = (1 - p) * 100;
      return [p, baseX + remaining] as const;
    });

    it.each(cases)("progress=%f -> x=%f for col delete", (progress, expectedX) => {
      const anim: InsertionAnimation = {
        type: "column",
        index: 2,
        count: 1,
        targetSize: 100,
        progress,
        direction: "delete",
      };
      expect(getColumnX(5, config, dims, 0, 0, anim)).toBeCloseTo(expectedX, 2);
    });
  });

  describe("row insert animation", () => {
    const config = makeConfig({ colHeaderHeight: 24, defaultCellHeight: 24 });
    const dims = makeDims();
    const baseY = 24 + 5 * 24; // row 5 = 144

    const cases = progressSteps.map((p) => {
      const remaining = (1 - p) * 24;
      return [p, baseY - remaining] as const;
    });

    it.each(cases)("progress=%f -> y=%f for row insert", (progress, expectedY) => {
      const anim: InsertionAnimation = {
        type: "row",
        index: 2,
        count: 1,
        targetSize: 24,
        progress,
        direction: "insert",
      };
      expect(getRowY(5, config, dims, 0, 0, anim)).toBeCloseTo(expectedY, 2);
    });
  });

  describe("row delete animation", () => {
    const config = makeConfig({ colHeaderHeight: 24, defaultCellHeight: 24 });
    const dims = makeDims();
    const baseY = 24 + 5 * 24; // 144

    const cases = progressSteps.map((p) => {
      const remaining = (1 - p) * 24;
      return [p, baseY + remaining] as const;
    });

    it.each(cases)("progress=%f -> y=%f for row delete", (progress, expectedY) => {
      const anim: InsertionAnimation = {
        type: "row",
        index: 2,
        count: 1,
        targetSize: 24,
        progress,
        direction: "delete",
      };
      expect(getRowY(5, config, dims, 0, 0, anim)).toBeCloseTo(expectedY, 2);
    });
  });
});
