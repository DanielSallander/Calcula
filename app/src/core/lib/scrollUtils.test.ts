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
  calculateScrollbarMetrics,
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

  it("returns proportional scroll for mid-track position", () => {
    const thumbSize = 50;
    const trackSize = 500;
    const contentSize = 10000;
    const vpSize = 1000;
    const thumbRange = trackSize - thumbSize; // 450
    const scrollRange = contentSize - vpSize; // 9000
    // thumb at 50% of range
    const midPos = thumbRange / 2; // 225
    const result = thumbPositionToScroll(midPos, thumbSize, trackSize, contentSize, vpSize);
    expect(result).toBe(scrollRange / 2); // 4500
  });
});

// ============================================================================
// Additional Edge Case Tests
// ============================================================================

describe("calculateScrollbarMetrics", () => {
  const config = createTestConfig();
  const vpWidth = 1000;
  const vpHeight = 600;

  it("computes thumb sizes proportional to viewport/content ratio", () => {
    const vp = createViewport();
    const metrics = calculateScrollbarMetrics(config, vp, vpWidth, vpHeight);

    const contentWidth = config.totalCols * config.defaultCellWidth; // 10000
    const viewWidth = vpWidth - config.rowHeaderWidth - SCROLLBAR_WIDTH;
    const expectedHThumb = Math.max(30, (viewWidth / contentWidth) * viewWidth);

    expect(metrics.horizontal.thumbSize).toBe(expectedHThumb);
    expect(metrics.horizontal.trackSize).toBe(viewWidth);
  });

  it("returns thumb position 0 when scroll is at origin", () => {
    const vp = createViewport({ scrollX: 0, scrollY: 0 });
    const metrics = calculateScrollbarMetrics(config, vp, vpWidth, vpHeight);
    expect(metrics.horizontal.thumbPosition).toBe(0);
    expect(metrics.vertical.thumbPosition).toBe(0);
  });

  it("returns non-zero thumb position when scrolled", () => {
    const vp = createViewport({ scrollX: 500, scrollY: 250 });
    const metrics = calculateScrollbarMetrics(config, vp, vpWidth, vpHeight);
    expect(metrics.horizontal.thumbPosition).toBeGreaterThan(0);
    expect(metrics.vertical.thumbPosition).toBeGreaterThan(0);
  });

  it("enforces minimum thumb size of 30px", () => {
    // Very large grid -> tiny ratio -> thumb clamped to 30
    const bigConfig = createTestConfig({ totalRows: 1_000_000, totalCols: 16384 });
    const vp = createViewport();
    const metrics = calculateScrollbarMetrics(bigConfig, vp, vpWidth, vpHeight);
    expect(metrics.horizontal.thumbSize).toBe(30);
    expect(metrics.vertical.thumbSize).toBe(30);
  });

  it("handles viewport larger than content (no scrolling needed)", () => {
    const tinyConfig = createTestConfig({ totalRows: 5, totalCols: 3 });
    const vp = createViewport();
    const metrics = calculateScrollbarMetrics(tinyConfig, vp, vpWidth, vpHeight);
    // Thumb should be >= track size (content fits)
    expect(metrics.vertical.thumbPosition).toBe(0);
    expect(metrics.horizontal.thumbPosition).toBe(0);
  });
});

describe("cellToScroll - edge cases", () => {
  const config = createTestConfig();

  it("handles very large row index (1M rows)", () => {
    const bigConfig = createTestConfig({ totalRows: 1_000_000 });
    const result = cellToScroll(999_999, 0, bigConfig);
    expect(result.scrollY).toBe(999_999 * 25);
  });

  it("handles cell at row 0 col 0 with custom dimensions on other cells", () => {
    const dims = createDimensions({
      columnWidths: new Map([[5, 300]]),
      rowHeights: new Map([[10, 80]]),
    });
    const result = cellToScroll(0, 0, config, dims);
    expect(result.scrollX).toBe(0);
    expect(result.scrollY).toBe(0);
  });

  it("handles multiple custom column widths before target", () => {
    const dims = createDimensions({
      columnWidths: new Map([
        [1, 200],
        [3, 150],
        [4, 50],
      ]),
    });
    const result = cellToScroll(0, 6, config, dims);
    // base: 6*100 = 600, adjustments: (200-100)+(150-100)+(50-100) = 100+50-50 = 100
    expect(result.scrollX).toBe(700);
  });
});

