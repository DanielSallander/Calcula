//! FILENAME: app/src/core/lib/__tests__/scrollUtils.deep.test.ts
// PURPOSE: Deep tests for scroll utilities — position calculations, visibility,
//          scrollbar metrics, and scroll delta computations.

import { describe, it, expect } from "vitest";
import {
  getColumnWidthFromDimensions,
  getRowHeightFromDimensions,
  getColumnXPosition,
  getRowYPosition,
  calculateMaxScroll,
  scrollToVisibleRange,
  cellToScroll,
  cellToCenteredScroll,
  calculateScrollDelta,
  isCellVisible,
  scrollToMakeVisible,
  thumbPositionToScroll,
  calculateScrollbarMetrics,
} from "../scrollUtils";
import type { GridConfig, DimensionOverrides, Viewport } from "../../types";

// ============================================================================
// Test Helpers
// ============================================================================

function makeConfig(overrides: Partial<GridConfig> = {}): GridConfig {
  return {
    totalRows: 100,
    totalCols: 26,
    defaultCellWidth: 80,
    defaultCellHeight: 24,
    rowHeaderWidth: 50,
    colHeaderHeight: 24,
    ...overrides,
  } as GridConfig;
}

function makeDimensions(overrides: Partial<DimensionOverrides> = {}): DimensionOverrides {
  return {
    columnWidths: new Map(),
    rowHeights: new Map(),
    hiddenCols: new Set(),
    hiddenRows: new Set(),
    ...overrides,
  };
}

function makeViewport(overrides: Partial<Viewport> = {}): Viewport {
  return {
    scrollX: 0,
    scrollY: 0,
    ...overrides,
  } as Viewport;
}

// ============================================================================
// getColumnWidthFromDimensions / getRowHeightFromDimensions
// ============================================================================

describe("getColumnWidthFromDimensions", () => {
  const config = makeConfig();

  it("returns default width when no overrides", () => {
    expect(getColumnWidthFromDimensions(0, config)).toBe(80);
  });

  it("returns custom width when overridden", () => {
    const dims = makeDimensions({ columnWidths: new Map([[2, 150]]) });
    expect(getColumnWidthFromDimensions(2, config, dims)).toBe(150);
  });

  it("returns 0 for hidden columns", () => {
    const dims = makeDimensions({ hiddenCols: new Set([3]) });
    expect(getColumnWidthFromDimensions(3, config, dims)).toBe(0);
  });

  it("hidden takes precedence over custom width", () => {
    const dims = makeDimensions({
      columnWidths: new Map([[5, 200]]),
      hiddenCols: new Set([5]),
    });
    expect(getColumnWidthFromDimensions(5, config, dims)).toBe(0);
  });
});

describe("getRowHeightFromDimensions", () => {
  const config = makeConfig();

  it("returns default height when no overrides", () => {
    expect(getRowHeightFromDimensions(0, config)).toBe(24);
  });

  it("returns custom height when overridden", () => {
    const dims = makeDimensions({ rowHeights: new Map([[1, 48]]) });
    expect(getRowHeightFromDimensions(1, config, dims)).toBe(48);
  });

  it("returns 0 for hidden rows", () => {
    const dims = makeDimensions({ hiddenRows: new Set([10]) });
    expect(getRowHeightFromDimensions(10, config, dims)).toBe(0);
  });
});

// ============================================================================
// getColumnXPosition / getRowYPosition
// ============================================================================

describe("getColumnXPosition", () => {
  const config = makeConfig();

  it("returns 0 for first column", () => {
    expect(getColumnXPosition(0, config)).toBe(0);
  });

  it("returns n * defaultWidth for nth column with no overrides", () => {
    expect(getColumnXPosition(5, config)).toBe(5 * 80);
  });

  it("accounts for custom widths of earlier columns", () => {
    const dims = makeDimensions({ columnWidths: new Map([[2, 200]]) });
    // Col 5 pos = 5*80 + (200-80) = 400 + 120 = 520
    expect(getColumnXPosition(5, config, dims)).toBe(520);
  });

  it("accounts for hidden columns before target", () => {
    const dims = makeDimensions({ hiddenCols: new Set([1, 3]) });
    // Col 5: base = 5*80 = 400, minus 2 hidden cols * 80 = 240
    expect(getColumnXPosition(5, config, dims)).toBe(240);
  });
});

describe("getRowYPosition", () => {
  const config = makeConfig();

  it("returns 0 for first row", () => {
    expect(getRowYPosition(0, config)).toBe(0);
  });

  it("accounts for custom heights", () => {
    const dims = makeDimensions({ rowHeights: new Map([[0, 48]]) });
    // Row 1: base = 24, + (48-24) = +24 => 48
    expect(getRowYPosition(1, config, dims)).toBe(48);
  });
});

// ============================================================================
// scrollToVisibleRange
// ============================================================================

