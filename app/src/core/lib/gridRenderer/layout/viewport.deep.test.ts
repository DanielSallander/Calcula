//! FILENAME: app/src/core/lib/gridRenderer/layout/viewport.deep.test.ts
// PURPOSE: Deep tests for viewport calculations - hidden rows, extreme dimensions, freeze panes
// CONTEXT: Tests calculateVisibleRange, calculateFreezePaneLayout, and zone calculations

import { describe, it, expect } from "vitest";
import {
  calculateVisibleRange,
  calculateFreezePaneLayout,
  calculateFrozenTopLeftRange,
  calculateFrozenTopRange,
  calculateFrozenLeftRange,
  calculateScrollableRange,
} from "./viewport";
import type { GridConfig, Viewport, DimensionOverrides, FreezeConfig } from "../../../types";
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

function makeViewport(scrollX = 0, scrollY = 0): Viewport {
  return { scrollX, scrollY, startRow: 0, startCol: 0, rowCount: 0, colCount: 0 } as Viewport;
}

// ============================================================================
// Viewport with 100+ hidden rows interspersed
// ============================================================================

describe("calculateVisibleRange - many hidden rows", () => {
  it("skips 100 hidden rows interspersed among visible ones", () => {
    const config = makeConfig({ defaultCellHeight: 24, totalRows: 500 });
    const dims = makeDims();
    // Hide every other row from 0..199 (100 hidden rows)
    for (let i = 0; i < 200; i += 2) {
      dims.hiddenRows.add(i);
    }

    const result = calculateVisibleRange(makeViewport(0, 0), config, 800, 600, dims);

    // startRow should be the first non-hidden row
    expect(result.startRow).toBe(1);
    // endRow should be further out since hidden rows take no space
    expect(result.endRow).toBeGreaterThan(24);
  });

  it("scrolls past hidden rows correctly", () => {
    const config = makeConfig({ defaultCellHeight: 20, totalRows: 1000 });
    const dims = makeDims();
    // Hide rows 0-99
    for (let i = 0; i < 100; i++) {
      dims.hiddenRows.add(i);
    }

    const result = calculateVisibleRange(makeViewport(0, 0), config, 800, 600, dims);

    // All first 100 rows hidden, startRow should be 100
    expect(result.startRow).toBe(100);
    expect(result.offsetY).toBe(-0);
  });

  it("handles 100 hidden columns interspersed", () => {
    const config = makeConfig({ defaultCellWidth: 80, totalCols: 300 });
    const dims = makeDims();
    for (let i = 0; i < 200; i += 2) {
      dims.hiddenCols.add(i);
    }

    const result = calculateVisibleRange(makeViewport(0, 0), config, 800, 600, dims);

    expect(result.startCol).toBe(1);
    expect(result.endCol).toBeGreaterThan(8);
  });
});

// ============================================================================
// Viewport at maximum Excel dimensions
// ============================================================================

describe("calculateVisibleRange - max Excel dimensions", () => {
  it("handles 1,048,576 rows (Excel max)", () => {
    const config = makeConfig({ totalRows: 1048576, defaultCellHeight: 20 });
    const result = calculateVisibleRange(makeViewport(0, 0), config, 800, 600);

    expect(result.startRow).toBe(0);
    // With 576px visible height / 20px per row = 28-29 rows visible
    expect(result.endRow).toBeLessThan(35);
    expect(result.endRow).toBeGreaterThanOrEqual(28);
  });

  it("handles 16,384 columns (Excel max)", () => {
    const config = makeConfig({ totalCols: 16384, defaultCellWidth: 64 });
    const result = calculateVisibleRange(makeViewport(0, 0), config, 800, 600);

    expect(result.startCol).toBe(0);
    expect(result.endCol).toBeLessThan(20);
  });

  it("scrolls to near-end of 1M rows", () => {
    const config = makeConfig({ totalRows: 1048576, defaultCellHeight: 20 });
    // Scroll to near the end
    const scrollY = (1048576 - 50) * 20;
    const result = calculateVisibleRange(makeViewport(0, scrollY), config, 800, 600);

    expect(result.startRow).toBeGreaterThan(1048500);
    // endRow depends on how many rows fit in visible height; just verify it's near the end
    expect(result.endRow).toBeGreaterThan(1048550);
  });

  it("scrolls to near-end of 16K columns", () => {
    const config = makeConfig({ totalCols: 16384, defaultCellWidth: 64 });
    const scrollX = (16384 - 20) * 64;
    const result = calculateVisibleRange(makeViewport(scrollX, 0), config, 800, 600);

    expect(result.startCol).toBeGreaterThan(16350);
    expect(result.endCol).toBeGreaterThan(16370);
  });
});

// ============================================================================
// Freeze panes with custom dimensions
// ============================================================================

