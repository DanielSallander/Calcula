//! FILENAME: app/src/core/lib/__tests__/mutation-catchers.test.ts
// PURPOSE: Mutation-catching tests for scroll utilities — exact boundary values,
//          direction signs, pixel positions, and scrollbar metrics.

import { describe, it, expect } from "vitest";
import type { GridConfig, Viewport, DimensionOverrides } from "../../types";
import {
  scrollToVisibleRange,
  getColumnXPosition,
  getRowYPosition,
  calculateScrollDelta,
  clampScroll,
  calculateScrollbarMetrics,
  SCROLLBAR_WIDTH,
  SCROLLBAR_HEIGHT,
} from "../scrollUtils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    ...overrides,
  } as GridConfig;
}

function makeViewport(overrides?: Partial<Viewport>): Viewport {
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

// ---------------------------------------------------------------------------
// scrollToVisibleRange — exact boundary values
// ---------------------------------------------------------------------------

describe("scrollToVisibleRange boundary values", () => {
  const config = makeConfig();
  // Viewport: 1050 wide, 524 tall
  // Available width  = 1050 - 50 (rowHeader) - 17 (scrollbar) = 983
  // Available height = 524  - 24 (colHeader) - 17 (scrollbar) = 483
  const vpWidth = 1050;
  const vpHeight = 524;

  it("returns startRow=0, startCol=0 at scroll (0,0)", () => {
    const r = scrollToVisibleRange(0, 0, config, vpWidth, vpHeight);
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
    expect(r.offsetX).toBe(-0);
    expect(r.offsetY).toBe(-0);
  });

  it("computes endRow as exactly the last row that fits plus one partial", () => {
    const r = scrollToVisibleRange(0, 0, config, vpWidth, vpHeight);
    // availableHeight=483, cellHeight=24 => ceil(483/24)=21, +1=22
    // endRow = min(0+22, 999) = 22
    expect(r.endRow).toBe(22);
  });

  it("computes endCol as exactly the last col that fits plus one partial", () => {
    const r = scrollToVisibleRange(0, 0, config, vpWidth, vpHeight);
    // availableWidth=983, cellWidth=100 => ceil(983/100)=10, +1=11
    // endCol = min(0+11, 99) = 11
    expect(r.endCol).toBe(11);
  });

  it("offsets are negative sub-cell remainders when scrolled mid-cell", () => {
    const r = scrollToVisibleRange(150, 36, config, vpWidth, vpHeight);
    // scrollX=150 => startCol=1, offsetX=-(150%100)=-50
    // scrollY=36  => startRow=1, offsetY=-(36%24)=-12
    expect(r.startCol).toBe(1);
    expect(r.startRow).toBe(1);
    expect(r.offsetX).toBe(-50);
    expect(r.offsetY).toBe(-12);
  });

  it("clamps endRow to totalRows-1 when scrolled near bottom", () => {
    // Scroll far enough that endRow would exceed totalRows
    const scrollY = 998 * 24; // startRow=998
    const r = scrollToVisibleRange(0, scrollY, config, vpWidth, vpHeight);
    expect(r.endRow).toBe(999); // totalRows-1
    expect(r.startRow).toBe(998);
  });

  it("clamps endCol to totalCols-1 when scrolled near right edge", () => {
    const scrollX = 98 * 100; // startCol=98
    const r = scrollToVisibleRange(scrollX, 0, config, vpWidth, vpHeight);
    expect(r.endCol).toBe(99); // totalCols-1
    expect(r.startCol).toBe(98);
  });
});

// ---------------------------------------------------------------------------
// getColumnXPosition / getRowYPosition — exact pixel sums
// ---------------------------------------------------------------------------

describe("getColumnXPosition exact pixel positions", () => {
  const config = makeConfig({ defaultCellWidth: 80 });

  it("returns col*defaultWidth with no overrides", () => {
    expect(getColumnXPosition(0, config)).toBe(0);
    expect(getColumnXPosition(1, config)).toBe(80);
    expect(getColumnXPosition(5, config)).toBe(400);
    expect(getColumnXPosition(10, config)).toBe(800);
  });

  it("accounts for a single custom-width column before the target", () => {
    const dims: DimensionOverrides = {
      columnWidths: new Map([[2, 120]]),
      rowHeights: new Map(),
      hiddenCols: new Set(),
      hiddenRows: new Set(),
    };
    // col 5 => 5*80 + (120-80) = 400 + 40 = 440
    expect(getColumnXPosition(5, config, dims)).toBe(440);
    // col 2 is before itself, so its position is unaffected by its own width
    expect(getColumnXPosition(2, config, dims)).toBe(160); // 2*80
  });

  it("accounts for hidden columns (zero width)", () => {
    const dims: DimensionOverrides = {
      columnWidths: new Map(),
      rowHeights: new Map(),
      hiddenCols: new Set([1, 3]),
      hiddenRows: new Set(),
    };
    // col 5 => 5*80 - 80 (col1 hidden) - 80 (col3 hidden) = 400-160 = 240
    expect(getColumnXPosition(5, config, dims)).toBe(240);
  });

  it("handles custom width on a hidden column correctly", () => {
    const dims: DimensionOverrides = {
      columnWidths: new Map([[2, 200]]),
      rowHeights: new Map(),
      hiddenCols: new Set([2]),
      hiddenRows: new Set(),
    };
    // col 5: base=5*80=400, custom adj for col2: +(200-80)=+120,
    // hidden col2 with custom width: -200. Net: 400+120-200=320
    expect(getColumnXPosition(5, config, dims)).toBe(320);
  });
});

describe("getRowYPosition exact pixel positions", () => {
  const config = makeConfig({ defaultCellHeight: 20 });

  it("returns row*defaultHeight with no overrides", () => {
    expect(getRowYPosition(0, config)).toBe(0);
    expect(getRowYPosition(1, config)).toBe(20);
    expect(getRowYPosition(10, config)).toBe(200);
  });

  it("accounts for a single custom-height row before the target", () => {
    const dims: DimensionOverrides = {
      columnWidths: new Map(),
      rowHeights: new Map([[3, 50]]),
      hiddenCols: new Set(),
      hiddenRows: new Set(),
    };
    // row 5 => 5*20 + (50-20) = 100 + 30 = 130
    expect(getRowYPosition(5, config, dims)).toBe(130);
  });

  it("accounts for hidden rows", () => {
    const dims: DimensionOverrides = {
      columnWidths: new Map(),
      rowHeights: new Map(),
      hiddenCols: new Set(),
      hiddenRows: new Set([2]),
    };
    // row 5 => 5*20 - 20 = 80
    expect(getRowYPosition(5, config, dims)).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// calculateScrollDelta — direction signs
// ---------------------------------------------------------------------------

describe("calculateScrollDelta direction signs", () => {
  const config = makeConfig({ defaultCellWidth: 100, defaultCellHeight: 24 });
  const viewport = makeViewport({ scrollX: 500, scrollY: 1200 });
  const vpWidth = 1050;
  const vpHeight = 524;

  it("up produces negative deltaY", () => {
    const d = calculateScrollDelta("up", "cell", config, viewport, vpWidth, vpHeight);
    expect(d.deltaY).toBe(-24);
    expect(d.deltaX).toBe(0);
  });

  it("down produces positive deltaY", () => {
    const d = calculateScrollDelta("down", "cell", config, viewport, vpWidth, vpHeight);
    expect(d.deltaY).toBe(24);
    expect(d.deltaX).toBe(0);
  });

  it("left produces negative deltaX", () => {
    const d = calculateScrollDelta("left", "cell", config, viewport, vpWidth, vpHeight);
    expect(d.deltaX).toBe(-100);
    expect(d.deltaY).toBe(0);
  });

  it("right produces positive deltaX", () => {
    const d = calculateScrollDelta("right", "cell", config, viewport, vpWidth, vpHeight);
    expect(d.deltaX).toBe(100);
    expect(d.deltaY).toBe(0);
  });

  it("page up is negative and larger than one cell", () => {
    const d = calculateScrollDelta("up", "page", config, viewport, vpWidth, vpHeight);
    expect(d.deltaY).toBeLessThan(0);
    expect(Math.abs(d.deltaY)).toBeGreaterThan(24);
  });

  it("page down is positive and larger than one cell", () => {
    const d = calculateScrollDelta("down", "page", config, viewport, vpWidth, vpHeight);
    expect(d.deltaY).toBeGreaterThan(0);
    expect(d.deltaY).toBeGreaterThan(24);
  });

  it("document up scrolls exactly to zero", () => {
    const d = calculateScrollDelta("up", "document", config, viewport, vpWidth, vpHeight);
    expect(d.deltaY).toBe(-1200); // -viewport.scrollY
  });

  it("document left scrolls exactly to zero", () => {
    const d = calculateScrollDelta("left", "document", config, viewport, vpWidth, vpHeight);
    expect(d.deltaX).toBe(-500); // -viewport.scrollX
  });
});

// ---------------------------------------------------------------------------
// clampScroll — exact min/max boundaries
// ---------------------------------------------------------------------------

describe("clampScroll exact boundaries", () => {
  const config = makeConfig({
    totalRows: 100,
    totalCols: 20,
    defaultCellWidth: 100,
    defaultCellHeight: 24,
    rowHeaderWidth: 50,
    colHeaderHeight: 24,
  });
  // viewport: 1050 x 524
  // maxScrollX = 20*100 - (1050-50-17) = 2000 - 983 = 1017
  // maxScrollY = 100*24 - (524-24-17) = 2400 - 483 = 1917
  const vpWidth = 1050;
  const vpHeight = 524;

  it("clamps negative scroll to zero", () => {
    const r = clampScroll(-100, -50, config, vpWidth, vpHeight);
    expect(r.scrollX).toBe(0);
    expect(r.scrollY).toBe(0);
  });

  it("allows scroll at zero exactly", () => {
    const r = clampScroll(0, 0, config, vpWidth, vpHeight);
    expect(r.scrollX).toBe(0);
    expect(r.scrollY).toBe(0);
    expect(r.startRow).toBe(0);
    expect(r.startCol).toBe(0);
  });

  it("clamps scroll above maximum to exactly maxScroll", () => {
    const r = clampScroll(99999, 99999, config, vpWidth, vpHeight);
    expect(r.scrollX).toBe(1017);
    expect(r.scrollY).toBe(1917);
  });

  it("allows scroll at exactly the maximum value", () => {
    const r = clampScroll(1017, 1917, config, vpWidth, vpHeight);
    expect(r.scrollX).toBe(1017);
    expect(r.scrollY).toBe(1917);
  });

  it("does not clamp values within valid range", () => {
    const r = clampScroll(500, 600, config, vpWidth, vpHeight);
    expect(r.scrollX).toBe(500);
    expect(r.scrollY).toBe(600);
  });
});

// ---------------------------------------------------------------------------
// calculateScrollbarMetrics — thumb at 0 and max positions
// ---------------------------------------------------------------------------

describe("calculateScrollbarMetrics thumb positions", () => {
  const config = makeConfig({
    totalRows: 1000,
    totalCols: 50,
    defaultCellWidth: 100,
    defaultCellHeight: 24,
    rowHeaderWidth: 50,
    colHeaderHeight: 24,
  });
  const vpWidth = 1050;
  const vpHeight = 524;

  it("thumb position is 0 when scroll is at origin", () => {
    const viewport = makeViewport({ scrollX: 0, scrollY: 0 });
    const m = calculateScrollbarMetrics(config, viewport, vpWidth, vpHeight);
    expect(m.horizontal.thumbPosition).toBe(0);
    expect(m.vertical.thumbPosition).toBe(0);
  });

  it("thumb position equals trackSize-thumbSize when scroll is at max", () => {
    // contentWidth  = 50*100 = 5000
    // viewWidth     = 1050-50-17 = 983
    // maxScrollX    = 5000-983 = 4017
    // contentHeight = 1000*24 = 24000
    // viewHeight    = 524-24-17 = 483
    // maxScrollY    = 24000-483 = 23517
    const viewport = makeViewport({ scrollX: 4017, scrollY: 23517 });
    const m = calculateScrollbarMetrics(config, viewport, vpWidth, vpHeight);

    const hThumbRange = m.horizontal.trackSize - m.horizontal.thumbSize;
    const vThumbRange = m.vertical.trackSize - m.vertical.thumbSize;

    expect(m.horizontal.thumbPosition).toBeCloseTo(hThumbRange, 5);
    expect(m.vertical.thumbPosition).toBeCloseTo(vThumbRange, 5);
  });

  it("thumb size is at least 30px (minimum)", () => {
    const viewport = makeViewport();
    const m = calculateScrollbarMetrics(config, viewport, vpWidth, vpHeight);
    expect(m.horizontal.thumbSize).toBeGreaterThanOrEqual(30);
    expect(m.vertical.thumbSize).toBeGreaterThanOrEqual(30);
  });

  it("trackSize equals available viewport dimension", () => {
    const viewport = makeViewport();
    const m = calculateScrollbarMetrics(config, viewport, vpWidth, vpHeight);
    expect(m.horizontal.trackSize).toBe(vpWidth - config.rowHeaderWidth - SCROLLBAR_WIDTH);
    expect(m.vertical.trackSize).toBe(vpHeight - config.colHeaderHeight - SCROLLBAR_HEIGHT);
  });
});