describe("scrollToVisibleRange", () => {
  const config = makeConfig();

  it("starts at row 0 col 0 when scroll is 0", () => {
    const range = scrollToVisibleRange(0, 0, config, 800, 600);
    expect(range.startRow).toBe(0);
    expect(range.startCol).toBe(0);
  });

  it("computes sub-pixel offset for smooth scrolling", () => {
    const range = scrollToVisibleRange(50, 10, config, 800, 600);
    expect(range.offsetX).toBe(-50);
    expect(range.offsetY).toBe(-10);
  });

  it("clamps end row to grid bounds", () => {
    const range = scrollToVisibleRange(0, 0, config, 800, 60000);
    expect(range.endRow).toBeLessThanOrEqual(99);
  });
});

// ============================================================================
// calculateScrollDelta
// ============================================================================

describe("calculateScrollDelta", () => {
  const config = makeConfig();
  const viewport = makeViewport({ scrollX: 100, scrollY: 200 });

  it("scrolls down by one cell height", () => {
    const { deltaX, deltaY } = calculateScrollDelta("down", "cell", config, viewport, 800, 600);
    expect(deltaX).toBe(0);
    expect(deltaY).toBe(24);
  });

  it("scrolls up by one cell height", () => {
    const { deltaY } = calculateScrollDelta("up", "cell", config, viewport, 800, 600);
    expect(deltaY).toBe(-24);
  });

  it("scrolls right by one cell width", () => {
    const { deltaX } = calculateScrollDelta("right", "cell", config, viewport, 800, 600);
    expect(deltaX).toBe(80);
  });

  it("page scroll moves by multiple cells", () => {
    const { deltaY } = calculateScrollDelta("down", "page", config, viewport, 800, 600);
    expect(deltaY).toBeGreaterThan(24);
  });

  it("document scroll up returns to origin", () => {
    const { deltaY } = calculateScrollDelta("up", "document", config, viewport, 800, 600);
    expect(deltaY).toBe(-200); // back to scrollY=0
  });
});

// ============================================================================
// thumbPositionToScroll
// ============================================================================

describe("thumbPositionToScroll", () => {
  it("returns 0 when thumb is at start", () => {
    expect(thumbPositionToScroll(0, 50, 300, 2000, 600)).toBe(0);
  });

  it("returns max scroll when thumb is at end", () => {
    const thumbRange = 300 - 50; // 250
    const scrollRange = 2000 - 600; // 1400
    expect(thumbPositionToScroll(250, 50, 300, 2000, 600)).toBeCloseTo(1400, 0);
  });

  it("returns 0 when content fits in viewport", () => {
    expect(thumbPositionToScroll(50, 100, 300, 200, 600)).toBe(0);
  });

  it("returns 0 when thumb range is 0", () => {
    expect(thumbPositionToScroll(0, 300, 300, 2000, 600)).toBe(0);
  });
});

// ============================================================================
// scrollToMakeVisible
// ============================================================================

describe("scrollToMakeVisible", () => {
  const config = makeConfig();

  it("returns null when cell is already visible", () => {
    const viewport = makeViewport({ scrollX: 0, scrollY: 0 });
    const result = scrollToMakeVisible(2, 2, viewport, config, 800, 600);
    expect(result).toBeNull();
  });

  it("scrolls down when cell is below viewport", () => {
    const viewport = makeViewport({ scrollX: 0, scrollY: 0 });
    const result = scrollToMakeVisible(50, 0, viewport, config, 800, 600);
    expect(result).not.toBeNull();
    expect(result!.scrollY).toBeGreaterThan(0);
  });

  it("scrolls right when cell is beyond viewport", () => {
    const viewport = makeViewport({ scrollX: 0, scrollY: 0 });
    const result = scrollToMakeVisible(0, 20, viewport, config, 800, 600);
    expect(result).not.toBeNull();
    expect(result!.scrollX).toBeGreaterThan(0);
  });

  it("scrolls left when cell is before viewport", () => {
    const viewport = makeViewport({ scrollX: 800, scrollY: 0 });
    const result = scrollToMakeVisible(0, 0, viewport, config, 800, 600);
    expect(result).not.toBeNull();
    expect(result!.scrollX).toBe(0);
  });
});

// ============================================================================
// isCellVisible
// ============================================================================

describe("isCellVisible", () => {
  const config = makeConfig();

  it("returns true for cell at origin with no scroll", () => {
    expect(isCellVisible(0, 0, makeViewport(), config, 800, 600)).toBe(true);
  });

  it("returns false for cell far below viewport", () => {
    expect(isCellVisible(99, 0, makeViewport(), config, 800, 600)).toBe(false);
  });

  it("returns true for cell that becomes visible after scroll", () => {
    const viewport = makeViewport({ scrollX: 0, scrollY: 90 * 24 });
    expect(isCellVisible(92, 0, viewport, config, 800, 600)).toBe(true);
  });
});