describe("cellToCenteredScroll - edge cases", () => {
  const config = createTestConfig();
  const vpWidth = 1000;
  const vpHeight = 600;

  it("may return negative scroll values for cells near origin", () => {
    const result = cellToCenteredScroll(0, 0, config, vpWidth, vpHeight);
    // Cell (0,0) is at pixel (0,0). Centering will produce negative scroll values
    expect(result.scrollX).toBeLessThan(0);
    expect(result.scrollY).toBeLessThan(0);
  });

  it("centers cell with custom dimensions", () => {
    const dims = createDimensions({ columnWidths: new Map([[5, 300]]) });
    const result = cellToCenteredScroll(0, 5, config, vpWidth, vpHeight, dims);
    const cellX = getColumnXPosition(5, config, dims); // 500
    const cellW = 300;
    const availW = vpWidth - config.rowHeaderWidth - SCROLLBAR_WIDTH;
    expect(result.scrollX).toBe(cellX - availW / 2 + cellW / 2);
  });
});

describe("calculateScrollDelta - additional directions and units", () => {
  const config = createTestConfig();
  const vpWidth = 1000;
  const vpHeight = 600;

  it("page left scrolls by visible columns minus one", () => {
    const vp = createViewport({ scrollX: 500, scrollY: 0 });
    const result = calculateScrollDelta("left", "page", config, vp, vpWidth, vpHeight);
    const availW = vpWidth - config.rowHeaderWidth - SCROLLBAR_WIDTH;
    const pageCols = Math.max(1, Math.floor(availW / config.defaultCellWidth) - 1);
    expect(result.deltaX).toBe(-pageCols * config.defaultCellWidth);
    expect(result.deltaY).toBe(0);
  });

  it("page right scrolls by visible columns minus one", () => {
    const vp = createViewport({ scrollX: 0, scrollY: 0 });
    const result = calculateScrollDelta("right", "page", config, vp, vpWidth, vpHeight);
    const availW = vpWidth - config.rowHeaderWidth - SCROLLBAR_WIDTH;
    const pageCols = Math.max(1, Math.floor(availW / config.defaultCellWidth) - 1);
    expect(result.deltaX).toBe(pageCols * config.defaultCellWidth);
  });

  it("document left returns negative of current scrollX", () => {
    const vp = createViewport({ scrollX: 800, scrollY: 0 });
    const result = calculateScrollDelta("left", "document", config, vp, vpWidth, vpHeight);
    expect(result.deltaX).toBe(-800);
    expect(result.deltaY).toBe(0);
  });

  it("document right scrolls to the end of column range", () => {
    const vp = createViewport({ scrollX: 200, scrollY: 0 });
    const result = calculateScrollDelta("right", "document", config, vp, vpWidth, vpHeight);
    expect(result.deltaX).toBe(config.totalCols * config.defaultCellWidth - 200);
  });

  it("cell scroll with zero scroll position", () => {
    const vp = createViewport({ scrollX: 0, scrollY: 0 });
    const down = calculateScrollDelta("down", "cell", config, vp, vpWidth, vpHeight);
    expect(down).toEqual({ deltaX: 0, deltaY: 25 });
  });
});

describe("isCellVisible - edge cases", () => {
  const config = createTestConfig();
  const vpWidth = 1000;
  const vpHeight = 600;

  it("returns true for cells at the very edge of the visible range", () => {
    const vp = createViewport({ scrollX: 0, scrollY: 0 });
    // Calculate the end of the visible range
    const range = scrollToVisibleRange(0, 0, config, vpWidth, vpHeight);
    expect(isCellVisible(range.endRow, range.endCol, vp, config, vpWidth, vpHeight)).toBe(true);
  });

  it("returns false for cell just beyond the visible range", () => {
    const vp = createViewport({ scrollX: 0, scrollY: 0 });
    const range = scrollToVisibleRange(0, 0, config, vpWidth, vpHeight);
    expect(isCellVisible(range.endRow + 1, 0, vp, config, vpWidth, vpHeight)).toBe(false);
    expect(isCellVisible(0, range.endCol + 1, vp, config, vpWidth, vpHeight)).toBe(false);
  });

  it("returns false for cell just before startRow when scrolled", () => {
    const vp = createViewport({ scrollX: 0, scrollY: 250 }); // startRow = 10
    expect(isCellVisible(9, 0, vp, config, vpWidth, vpHeight)).toBe(false);
  });

  it("returns false for cell just before startCol when scrolled", () => {
    const vp = createViewport({ scrollX: 500, scrollY: 0 }); // startCol = 5
    expect(isCellVisible(0, 4, vp, config, vpWidth, vpHeight)).toBe(false);
  });
});