describe("calculateFreezePaneLayout - custom dimensions", () => {
  it("calculates frozen width with mixed custom column widths", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    const dims = makeDims();
    dims.columnWidths.set(0, 50);
    dims.columnWidths.set(1, 200);
    dims.columnWidths.set(2, 30);

    const freeze: FreezeConfig = { freezeRow: null, freezeCol: 3 };
    const layout = calculateFreezePaneLayout(freeze, config, dims);

    expect(layout.frozenColsWidth).toBe(280); // 50 + 200 + 30
    expect(layout.hasFrozenCols).toBe(true);
  });

  it("calculates frozen height with mixed custom row heights", () => {
    const config = makeConfig({ defaultCellHeight: 24 });
    const dims = makeDims();
    dims.rowHeights.set(0, 48);
    dims.rowHeights.set(1, 12);

    const freeze: FreezeConfig = { freezeRow: 2, freezeCol: null };
    const layout = calculateFreezePaneLayout(freeze, config, dims);

    expect(layout.frozenRowsHeight).toBe(60); // 48 + 12
  });

  it("handles freezeRow and freezeCol both set with custom dimensions", () => {
    const config = makeConfig({ defaultCellWidth: 100, defaultCellHeight: 24 });
    const dims = makeDims();
    dims.columnWidths.set(0, 150);
    dims.rowHeights.set(0, 36);

    const freeze: FreezeConfig = { freezeRow: 2, freezeCol: 2 };
    const layout = calculateFreezePaneLayout(freeze, config, dims);

    expect(layout.frozenColsWidth).toBe(250); // 150 + 100
    expect(layout.frozenRowsHeight).toBe(60); // 36 + 24
    expect(layout.hasFrozenRows).toBe(true);
    expect(layout.hasFrozenCols).toBe(true);
  });
});

// ============================================================================
// Freeze pane zone calculations
// ============================================================================

describe("freeze pane zone calculations", () => {
  const config = makeConfig({ defaultCellWidth: 100, defaultCellHeight: 24, totalRows: 1000, totalCols: 100 });
  const freeze: FreezeConfig = { freezeRow: 3, freezeCol: 2 };

  it("frozen top-left range is static (no scroll)", () => {
    const range = calculateFrozenTopLeftRange(freeze, config, 800, 600);
    expect(range).not.toBeNull();
    expect(range!.startRow).toBe(0);
    expect(range!.endRow).toBe(2);
    expect(range!.startCol).toBe(0);
    expect(range!.endCol).toBe(1);
    expect(range!.offsetX).toBe(0);
    expect(range!.offsetY).toBe(0);
  });

  it("frozen top range scrolls horizontally only", () => {
    const range = calculateFrozenTopRange(makeViewport(150, 500), freeze, config, 800, 600);
    expect(range).not.toBeNull();
    expect(range!.startRow).toBe(0);
    expect(range!.endRow).toBe(2); // frozen rows 0-2
    expect(range!.startCol).toBeGreaterThanOrEqual(2); // starts after frozen cols
    expect(range!.offsetX).toBeLessThanOrEqual(0); // negative offset for partial column
  });

  it("frozen left range scrolls vertically only", () => {
    const range = calculateFrozenLeftRange(makeViewport(500, 240), freeze, config, 800, 600);
    expect(range).not.toBeNull();
    expect(range!.startCol).toBe(0);
    expect(range!.endCol).toBe(1); // frozen cols 0-1
    expect(range!.startRow).toBeGreaterThanOrEqual(3); // starts after frozen rows
  });

  it("scrollable range starts after frozen area", () => {
    const range = calculateScrollableRange(makeViewport(0, 0), freeze, config, 800, 600);
    expect(range.startRow).toBe(3);
    expect(range.startCol).toBe(2);
  });

  it("scrollable range scrolls both directions", () => {
    const range = calculateScrollableRange(makeViewport(300, 480), freeze, config, 800, 600);
    expect(range.startRow).toBeGreaterThanOrEqual(3);
    expect(range.startCol).toBeGreaterThanOrEqual(2);
    // Should have scrolled past some rows/cols
    expect(range.startRow).toBeGreaterThan(3);
    expect(range.startCol).toBeGreaterThan(2);
  });
});

// ============================================================================
// Viewport change detection for re-render optimization
// ============================================================================

