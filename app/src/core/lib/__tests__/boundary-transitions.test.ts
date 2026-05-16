//! FILENAME: app/src/core/lib/__tests__/boundary-transitions.test.ts
// PURPOSE: Tests targeting exact boundary transitions where behavior changes
//          at a threshold value in scrolling, visibility, and positioning.

import { describe, it, expect } from "vitest";
import {
  scrollToVisibleRange,
  calculateScrollbarMetrics,
  isCellVisible,
  getColumnXPosition,
  calculateScrollDelta,
  SCROLLBAR_WIDTH,
  SCROLLBAR_HEIGHT,
} from "../scrollUtils";
import type { GridConfig, Viewport, DimensionOverrides } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeConfig(overrides: Partial<GridConfig> = {}): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 25,
    rowHeaderWidth: 50,
    colHeaderHeight: 30,
    totalRows: 1000,
    totalCols: 100,
    minColumnWidth: 20,
    minRowHeight: 10,
    outlineBarWidth: 0,
    ...overrides,
  } as GridConfig;
}

function makeViewport(overrides: Partial<Viewport> = {}): Viewport {
  return {
    startRow: 0,
    startCol: 0,
    rowCount: 20,
    colCount: 10,
    scrollX: 0,
    scrollY: 0,
    ...overrides,
  };
}

function makeDimensions(overrides: Partial<DimensionOverrides> = {}): DimensionOverrides {
  return {
    columnWidths: new Map(),
    rowHeights: new Map(),
    ...overrides,
  };
}

// ============================================================================
// scrollToVisibleRange: row transition boundary
// ============================================================================

describe("scrollToVisibleRange: row transition boundaries", () => {
  const config = makeConfig();
  const vpWidth = 800;
  const vpHeight = 600;

  it("scrollY=0 starts at row 0", () => {
    const range = scrollToVisibleRange(0, 0, config, vpWidth, vpHeight);
    expect(range.startRow).toBe(0);
    expect(range.offsetY + 0).toBe(0); // -(0 % 25) produces -0
  });

  it("scrollY just below one row height stays at row 0 with sub-pixel offset", () => {
    const range = scrollToVisibleRange(0, 24, config, vpWidth, vpHeight);
    expect(range.startRow).toBe(0);
    expect(range.offsetY).toBe(-24);
  });

  it("scrollY exactly at row height transitions to row 1 with zero offset", () => {
    const range = scrollToVisibleRange(0, 25, config, vpWidth, vpHeight);
    expect(range.startRow).toBe(1);
    expect(range.offsetY + 0).toBe(0); // -(25 % 25) produces -0
  });

  it("scrollY one pixel past row height is row 1 with -1 offset", () => {
    const range = scrollToVisibleRange(0, 26, config, vpWidth, vpHeight);
    expect(range.startRow).toBe(1);
    expect(range.offsetY).toBe(-1);
  });

  it("column transition at exact boundary", () => {
    const range = scrollToVisibleRange(100, 0, config, vpWidth, vpHeight);
    expect(range.startCol).toBe(1);
    expect(range.offsetX + 0).toBe(0); // -(100 % 100) produces -0
  });

  it("column transition one pixel before boundary stays at col 0", () => {
    const range = scrollToVisibleRange(99, 0, config, vpWidth, vpHeight);
    expect(range.startCol).toBe(0);
    expect(range.offsetX).toBe(-99);
  });
});

// ============================================================================
// calculateScrollbarMetrics: thumb at 0%, 50%, 100%
// ============================================================================