describe("scrollToMakeVisible - additional scenarios", () => {
  const config = createTestConfig();
  const vpWidth = 1000;
  const vpHeight = 600;

  it("scrolls up to show a cell above the viewport", () => {
    const vp = createViewport({ scrollX: 0, scrollY: 500 }); // viewing from row 20
    const result = scrollToMakeVisible(5, 0, vp, config, vpWidth, vpHeight);
    expect(result).not.toBeNull();
    expect(result!.scrollY).toBe(5 * 25); // align top of cell with viewport top
  });

  it("handles cell with custom height that exceeds viewport", () => {
    const dims = createDimensions({ rowHeights: new Map([[10, 1000]]) }); // very tall row
    const vp = createViewport({ scrollX: 0, scrollY: 0 });
    const result = scrollToMakeVisible(10, 0, vp, config, vpWidth, vpHeight, dims);
    expect(result).not.toBeNull();
    // When cell is taller than viewport, scroll to show top edge
    expect(result!.scrollY).toBe(getRowYPosition(10, config, dims));
  });

  it("handles cell with custom width that exceeds viewport", () => {
    const dims = createDimensions({ columnWidths: new Map([[8, 2000]]) }); // very wide col
    const vp = createViewport({ scrollX: 0, scrollY: 0 });
    const result = scrollToMakeVisible(0, 8, vp, config, vpWidth, vpHeight, dims);
    expect(result).not.toBeNull();
    // When cell is wider than viewport, scroll to show left edge
    expect(result!.scrollX).toBe(getColumnXPosition(8, config, dims));
  });

  it("returns null when cell is fully in the center of viewport", () => {
    // Viewport shows rows ~4..25, cols ~1..9
    const vp = createViewport({ scrollX: 100, scrollY: 100 });
    const result = scrollToMakeVisible(8, 3, vp, config, vpWidth, vpHeight);
    expect(result).toBeNull();
  });

  it("scrolls diagonally when cell is off-screen both horizontally and vertically", () => {
    const vp = createViewport({ scrollX: 0, scrollY: 0 });
    const result = scrollToMakeVisible(50, 50, vp, config, vpWidth, vpHeight);
    expect(result).not.toBeNull();
    expect(result!.scrollX).toBeGreaterThan(0);
    expect(result!.scrollY).toBeGreaterThan(0);
  });
});

describe("calculateMaxScroll - edge cases", () => {
  it("accounts for custom column widths in total content width", () => {
    const config = createTestConfig({ totalCols: 10 });
    const dims = createDimensions({ columnWidths: new Map([[0, 300]]) }); // +200 extra
    const vpWidth = 500;
    const vpHeight = 500;

    const withDims = calculateMaxScroll(config, vpWidth, vpHeight, dims);
    const withoutDims = calculateMaxScroll(config, vpWidth, vpHeight);
    expect(withDims.maxScrollX).toBe(withoutDims.maxScrollX + 200);
  });

  it("accounts for hidden columns reducing content width", () => {
    const config = createTestConfig({ totalCols: 10 });
    const dims = createDimensions({ hiddenCols: new Set([0, 1]) });
    const vpWidth = 500;
    const vpHeight = 500;

    const withHidden = calculateMaxScroll(config, vpWidth, vpHeight, dims);
    const withoutHidden = calculateMaxScroll(config, vpWidth, vpHeight);
    expect(withHidden.maxScrollX).toBe(
      Math.max(0, withoutHidden.maxScrollX - 2 * config.defaultCellWidth)
    );
  });

  it("accounts for hidden rows reducing content height", () => {
    const config = createTestConfig({ totalRows: 100 });
    const dims = createDimensions({ hiddenRows: new Set([0, 1, 2]) });
    const vpWidth = 500;
    const vpHeight = 500;

    const withHidden = calculateMaxScroll(config, vpWidth, vpHeight, dims);
    const withoutHidden = calculateMaxScroll(config, vpWidth, vpHeight);
    expect(withHidden.maxScrollY).toBe(
      Math.max(0, withoutHidden.maxScrollY - 3 * config.defaultCellHeight)
    );
  });

  it("handles 1M rows grid", () => {
    const bigConfig = createTestConfig({ totalRows: 1_000_000 });
    const { maxScrollY } = calculateMaxScroll(bigConfig, 1000, 600);
    const availH = 600 - bigConfig.colHeaderHeight - SCROLLBAR_HEIGHT;
    expect(maxScrollY).toBe(1_000_000 * 25 - availH);
  });
});

