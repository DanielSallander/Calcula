//! FILENAME: app/src/core/lib/gridRenderer/layout/viewport.test.ts
// PURPOSE: Tests for viewport visible range and freeze pane layout calculations

import { describe, it, expect } from "vitest";
import {
  calculateVisibleRange,
  calculateFreezePaneLayout,
  calculateFrozenTopLeftRange,
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

// ============================================================================
// calculateVisibleRange
// ============================================================================

describe("calculateVisibleRange", () => {
  it("returns zeros for invalid inputs", () => {
    const result = calculateVisibleRange(
      { scrollX: 0, scrollY: 0 } as Viewport,
      makeConfig(),
      0, // invalid width
      600,
    );
    expect(result.startRow).toBe(0);
    expect(result.endRow).toBe(0);
    expect(result.startCol).toBe(0);
    expect(result.endCol).toBe(0);
  });

  it("starts at row 0, col 0 when scroll is at origin", () => {
    const result = calculateVisibleRange(
      { scrollX: 0, scrollY: 0 } as Viewport,
      makeConfig(),
      800,
      600,
    );
    expect(result.startRow).toBe(0);
    expect(result.startCol).toBe(0);
    expect(result.offsetX).toBe(-0); // -0 from -(0 - 0)
    expect(result.offsetY).toBe(-0);
  });

  it("calculates correct endCol based on canvas width", () => {
    // canvas width 800, rowHeaderWidth 50, defaultCellWidth 100
    // visible width = 800 - 50 = 750, loop adds cols until widthAccum >= 750
    // 8 cols * 100 = 800 >= 750, so endCol = 8 (inclusive, 0-based)
    const config = makeConfig({ defaultCellWidth: 100, rowHeaderWidth: 50 });
    const result = calculateVisibleRange(
      { scrollX: 0, scrollY: 0 } as Viewport,
      config,
      800,
      600,
    );
    expect(result.startCol).toBe(0);
    expect(result.endCol).toBe(8);
  });

  it("calculates correct endRow based on canvas height", () => {
    // canvas height 600, colHeaderHeight 24, defaultCellHeight 24
    // visible height = 576, 24 rows * 24 = 576 >= 576, endRow = 24
    const config = makeConfig({ defaultCellHeight: 24, colHeaderHeight: 24 });
    const result = calculateVisibleRange(
      { scrollX: 0, scrollY: 0 } as Viewport,
      config,
      800,
      600,
    );
    expect(result.startCol).toBe(0);
    expect(result.endRow).toBe(24);
  });

  it("scrolls to correct start column", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    // scrollX = 250 => skip 2 full columns (200px), partial into col 2
    const result = calculateVisibleRange(
      { scrollX: 250, scrollY: 0 } as Viewport,
      config,
      800,
      600,
    );
    expect(result.startCol).toBe(2);
    expect(result.offsetX).toBe(-50); // 250 - 200 = 50 into col 2
  });

  it("scrolls to correct start row", () => {
    const config = makeConfig({ defaultCellHeight: 24 });
    // scrollY = 60 => skip 2 full rows (48px), partial into row 2
    const result = calculateVisibleRange(
      { scrollX: 0, scrollY: 60 } as Viewport,
      config,
      800,
      600,
    );
    expect(result.startRow).toBe(2);
    expect(result.offsetY).toBe(-12); // 60 - 48 = 12 into row 2
  });

  it("skips hidden columns", () => {
    const config = makeConfig({ defaultCellWidth: 100, rowHeaderWidth: 50 });
    const dims = makeDims({ hiddenCols: new Set([0, 1]) });
    const result = calculateVisibleRange(
      { scrollX: 0, scrollY: 0 } as Viewport,
      config,
      800,
      600,
      dims,
    );
    // Hidden cols 0,1 are skipped (zero width), so startCol advances past them
    expect(result.startCol).toBe(2);
    // More columns visible since hidden ones take no space
    expect(result.endCol).toBeGreaterThanOrEqual(9);
  });

  it("skips hidden rows", () => {
    const config = makeConfig({ defaultCellHeight: 24, colHeaderHeight: 24 });
    const dims = makeDims({ hiddenRows: new Set([0, 1, 2]) });
    const result = calculateVisibleRange(
      { scrollX: 0, scrollY: 0 } as Viewport,
      config,
      800,
      600,
      dims,
    );
    // Hidden rows 0,1,2 are skipped, so startRow advances past them
    expect(result.startRow).toBe(3);
    // More rows visible since hidden ones take no space
    expect(result.endRow).toBeGreaterThanOrEqual(26);
  });

  it("respects custom column widths", () => {
    const config = makeConfig({ defaultCellWidth: 100, rowHeaderWidth: 50 });
    const dims = makeDims();
    dims.columnWidths.set(0, 300); // first column is 300px wide
    const result = calculateVisibleRange(
      { scrollX: 0, scrollY: 0 } as Viewport,
      config,
      800,
      600,
      dims,
    );
    // visible width = 750, col0=300, col1-5=500, total 800 > 750 => endCol=6
    expect(result.endCol).toBe(6);
  });

  it("clamps endRow to totalRows - 1", () => {
    const config = makeConfig({ totalRows: 5, defaultCellHeight: 24 });
    const result = calculateVisibleRange(
      { scrollX: 0, scrollY: 0 } as Viewport,
      config,
      800,
      600,
    );
    expect(result.endRow).toBe(4);
  });
});