describe("calculateVisibleRange - change detection", () => {
  it("returns identical range for same scroll position", () => {
    const config = makeConfig();
    const r1 = calculateVisibleRange(makeViewport(100, 200), config, 800, 600);
    const r2 = calculateVisibleRange(makeViewport(100, 200), config, 800, 600);

    expect(r1.startRow).toBe(r2.startRow);
    expect(r1.endRow).toBe(r2.endRow);
    expect(r1.startCol).toBe(r2.startCol);
    expect(r1.endCol).toBe(r2.endCol);
    expect(r1.offsetX).toBe(r2.offsetX);
    expect(r1.offsetY).toBe(r2.offsetY);
  });

  it("returns different range when scrollY changes by one row", () => {
    const config = makeConfig({ defaultCellHeight: 24 });
    const r1 = calculateVisibleRange(makeViewport(0, 0), config, 800, 600);
    const r2 = calculateVisibleRange(makeViewport(0, 24), config, 800, 600);

    expect(r2.startRow).toBe(r1.startRow + 1);
  });

  it("returns same startRow for sub-pixel scroll within same row", () => {
    const config = makeConfig({ defaultCellHeight: 24 });
    const r1 = calculateVisibleRange(makeViewport(0, 5), config, 800, 600);
    const r2 = calculateVisibleRange(makeViewport(0, 10), config, 800, 600);

    expect(r1.startRow).toBe(r2.startRow);
    // But offsets differ
    expect(r1.offsetY).not.toBe(r2.offsetY);
  });
});

// ============================================================================
// Very small viewport (single cell visible)
// ============================================================================

describe("calculateVisibleRange - very small viewport", () => {
  it("shows a single cell when canvas is tiny", () => {
    // rowHeaderWidth=50, colHeaderHeight=24, so visible area = 51-50=1px wide, 25-24=1px tall
    const config = makeConfig({ defaultCellWidth: 100, defaultCellHeight: 24, rowHeaderWidth: 50, colHeaderHeight: 24 });
    const result = calculateVisibleRange(makeViewport(0, 0), config, 51, 25);

    // Should show at least startRow/startCol
    expect(result.startRow).toBe(0);
    expect(result.startCol).toBe(0);
    // endRow/endCol should be at most 1 since only 1px visible
    expect(result.endRow).toBeLessThanOrEqual(1);
    expect(result.endCol).toBeLessThanOrEqual(1);
  });

  it("returns zeros for canvas smaller than headers", () => {
    const config = makeConfig({ rowHeaderWidth: 50, colHeaderHeight: 24 });
    // Canvas width < rowHeaderWidth => visibleWidth = negative
    const result = calculateVisibleRange(makeViewport(0, 0), config, 30, 20);

    // Should still return valid range (starts at 0)
    expect(result.startRow).toBe(0);
    expect(result.startCol).toBe(0);
  });
});

// ============================================================================
// Very large viewport (1000 cells visible)
// ============================================================================

describe("calculateVisibleRange - very large viewport", () => {
  it("shows many columns on a wide canvas", () => {
    const config = makeConfig({ defaultCellWidth: 50, totalCols: 2000 });
    // visible width = 10050 - 50 = 10000, at 50px/col = 200 cols
    const result = calculateVisibleRange(makeViewport(0, 0), config, 10050, 600);

    expect(result.endCol).toBeGreaterThanOrEqual(199);
  });

  it("shows many rows on a tall canvas", () => {
    const config = makeConfig({ defaultCellHeight: 20, totalRows: 5000 });
    // visible height = 20024 - 24 = 20000, at 20px/row = 1000 rows
    const result = calculateVisibleRange(makeViewport(0, 0), config, 800, 20024);

    expect(result.endRow).toBeGreaterThanOrEqual(999);
  });

  it("handles 4K display resolution (3840x2160)", () => {
    const config = makeConfig({ defaultCellWidth: 80, defaultCellHeight: 20 });
    const result = calculateVisibleRange(makeViewport(0, 0), config, 3840, 2160);

    // visible width = 3840 - 50 = 3790, 3790/80 ~= 47 cols
    expect(result.endCol).toBeGreaterThanOrEqual(47);
    // visible height = 2160 - 24 = 2136, 2136/20 = 106 rows
    expect(result.endRow).toBeGreaterThanOrEqual(106);
  });
});

// ============================================================================
// Scrollable range edge cases
// ============================================================================

describe("calculateScrollableRange - edge cases", () => {
  it("returns minimal range when frozen area fills the canvas", () => {
    const config = makeConfig({ defaultCellWidth: 400, defaultCellHeight: 300, totalCols: 10, totalRows: 10 });
    // Freeze 2 cols (800px) + rowHeaderWidth (50) = 850 > canvas width 800
    const freeze: FreezeConfig = { freezeRow: null, freezeCol: 2 };
    const range = calculateScrollableRange(makeViewport(0, 0), freeze, config, 800, 600);

    // scrollableWidth <= 0, so returns minimal range
    expect(range.startCol).toBe(2);
    expect(range.endCol).toBe(2);
  });

  it("returns valid range when frozen area is just one row/col", () => {
    const config = makeConfig({ defaultCellWidth: 100, defaultCellHeight: 24 });
    const freeze: FreezeConfig = { freezeRow: 1, freezeCol: 1 };
    const range = calculateScrollableRange(makeViewport(0, 0), freeze, config, 800, 600);

    expect(range.startRow).toBe(1);
    expect(range.startCol).toBe(1);
    expect(range.endRow).toBeGreaterThan(1);
    expect(range.endCol).toBeGreaterThan(1);
  });
});