describe("clampScroll - edge cases", () => {
  it("handles zero-dimension viewport", () => {
    const config = createTestConfig();
    // viewport size equals just headers + scrollbar -> available = 0
    const vpWidth = config.rowHeaderWidth + SCROLLBAR_WIDTH;
    const vpHeight = config.colHeaderHeight + SCROLLBAR_HEIGHT;
    const result = clampScroll(100, 100, config, vpWidth, vpHeight);
    // maxScroll should be totalContent - 0 = totalContent
    expect(result.scrollX).toBe(100);
    expect(result.scrollY).toBe(100);
  });
});

describe("scrollToVisibleRange - edge cases", () => {
  it("handles scroll at maximum position", () => {
    const config = createTestConfig();
    const vpWidth = 1000;
    const vpHeight = 600;
    const { maxScrollX, maxScrollY } = calculateMaxScroll(config, vpWidth, vpHeight);
    const range = scrollToVisibleRange(maxScrollX, maxScrollY, config, vpWidth, vpHeight);
    // endRow/endCol should be clamped to grid bounds
    expect(range.endRow).toBeLessThanOrEqual(config.totalRows - 1);
    expect(range.endCol).toBeLessThanOrEqual(config.totalCols - 1);
  });

  it("startRow and startCol never go negative", () => {
    const config = createTestConfig();
    // Even though we don't pass negative scroll here, verifying the Math.max(0, ...) works
    const range = scrollToVisibleRange(0, 0, config, 1000, 600);
    expect(range.startRow).toBeGreaterThanOrEqual(0);
    expect(range.startCol).toBeGreaterThanOrEqual(0);
  });
});

describe("getColumnXPosition - multiple hidden and custom columns", () => {
  const config = createTestConfig();

  it("handles multiple hidden columns", () => {
    const dims = createDimensions({ hiddenCols: new Set([1, 3, 5]) });
    // Col 7 = 7*100 - 3*100 = 400
    expect(getColumnXPosition(7, config, dims)).toBe(400);
  });

  it("handles adjacent custom widths", () => {
    const dims = createDimensions({
      columnWidths: new Map([
        [0, 50],
        [1, 50],
        [2, 50],
      ]),
    });
    // Col 3 = 3*100 + (50-100)*3 = 300 - 150 = 150
    expect(getColumnXPosition(3, config, dims)).toBe(150);
  });
});

describe("getRowYPosition - multiple hidden and custom rows", () => {
  const config = createTestConfig();

  it("handles multiple hidden rows", () => {
    const dims = createDimensions({ hiddenRows: new Set([0, 2, 4]) });
    // Row 6 = 6*25 - 3*25 = 75
    expect(getRowYPosition(6, config, dims)).toBe(75);
  });

  it("handles hidden row with custom height", () => {
    const dims = createDimensions({
      rowHeights: new Map([[2, 80]]),
      hiddenRows: new Set([2]),
    });
    // Row 5 = 5*25 + (80-25) - 80 = 125 + 55 - 80 = 100 ... but let's verify the logic:
    // base: 5*25 = 125
    // custom height adj: row 2 < 5, so +80-25 = +55 -> 180
    // hidden adj: row 2 < 5, has custom width 80, so -80 -> 100
    expect(getRowYPosition(5, config, dims)).toBe(100);
  });
});