// ============================================================================
// calculateFreezePaneLayout
// ============================================================================

describe("calculateFreezePaneLayout", () => {
  it("returns zeros when no freeze", () => {
    const freeze: FreezeConfig = { freezeRow: null, freezeCol: null };
    const layout = calculateFreezePaneLayout(freeze, makeConfig());
    expect(layout.frozenColsWidth).toBe(0);
    expect(layout.frozenRowsHeight).toBe(0);
    expect(layout.hasFrozenRows).toBe(false);
    expect(layout.hasFrozenCols).toBe(false);
  });

  it("calculates frozen column width", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    const freeze: FreezeConfig = { freezeRow: null, freezeCol: 2 };
    const layout = calculateFreezePaneLayout(freeze, config);
    expect(layout.frozenColsWidth).toBe(200);
    expect(layout.hasFrozenCols).toBe(true);
    expect(layout.frozenColCount).toBe(2);
  });

  it("calculates frozen row height", () => {
    const config = makeConfig({ defaultCellHeight: 24 });
    const freeze: FreezeConfig = { freezeRow: 3, freezeCol: null };
    const layout = calculateFreezePaneLayout(freeze, config);
    expect(layout.frozenRowsHeight).toBe(72);
    expect(layout.hasFrozenRows).toBe(true);
    expect(layout.frozenRowCount).toBe(3);
  });

  it("uses custom dimensions for frozen area", () => {
    const config = makeConfig({ defaultCellWidth: 100 });
    const dims = makeDims();
    dims.columnWidths.set(0, 200);
    const freeze: FreezeConfig = { freezeRow: null, freezeCol: 2 };
    const layout = calculateFreezePaneLayout(freeze, config, dims);
    expect(layout.frozenColsWidth).toBe(300); // 200 + 100
  });
});

// ============================================================================
// calculateFrozenTopLeftRange
// ============================================================================

describe("calculateFrozenTopLeftRange", () => {
  it("returns null when only rows frozen", () => {
    const freeze: FreezeConfig = { freezeRow: 2, freezeCol: null };
    expect(calculateFrozenTopLeftRange(freeze, makeConfig(), 800, 600)).toBeNull();
  });

  it("returns null when only cols frozen", () => {
    const freeze: FreezeConfig = { freezeRow: null, freezeCol: 2 };
    expect(calculateFrozenTopLeftRange(freeze, makeConfig(), 800, 600)).toBeNull();
  });

  it("returns correct range when both frozen", () => {
    const freeze: FreezeConfig = { freezeRow: 2, freezeCol: 3 };
    const range = calculateFrozenTopLeftRange(freeze, makeConfig(), 800, 600);
    expect(range).not.toBeNull();
    expect(range!.startRow).toBe(0);
    expect(range!.endRow).toBe(1);
    expect(range!.startCol).toBe(0);
    expect(range!.endCol).toBe(2);
    expect(range!.offsetX).toBe(0);
    expect(range!.offsetY).toBe(0);
  });
});