describe("calculateScrollbarMetrics: thumb at percentage positions", () => {
  const config = makeConfig({ totalRows: 100, totalCols: 20 });
  const vpWidth = 800;
  const vpHeight = 600;

  it("thumb at 0% when scrolled to top-left", () => {
    const vp = makeViewport({ scrollX: 0, scrollY: 0 });
    const metrics = calculateScrollbarMetrics(config, vp, vpWidth, vpHeight);
    expect(metrics.vertical.thumbPosition).toBe(0);
    expect(metrics.horizontal.thumbPosition).toBe(0);
  });

  it("thumb at 100% when scrolled to maximum", () => {
    // Content: 100 rows * 25 = 2500, viewport available height = 600 - 30 - 17 = 553
    // maxScrollY = 2500 - 553 = 1947
    const contentHeight = 100 * 25;
    const viewHeight = vpHeight - config.colHeaderHeight - SCROLLBAR_HEIGHT;
    const maxScrollY = contentHeight - viewHeight;

    const vp = makeViewport({ scrollX: 0, scrollY: maxScrollY });
    const metrics = calculateScrollbarMetrics(config, vp, vpWidth, vpHeight);

    // At max scroll, thumb should be at end of track (trackSize - thumbSize)
    const expectedThumbRange = metrics.vertical.trackSize - metrics.vertical.thumbSize;
    expect(metrics.vertical.thumbPosition).toBeCloseTo(expectedThumbRange, 1);
  });

  it("thumb at ~50% when scrolled to middle", () => {
    const contentHeight = 100 * 25;
    const viewHeight = vpHeight - config.colHeaderHeight - SCROLLBAR_HEIGHT;
    const maxScrollY = contentHeight - viewHeight;
    const midScroll = maxScrollY / 2;

    const vp = makeViewport({ scrollY: midScroll });
    const metrics = calculateScrollbarMetrics(config, vp, vpWidth, vpHeight);

    const expectedThumbRange = metrics.vertical.trackSize - metrics.vertical.thumbSize;
    expect(metrics.vertical.thumbPosition).toBeCloseTo(expectedThumbRange / 2, 1);
  });
});

// ============================================================================
// isCellVisible: boundary cells around visible range
// ============================================================================

describe("isCellVisible: cells at exact range boundaries", () => {
  const config = makeConfig();
  const vpWidth = 800;
  const vpHeight = 600;

  // With scrollY=0, the visible range starts at row 0.
  // Available height = 600 - 30 - 17 = 553, visibleRows = ceil(553/25) + 1 = 23 + 1 = 24
  // endRow = min(0 + 24, 999) = 24

  it("cell at startRow (0) is visible", () => {
    const vp = makeViewport({ scrollX: 0, scrollY: 0 });
    expect(isCellVisible(0, 0, vp, config, vpWidth, vpHeight)).toBe(true);
  });

  it("cell at endRow is visible", () => {
    const vp = makeViewport({ scrollX: 0, scrollY: 0 });
    const range = scrollToVisibleRange(0, 0, config, vpWidth, vpHeight);
    expect(isCellVisible(range.endRow, 0, vp, config, vpWidth, vpHeight)).toBe(true);
  });

  it("cell at endRow+1 is NOT visible", () => {
    const vp = makeViewport({ scrollX: 0, scrollY: 0 });
    const range = scrollToVisibleRange(0, 0, config, vpWidth, vpHeight);
    expect(isCellVisible(range.endRow + 1, 0, vp, config, vpWidth, vpHeight)).toBe(false);
  });

  it("cell at startRow-1 when scrolled down is NOT visible", () => {
    // Scroll down so startRow = 5
    const scrollY = 5 * config.defaultCellHeight;
    const vp = makeViewport({ scrollX: 0, scrollY });
    const range = scrollToVisibleRange(0, scrollY, config, vpWidth, vpHeight);
    expect(range.startRow).toBe(5);
    expect(isCellVisible(4, 0, vp, config, vpWidth, vpHeight)).toBe(false);
  });

  it("column at startCol is visible, startCol-1 is not", () => {
    const scrollX = 3 * config.defaultCellWidth;
    const vp = makeViewport({ scrollX, scrollY: 0 });
    expect(isCellVisible(0, 3, vp, config, vpWidth, vpHeight)).toBe(true);
    expect(isCellVisible(0, 2, vp, config, vpWidth, vpHeight)).toBe(false);
  });
});

