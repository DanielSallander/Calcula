import { describe, it, expect } from "vitest";
import type { GridConfig, Viewport, DimensionOverrides } from "../types";
import {
  getColumnWidthFromDimensions,
  getRowHeightFromDimensions,
  getColumnXPosition,
  getRowYPosition,
  calculateMaxScroll,
  clampScroll,
  scrollToVisibleRange,
  cellToScroll,
  cellToCenteredScroll,
  calculateScrollDelta,
  isCellVisible,
  scrollToMakeVisible,
  thumbPositionToScroll,
  SCROLLBAR_WIDTH,
  SCROLLBAR_HEIGHT,
} from "./scrollUtils";

// ============================================================================
// Test Helpers
// ============================================================================

function createTestConfig(overrides?: Partial<GridConfig>): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 25,
    rowHeaderWidth: 50,
    colHeaderHeight: 30,
    totalRows: 1000,
    totalCols: 100,
    minColumnWidth: 20,
    minRowHeight: 10,
    ...overrides,
  } as GridConfig;
}

function createDimensions(overrides?: Partial<DimensionOverrides>): DimensionOverrides {
  return {
    columnWidths: new Map(),
    rowHeights: new Map(),
    ...overrides,
  };
}

function createViewport(overrides?: Partial<Viewport>): Viewport {
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

// ============================================================================
// Tests
// ============================================================================

describe("getColumnWidthFromDimensions", () => {
  const config = createTestConfig();

  it("returns default width when no overrides", () => {
    expect(getColumnWidthFromDimensions(5, config)).toBe(100);
  });

  it("returns custom width from overrides", () => {
    const dims = createDimensions({ columnWidths: new Map([[5, 200]]) });
    expect(getColumnWidthFromDimensions(5, config, dims)).toBe(200);
  });

  it("returns 0 for hidden columns", () => {
    const dims = createDimensions({ hiddenCols: new Set([3]) });
    expect(getColumnWidthFromDimensions(3, config, dims)).toBe(0);
  });

  it("returns default for non-overridden column", () => {
    const dims = createDimensions({ columnWidths: new Map([[2, 150]]) });
    expect(getColumnWidthFromDimensions(5, config, dims)).toBe(100);
  });
});

describe("getRowHeightFromDimensions", () => {
  const config = createTestConfig();

  it("returns default height when no overrides", () => {
    expect(getRowHeightFromDimensions(5, config)).toBe(25);
  });

  it("returns custom height from overrides", () => {
    const dims = createDimensions({ rowHeights: new Map([[5, 50]]) });
    expect(getRowHeightFromDimensions(5, config, dims)).toBe(50);
  });

  it("returns 0 for hidden rows", () => {
    const dims = createDimensions({ hiddenRows: new Set([3]) });
    expect(getRowHeightFromDimensions(3, config, dims)).toBe(0);
  });
});

describe("getColumnXPosition", () => {
  const config = createTestConfig();

  it("calculates position with default widths (fast path)", () => {
    expect(getColumnXPosition(0, config)).toBe(0);
    expect(getColumnXPosition(1, config)).toBe(100);
    expect(getColumnXPosition(5, config)).toBe(500);
  });

  it("adjusts for custom column width before target", () => {
    const dims = createDimensions({ columnWidths: new Map([[2, 200]]) });
    // Col 5 = 5 * 100 + (200 - 100) = 600
    expect(getColumnXPosition(5, config, dims)).toBe(600);
  });

  it("ignores custom width at or after target", () => {
    const dims = createDimensions({ columnWidths: new Map([[5, 200]]) });
    // Col 3 should be unaffected
    expect(getColumnXPosition(3, config, dims)).toBe(300);
  });

  it("subtracts width for hidden columns before target", () => {
    const dims = createDimensions({ hiddenCols: new Set([2]) });
    // Col 5 = 5 * 100 - 100 = 400
    expect(getColumnXPosition(5, config, dims)).toBe(400);
  });

  it("handles hidden column with custom width", () => {
    const dims = createDimensions({
      columnWidths: new Map([[2, 200]]),
      hiddenCols: new Set([2]),
    });
    // Col 5 = 5 * 100 + (200-100) - 200 = 400
    expect(getColumnXPosition(5, config, dims)).toBe(400);
  });
});

describe("getRowYPosition", () => {
  const config = createTestConfig();

  it("calculates position with default heights", () => {
    expect(getRowYPosition(0, config)).toBe(0);
    expect(getRowYPosition(4, config)).toBe(100);
  });

  it("adjusts for custom row height before target", () => {
    const dims = createDimensions({ rowHeights: new Map([[1, 50]]) });
    // Row 4 = 4 * 25 + (50 - 25) = 125
    expect(getRowYPosition(4, config, dims)).toBe(125);
  });

  it("subtracts height for hidden rows before target", () => {
    const dims = createDimensions({ hiddenRows: new Set([1]) });
    // Row 4 = 4 * 25 - 25 = 75
    expect(getRowYPosition(4, config, dims)).toBe(75);
  });
});

describe("calculateMaxScroll", () => {
  it("calculates max scroll for default grid", () => {
    const config = createTestConfig();
    const vpWidth = 1000;
    const vpHeight = 600;
    const { maxScrollX, maxScrollY } = calculateMaxScroll(config, vpWidth, vpHeight);

    const availableWidth = vpWidth - config.rowHeaderWidth - SCROLLBAR_WIDTH;
    const availableHeight = vpHeight - config.colHeaderHeight - SCROLLBAR_HEIGHT;
    const totalContentWidth = config.totalCols * config.defaultCellWidth;
    const totalContentHeight = config.totalRows * config.defaultCellHeight;

    expect(maxScrollX).toBe(totalContentWidth - availableWidth);
    expect(maxScrollY).toBe(totalContentHeight - availableHeight);
  });

  it("returns 0 when viewport is larger than content", () => {
    const config = createTestConfig({ totalRows: 5, totalCols: 3 });
    const { maxScrollX, maxScrollY } = calculateMaxScroll(config, 2000, 2000);
    expect(maxScrollX).toBe(0);
    expect(maxScrollY).toBe(0);
  });
});

describe("clampScroll", () => {
  const config = createTestConfig();
  const vpWidth = 1000;
  const vpHeight = 600;

  it("clamps negative scroll to 0", () => {
    const result = clampScroll(-100, -50, config, vpWidth, vpHeight);
    expect(result.scrollX).toBe(0);
    expect(result.scrollY).toBe(0);
  });

  it("clamps excessive scroll to max", () => {
    const { maxScrollX, maxScrollY } = calculateMaxScroll(config, vpWidth, vpHeight);
    const result = clampScroll(999999, 999999, config, vpWidth, vpHeight);
    expect(result.scrollX).toBe(maxScrollX);
    expect(result.scrollY).toBe(maxScrollY);
  });

  it("passes through valid scroll values", () => {
    const result = clampScroll(500, 300, config, vpWidth, vpHeight);
    expect(result.scrollX).toBe(500);
    expect(result.scrollY).toBe(300);
  });

  it("calculates startRow and startCol from scroll position", () => {
    const result = clampScroll(250, 100, config, vpWidth, vpHeight);
    expect(result.startCol).toBe(Math.floor(250 / 100)); // 2
    expect(result.startRow).toBe(Math.floor(100 / 25));   // 4
  });
});

describe("scrollToVisibleRange", () => {
  const config = createTestConfig();
  const vpWidth = 1000;
  const vpHeight = 600;

  it("calculates visible range at origin", () => {
    const range = scrollToVisibleRange(0, 0, config, vpWidth, vpHeight);
    expect(range.startRow).toBe(0);
    expect(range.startCol).toBe(0);
    expect(range.offsetX).toBe(-0);
    expect(range.offsetY).toBe(-0);
    expect(range.endRow).toBeGreaterThan(0);
    expect(range.endCol).toBeGreaterThan(0);
  });

  it("calculates sub-cell offset for smooth scrolling", () => {
    const range = scrollToVisibleRange(150, 37, config, vpWidth, vpHeight);
    expect(range.offsetX).toBe(-50); // -(150 % 100)
    expect(range.offsetY).toBe(-12); // -(37 % 25)
    expect(range.startCol).toBe(1);  // floor(150/100)
    expect(range.startRow).toBe(1);  // floor(37/25)
  });

  it("clamps end indices to grid bounds", () => {
    const smallConfig = createTestConfig({ totalRows: 5, totalCols: 3 });
    const range = scrollToVisibleRange(0, 0, smallConfig, vpWidth, vpHeight);
    expect(range.endRow).toBe(4);   // max row index
    expect(range.endCol).toBe(2);   // max col index
  });
});

describe("cellToScroll", () => {
  const config = createTestConfig();

  it("returns origin for cell (0,0)", () => {
    const result = cellToScroll(0, 0, config);
    expect(result.scrollX).toBe(0);
    expect(result.scrollY).toBe(0);
  });

  it("converts cell coords to scroll position", () => {
    const result = cellToScroll(10, 5, config);
    expect(result.scrollX).toBe(500); // 5 * 100
    expect(result.scrollY).toBe(250); // 10 * 25
  });

  it("accounts for custom dimensions", () => {
    const dims = createDimensions({
      columnWidths: new Map([[2, 200]]),
      rowHeights: new Map([[3, 50]]),
    });
    const result = cellToScroll(10, 5, config, dims);
    expect(result.scrollX).toBe(600); // 5*100 + (200-100)
    expect(result.scrollY).toBe(275); // 10*25 + (50-25)
  });
});

describe("cellToCenteredScroll", () => {
  const config = createTestConfig();
  const vpWidth = 1000;
  const vpHeight = 600;

  it("centers the cell in the viewport", () => {
    const result = cellToCenteredScroll(10, 5, config, vpWidth, vpHeight);
    const cellX = 500; // 5 * 100
    const cellY = 250; // 10 * 25
    const availW = vpWidth - config.rowHeaderWidth - SCROLLBAR_WIDTH;
    const availH = vpHeight - config.colHeaderHeight - SCROLLBAR_HEIGHT;
    expect(result.scrollX).toBe(cellX - availW / 2 + 100 / 2);
    expect(result.scrollY).toBe(cellY - availH / 2 + 25 / 2);
  });
});

describe("calculateScrollDelta", () => {
  const config = createTestConfig();
  const vpWidth = 1000;
  const vpHeight = 600;
  const viewport = createViewport({ scrollX: 500, scrollY: 250 });

  it("scrolls by one cell", () => {
    expect(calculateScrollDelta("down", "cell", config, viewport, vpWidth, vpHeight)).toEqual({ deltaX: 0, deltaY: 25 });
    expect(calculateScrollDelta("up", "cell", config, viewport, vpWidth, vpHeight)).toEqual({ deltaX: 0, deltaY: -25 });
    expect(calculateScrollDelta("right", "cell", config, viewport, vpWidth, vpHeight)).toEqual({ deltaX: 100, deltaY: 0 });
    expect(calculateScrollDelta("left", "cell", config, viewport, vpWidth, vpHeight)).toEqual({ deltaX: -100, deltaY: 0 });
  });

  it("scrolls by page", () => {
    const result = calculateScrollDelta("down", "page", config, viewport, vpWidth, vpHeight);
    const availH = vpHeight - config.colHeaderHeight - SCROLLBAR_HEIGHT;
    const pageRows = Math.max(1, Math.floor(availH / 25) - 1);
    expect(result.deltaY).toBe(pageRows * 25);
    expect(result.deltaX).toBe(0);
  });

  it("scrolls to document start", () => {
    const result = calculateScrollDelta("up", "document", config, viewport, vpWidth, vpHeight);
    expect(result.deltaY).toBe(-250); // -viewport.scrollY
    expect(result.deltaX).toBe(0);
  });

  it("scrolls to document end", () => {
    const result = calculateScrollDelta("down", "document", config, viewport, vpWidth, vpHeight);
    expect(result.deltaY).toBe(1000 * 25 - 250); // totalRows * h - scrollY
  });
});

describe("isCellVisible", () => {
  const config = createTestConfig();
  const vpWidth = 1000;
  const vpHeight = 600;

  it("returns true for cell at origin when scroll is 0", () => {
    const vp = createViewport();
    expect(isCellVisible(0, 0, vp, config, vpWidth, vpHeight)).toBe(true);
  });

  it("returns false for cell far outside viewport", () => {
    const vp = createViewport();
    expect(isCellVisible(999, 99, vp, config, vpWidth, vpHeight)).toBe(false);
  });

  it("returns true for cell within scrolled viewport", () => {
    const vp = createViewport({ scrollX: 500, scrollY: 250 });
    expect(isCellVisible(12, 6, vp, config, vpWidth, vpHeight)).toBe(true);
  });
});

describe("scrollToMakeVisible", () => {
  const config = createTestConfig();
  const vpWidth = 1000;
  const vpHeight = 600;

  it("returns null if cell is already visible", () => {
    const vp = createViewport();
    const result = scrollToMakeVisible(2, 2, vp, config, vpWidth, vpHeight);
    expect(result).toBeNull();
  });

  it("scrolls right to show a cell off-screen to the right", () => {
    const vp = createViewport();
    const result = scrollToMakeVisible(0, 50, vp, config, vpWidth, vpHeight);
    expect(result).not.toBeNull();
    expect(result!.scrollX).toBeGreaterThan(0);
  });

  it("scrolls down to show a cell off-screen below", () => {
    const vp = createViewport();
    const result = scrollToMakeVisible(50, 0, vp, config, vpWidth, vpHeight);
    expect(result).not.toBeNull();
    expect(result!.scrollY).toBeGreaterThan(0);
  });

  it("scrolls left to show a cell off-screen to the left", () => {
    const vp = createViewport({ scrollX: 500 });
    const result = scrollToMakeVisible(0, 0, vp, config, vpWidth, vpHeight);
    expect(result).not.toBeNull();
    expect(result!.scrollX).toBe(0);
  });
});

describe("thumbPositionToScroll", () => {
  it("returns 0 when thumb is at start", () => {
    expect(thumbPositionToScroll(0, 50, 500, 10000, 1000)).toBe(0);
  });

  it("returns max scroll when thumb is at end", () => {
    const thumbSize = 50;
    const trackSize = 500;
    const contentSize = 10000;
    const vpSize = 1000;
    const thumbRange = trackSize - thumbSize;
    const result = thumbPositionToScroll(thumbRange, thumbSize, trackSize, contentSize, vpSize);
    expect(result).toBe(contentSize - vpSize);
  });

  it("returns 0 when content fits viewport", () => {
    expect(thumbPositionToScroll(100, 50, 500, 500, 1000)).toBe(0);
  });

  it("returns 0 when thumb fills track", () => {
    expect(thumbPositionToScroll(0, 500, 500, 10000, 1000)).toBe(0);
  });
});
