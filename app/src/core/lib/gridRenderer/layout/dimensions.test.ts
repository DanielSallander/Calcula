//! FILENAME: app/src/core/lib/gridRenderer/layout/dimensions.test.ts
// PURPOSE: Tests for column width, row height, and position calculations

import { describe, it, expect } from "vitest";
import { getColumnWidth, getRowHeight, getColumnX, getRowY } from "./dimensions";
import type { GridConfig, DimensionOverrides, InsertionAnimation } from "../../../types";
import { createEmptyDimensionOverrides } from "../../../types";

// ============================================================================
// Test helpers
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
// getColumnWidth
// ============================================================================

describe("getColumnWidth", () => {
  it("returns default width when no custom width set", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    expect(getColumnWidth(0, config, makeDims())).toBe(100);
  });

  it("returns custom width when set", () => {
    const dims = makeDims();
    dims.columnWidths.set(3, 200);
    expect(getColumnWidth(3, makeConfig(), dims)).toBe(200);
  });

  it("returns 0 for hidden columns", () => {
    const dims = makeDims({ hiddenCols: new Set([5]) });
    expect(getColumnWidth(5, makeConfig(), dims)).toBe(0);
  });

  it("returns default when custom width is 0 or negative", () => {
    const dims = makeDims();
    dims.columnWidths.set(1, 0);
    expect(getColumnWidth(1, makeConfig({ defaultCellWidth: 80 }), dims)).toBe(80);
  });
});

// ============================================================================
// getRowHeight
// ============================================================================

describe("getRowHeight", () => {
  it("returns default height when no custom height set", () => {
    expect(getRowHeight(0, makeConfig({ defaultCellHeight: 24 }), makeDims())).toBe(24);
  });

  it("returns custom height when set", () => {
    const dims = makeDims();
    dims.rowHeights.set(2, 48);
    expect(getRowHeight(2, makeConfig(), dims)).toBe(48);
  });

  it("returns 0 for hidden rows", () => {
    const dims = makeDims({ hiddenRows: new Set([10]) });
    expect(getRowHeight(10, makeConfig(), dims)).toBe(0);
  });
});

// ============================================================================
// getColumnX
// ============================================================================

describe("getColumnX", () => {
  it("returns rowHeaderWidth + offsetX for startCol", () => {
    const config = makeConfig({ rowHeaderWidth: 50 });
    expect(getColumnX(0, config, makeDims(), 0, 0)).toBe(50);
  });

  it("accumulates widths of previous columns", () => {
    const config = makeConfig({ rowHeaderWidth: 50, defaultCellWidth: 100 });
    // col 3 starting from col 0: 50 + 3*100 = 350
    expect(getColumnX(3, config, makeDims(), 0, 0)).toBe(350);
  });

  it("applies negative offsetX (partial scroll)", () => {
    const config = makeConfig({ rowHeaderWidth: 50, defaultCellWidth: 100 });
    expect(getColumnX(0, config, makeDims(), 0, -30)).toBe(20);
  });

  it("skips hidden columns in accumulation", () => {
    const config = makeConfig({ rowHeaderWidth: 50, defaultCellWidth: 100 });
    const dims = makeDims({ hiddenCols: new Set([1]) });
    // col 3 from col 0: col0=100 + col1=0(hidden) + col2=100 = 200 + 50 = 250
    expect(getColumnX(3, config, dims, 0, 0)).toBe(250);
  });

  it("applies insert animation offset", () => {
    const config = makeConfig({ rowHeaderWidth: 50, defaultCellWidth: 100 });
    const anim: InsertionAnimation = {
      type: "column",
      index: 2,
      count: 1,
      targetSize: 100,
      progress: 0, // start of animation
      direction: "insert",
    };
    // col 3 without animation: 50 + 300 = 350
    // With insert at progress=0: offset = (1-0)*100 = 100, x -= 100 => 250
    expect(getColumnX(3, config, makeDims(), 0, 0, anim)).toBe(250);
  });

  it("no animation offset at progress=1 (animation complete)", () => {
    const config = makeConfig({ rowHeaderWidth: 50, defaultCellWidth: 100 });
    const anim: InsertionAnimation = {
      type: "column",
      index: 2,
      count: 1,
      targetSize: 100,
      progress: 1,
      direction: "insert",
    };
    expect(getColumnX(3, config, makeDims(), 0, 0, anim)).toBe(350);
  });
});

// ============================================================================
// getRowY
// ============================================================================

describe("getRowY", () => {
  it("returns colHeaderHeight + offsetY for startRow", () => {
    const config = makeConfig({ colHeaderHeight: 24 });
    expect(getRowY(0, config, makeDims(), 0, 0)).toBe(24);
  });

  it("accumulates heights of previous rows", () => {
    const config = makeConfig({ colHeaderHeight: 24, defaultCellHeight: 24 });
    // row 5 from row 0: 24 + 5*24 = 144
    expect(getRowY(5, config, makeDims(), 0, 0)).toBe(144);
  });

  it("applies delete animation offset", () => {
    const config = makeConfig({ colHeaderHeight: 24, defaultCellHeight: 24 });
    const anim: InsertionAnimation = {
      type: "row",
      index: 1,
      count: 1,
      targetSize: 24,
      progress: 0,
      direction: "delete",
    };
    // row 2 without anim: 24 + 2*24 = 72
    // delete at progress=0: offset = (1-0)*24 = 24, y += 24 => 96
    expect(getRowY(2, config, makeDims(), 0, 0, anim)).toBe(96);
  });
});