// ============================================================================
// getColumnXPosition: before/after hidden column
// ============================================================================

describe("getColumnXPosition: hidden column boundary", () => {
  const config = makeConfig();

  it("column before hidden has normal position", () => {
    const dims = makeDimensions({ hiddenCols: new Set([3]) });
    // col 2 is before hidden col 3 => 2 * 100 = 200
    expect(getColumnXPosition(2, config, dims)).toBe(200);
  });

  it("column after hidden column shifts left by one default width", () => {
    const dims = makeDimensions({ hiddenCols: new Set([3]) });
    // col 4 without hidden: 4 * 100 = 400. With col 3 hidden: 400 - 100 = 300
    expect(getColumnXPosition(4, config, dims)).toBe(300);
  });

  it("the hidden column itself has position as if preceding cols exist but it is zero-width", () => {
    const dims = makeDimensions({ hiddenCols: new Set([3]) });
    // col 3 position: base = 3*100=300, minus hidden col 3 which is < 3? No, 3 is not < 3.
    // So position of col 3 itself = 300 (it exists but has 0 width)
    expect(getColumnXPosition(3, config, dims)).toBe(300);
  });

  it("two adjacent hidden columns shift subsequent columns by two widths", () => {
    const dims = makeDimensions({ hiddenCols: new Set([3, 4]) });
    // col 5: base = 500, minus 2 * 100 = 300
    expect(getColumnXPosition(5, config, dims)).toBe(300);
  });

  it("custom-width hidden column subtracts custom width, not default", () => {
    const dims = makeDimensions({
      columnWidths: new Map([[3, 200]]),
      hiddenCols: new Set([3]),
    });
    // col 4: base = 400, +adjustment for col 3 custom (200-100=+100), then undo for hidden (-200)
    // = 400 + 100 - 200 = 300
    expect(getColumnXPosition(4, config, dims)).toBe(300);
  });
});

// ============================================================================
// calculateScrollDelta: cell-unit scroll at viewport edge
// ============================================================================

describe("calculateScrollDelta: cell-unit navigation", () => {
  const config = makeConfig();
  const vpWidth = 800;
  const vpHeight = 600;

  it("scroll down by one cell returns exactly defaultCellHeight", () => {
    const vp = makeViewport({ scrollX: 0, scrollY: 0 });
    const delta = calculateScrollDelta("down", "cell", config, vp, vpWidth, vpHeight);
    expect(delta.deltaY).toBe(config.defaultCellHeight);
    expect(delta.deltaX).toBe(0);
  });

  it("scroll up by one cell returns negative defaultCellHeight", () => {
    const vp = makeViewport({ scrollX: 0, scrollY: 100 });
    const delta = calculateScrollDelta("up", "cell", config, vp, vpWidth, vpHeight);
    expect(delta.deltaY).toBe(-config.defaultCellHeight);
  });

  it("scroll right by one cell returns exactly defaultCellWidth", () => {
    const vp = makeViewport({ scrollX: 0, scrollY: 0 });
    const delta = calculateScrollDelta("right", "cell", config, vp, vpWidth, vpHeight);
    expect(delta.deltaX).toBe(config.defaultCellWidth);
    expect(delta.deltaY).toBe(0);
  });

  it("document-up from scrollY=0 returns deltaY=0", () => {
    const vp = makeViewport({ scrollX: 0, scrollY: 0 });
    const delta = calculateScrollDelta("up", "document", config, vp, vpWidth, vpHeight);
    expect(delta.deltaY + 0).toBe(0); // -scrollY when scrollY=0 gives -0
  });

  it("document-left from scrollX=0 returns deltaX=0", () => {
    const vp = makeViewport({ scrollX: 0, scrollY: 0 });
    const delta = calculateScrollDelta("left", "document", config, vp, vpWidth, vpHeight);
    expect(delta.deltaX + 0).toBe(0); // -scrollX when scrollX=0 gives -0
  });
});
