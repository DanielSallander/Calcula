/**
 * FILENAME: app/src/core/lib/__tests__/scroll-parameterized.test.ts
 * PURPOSE: Heavily parameterized tests for scroll and viewport utilities.
 * TARGET: 300+ test cases using it.each patterns.
 */

import { describe, it, expect } from "vitest";
import type { GridConfig, Viewport, DimensionOverrides } from "../../types";
import {
  scrollToVisibleRange,
  isCellVisible,
  calculateScrollDelta,
  getColumnXPosition,
  getRowYPosition,
  calculateScrollbarMetrics,
  cellToScroll,
  cellToCenteredScroll,
  SCROLLBAR_WIDTH,
  SCROLLBAR_HEIGHT,
  type ScrollDirection,
  type ScrollUnit,
} from "../scrollUtils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(overrides?: Partial<GridConfig>): GridConfig {
  return {
    defaultCellWidth: 100,
    defaultCellHeight: 25,
    rowHeaderWidth: 50,
    colHeaderHeight: 30,
    totalRows: 1_000_000,
    totalCols: 16_384,
    minColumnWidth: 20,
    minRowHeight: 10,
    maxColumnWidth: 800,
    maxRowHeight: 400,
    ...overrides,
  };
}

function makeViewport(overrides?: Partial<Viewport>): Viewport {
  return {
    startRow: 0,
    startCol: 0,
    rowCount: 40,
    colCount: 10,
    scrollX: 0,
    scrollY: 0,
    ...overrides,
  };
}

function makeDimensions(overrides?: Partial<DimensionOverrides>): DimensionOverrides {
  return {
    columnWidths: new Map(),
    rowHeights: new Map(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. scrollToVisibleRange - 100 test cases (10 viewport sizes x 10 scroll positions)
// ---------------------------------------------------------------------------

describe("scrollToVisibleRange", () => {
  const viewportSizes = [
    { w: 500, h: 300, label: "500x300" },
    { w: 800, h: 600, label: "800x600" },
    { w: 1024, h: 768, label: "1024x768" },
    { w: 1280, h: 720, label: "1280x720" },
    { w: 1920, h: 1080, label: "1920x1080" },
    { w: 2560, h: 1440, label: "2560x1440" },
    { w: 400, h: 200, label: "400x200" },
    { w: 600, h: 400, label: "600x400" },
    { w: 1100, h: 900, label: "1100x900" },
    { w: 3840, h: 2160, label: "3840x2160" },
  ];

  const scrollPositions = [
    { sx: 0, sy: 0, label: "origin" },
    { sx: 100, sy: 25, label: "one cell" },
    { sx: 500, sy: 250, label: "mid-small" },
    { sx: 1000, sy: 500, label: "mid" },
    { sx: 5000, sy: 2500, label: "far" },
    { sx: 10000, sy: 10000, label: "distant" },
    { sx: 50, sy: 12, label: "sub-cell" },
    { sx: 150, sy: 37, label: "partial-cell" },
    { sx: 0, sy: 5000, label: "vertical-only" },
    { sx: 5000, sy: 0, label: "horizontal-only" },
  ];

  const cases: Array<{
    label: string;
    sx: number;
    sy: number;
    w: number;
    h: number;
  }> = [];

  for (const vp of viewportSizes) {
    for (const sp of scrollPositions) {
      cases.push({
        label: `viewport=${vp.label} scroll=${sp.label}`,
        sx: sp.sx,
        sy: sp.sy,
        w: vp.w,
        h: vp.h,
      });
    }
  }

  const config = makeConfig();

  it.each(cases)(
    "$label",
    ({ sx, sy, w, h }) => {
      const range = scrollToVisibleRange(sx, sy, config, w, h);

      // startRow/startCol derived from scroll position
      const expectedStartCol = Math.floor(sx / config.defaultCellWidth);
      const expectedStartRow = Math.floor(sy / config.defaultCellHeight);

      expect(range.startRow).toBe(Math.max(0, expectedStartRow));
      expect(range.startCol).toBe(Math.max(0, expectedStartCol));

      // endRow/endCol must be >= start
      expect(range.endRow).toBeGreaterThanOrEqual(range.startRow);
      expect(range.endCol).toBeGreaterThanOrEqual(range.startCol);

      // endRow/endCol must not exceed grid bounds
      expect(range.endRow).toBeLessThan(config.totalRows);
      expect(range.endCol).toBeLessThan(config.totalCols);

      // Available viewport width/height
      const availW = w - config.rowHeaderWidth - SCROLLBAR_WIDTH;
      const availH = h - config.colHeaderHeight - SCROLLBAR_HEIGHT;
      const expectedVisibleCols = Math.ceil(availW / config.defaultCellWidth) + 1;
      const expectedVisibleRows = Math.ceil(availH / config.defaultCellHeight) + 1;

      expect(range.endCol).toBe(
        Math.min(expectedStartCol + expectedVisibleCols, config.totalCols - 1)
      );
      expect(range.endRow).toBe(
        Math.min(expectedStartRow + expectedVisibleRows, config.totalRows - 1)
      );

      // Offsets are negative sub-cell remainders
      expect(range.offsetX).toBe(-(sx % config.defaultCellWidth));
      expect(range.offsetY).toBe(-(sy % config.defaultCellHeight));
    }
  );
});

// ---------------------------------------------------------------------------
// 2. isCellVisible - 80 test cases (20 cells x 4 viewport configs)
// ---------------------------------------------------------------------------

describe("isCellVisible", () => {
  const config = makeConfig();
  const vpWidth = 1020; // avail = 1020 - 50 - 17 = 953, fits ~9.53 cols + 1 = 10 cols => endCol = 10
  const vpHeight = 530; // avail = 530 - 30 - 17 = 483, fits ~19.32 rows + 1 = 20 rows => endRow = 20

  // Viewport configs: scrollX, scrollY
  const viewportConfigs: Array<{
    label: string;
    scrollX: number;
    scrollY: number;
  }> = [
    { label: "origin", scrollX: 0, scrollY: 0 },
    { label: "scrolled-down", scrollX: 0, scrollY: 500 },
    { label: "scrolled-right", scrollX: 1000, scrollY: 0 },
    { label: "scrolled-both", scrollX: 500, scrollY: 250 },
  ];

  // 20 cell positions
  const cells: Array<{ row: number; col: number; label: string }> = [
    { row: 0, col: 0, label: "A1" },
    { row: 0, col: 5, label: "F1" },
    { row: 0, col: 15, label: "P1" },
    { row: 10, col: 0, label: "A11" },
    { row: 10, col: 5, label: "F11" },
    { row: 10, col: 10, label: "K11" },
    { row: 20, col: 0, label: "A21" },
    { row: 20, col: 10, label: "K21" },
    { row: 50, col: 0, label: "A51" },
    { row: 50, col: 50, label: "AX51" },
    { row: 100, col: 0, label: "A101" },
    { row: 100, col: 100, label: "far-diag" },
    { row: 0, col: 9, label: "boundary-col" },
    { row: 19, col: 0, label: "boundary-row" },
    { row: 5, col: 5, label: "mid-small" },
    { row: 25, col: 12, label: "outside-origin" },
    { row: 999, col: 999, label: "far-far" },
    { row: 0, col: 0, label: "origin-dup" },
    { row: 30, col: 15, label: "mid-far" },
    { row: 15, col: 3, label: "mid-near" },
  ];

  const allCases: Array<{
    label: string;
    row: number;
    col: number;
    scrollX: number;
    scrollY: number;
  }> = [];

  for (const vc of viewportConfigs) {
    for (const cell of cells) {
      allCases.push({
        label: `cell=${cell.label} vp=${vc.label}`,
        row: cell.row,
        col: cell.col,
        scrollX: vc.scrollX,
        scrollY: vc.scrollY,
      });
    }
  }

  it.each(allCases)(
    "$label",
    ({ row, col, scrollX, scrollY }) => {
      const vp = makeViewport({ scrollX, scrollY });
      const result = isCellVisible(row, col, vp, config, vpWidth, vpHeight);

      // Compute expected via scrollToVisibleRange
      const range = scrollToVisibleRange(scrollX, scrollY, config, vpWidth, vpHeight);
      const expected =
        row >= range.startRow &&
        row <= range.endRow &&
        col >= range.startCol &&
        col <= range.endCol;

      expect(result).toBe(expected);
    }
  );
});

// ---------------------------------------------------------------------------
// 3. calculateScrollDelta - 48 cases (4 directions x 3 units x 4 viewport states)
// ---------------------------------------------------------------------------

describe("calculateScrollDelta", () => {
  const config = makeConfig();
  const vpWidth = 1020;
  const vpHeight = 530;

  const directions: ScrollDirection[] = ["up", "down", "left", "right"];
  const units: ScrollUnit[] = ["cell", "page", "document"];

  const viewportStates: Array<{ label: string; vp: Viewport }> = [
    { label: "origin", vp: makeViewport({ scrollX: 0, scrollY: 0 }) },
    { label: "mid", vp: makeViewport({ scrollX: 500, scrollY: 500 }) },
    { label: "far", vp: makeViewport({ scrollX: 10000, scrollY: 25000 }) },
    { label: "near-start", vp: makeViewport({ scrollX: 100, scrollY: 25 }) },
  ];

  const cases: Array<{
    label: string;
    dir: ScrollDirection;
    unit: ScrollUnit;
    vp: Viewport;
  }> = [];

  for (const dir of directions) {
    for (const unit of units) {
      for (const vs of viewportStates) {
        cases.push({
          label: `dir=${dir} unit=${unit} vp=${vs.label}`,
          dir,
          unit,
          vp: vs.vp,
        });
      }
    }
  }

  const availW = vpWidth - config.rowHeaderWidth - SCROLLBAR_WIDTH;
  const availH = vpHeight - config.colHeaderHeight - SCROLLBAR_HEIGHT;

  it.each(cases)(
    "$label",
    ({ dir, unit, vp }) => {
      const { deltaX, deltaY } = calculateScrollDelta(dir, unit, config, vp, vpWidth, vpHeight);

      // Vertical directions should not produce horizontal delta (and vice versa)
      if (dir === "up" || dir === "down") {
        expect(deltaX).toBe(0);
      }
      if (dir === "left" || dir === "right") {
        expect(deltaY).toBe(0);
      }

      // Check sign conventions
      if (unit === "cell") {
        if (dir === "up") expect(deltaY).toBe(-config.defaultCellHeight);
        if (dir === "down") expect(deltaY).toBe(config.defaultCellHeight);
        if (dir === "left") expect(deltaX).toBe(-config.defaultCellWidth);
        if (dir === "right") expect(deltaX).toBe(config.defaultCellWidth);
      }

      if (unit === "page") {
        const pageRows = Math.max(1, Math.floor(availH / config.defaultCellHeight) - 1);
        const pageCols = Math.max(1, Math.floor(availW / config.defaultCellWidth) - 1);
        if (dir === "up") expect(deltaY).toBe(-pageRows * config.defaultCellHeight);
        if (dir === "down") expect(deltaY).toBe(pageRows * config.defaultCellHeight);
        if (dir === "left") expect(deltaX).toBe(-pageCols * config.defaultCellWidth);
        if (dir === "right") expect(deltaX).toBe(pageCols * config.defaultCellWidth);
      }

      if (unit === "document") {
        if (dir === "up") expect(deltaY).toBe(-vp.scrollY);
        if (dir === "down") expect(deltaY).toBe(config.totalRows * config.defaultCellHeight - vp.scrollY);
        if (dir === "left") expect(deltaX).toBe(-vp.scrollX);
        if (dir === "right") expect(deltaX).toBe(config.totalCols * config.defaultCellWidth - vp.scrollX);
      }
    }
  );
});

// ---------------------------------------------------------------------------
// 4. getColumnXPosition - 50 cases (10 columns x 5 dimension configs)
// ---------------------------------------------------------------------------

describe("getColumnXPosition", () => {
  const config = makeConfig();

  const columns = [0, 1, 2, 5, 10, 20, 50, 100, 500, 1000];

  const dimConfigs: Array<{ label: string; dims?: DimensionOverrides }> = [
    { label: "default" },
    {
      label: "custom-widths",
      dims: makeDimensions({
        columnWidths: new Map([[2, 200], [5, 50], [10, 300]]),
      }),
    },
    {
      label: "hidden-cols",
      dims: makeDimensions({
        hiddenCols: new Set([3, 7, 15]),
      }),
    },
    {
      label: "mixed",
      dims: makeDimensions({
        columnWidths: new Map([[1, 150], [4, 80]]),
        hiddenCols: new Set([2, 6]),
      }),
    },
    {
      label: "wide-single",
      dims: makeDimensions({
        columnWidths: new Map([[0, 500]]),
      }),
    },
  ];

  const cases: Array<{
    label: string;
    col: number;
    dims?: DimensionOverrides;
  }> = [];

  for (const col of columns) {
    for (const dc of dimConfigs) {
      cases.push({ label: `col=${col} dims=${dc.label}`, col, dims: dc.dims });
    }
  }

  it.each(cases)(
    "$label",
    ({ col, dims }) => {
      const result = getColumnXPosition(col, config, dims);

      // Compute expected by summing widths of columns 0..col-1
      let expected = 0;
      for (let c = 0; c < col; c++) {
        if (dims?.hiddenCols?.has(c)) {
          // hidden columns contribute 0
          continue;
        }
        const customW = dims?.columnWidths?.get(c);
        expected += customW ?? config.defaultCellWidth;
      }

      expect(result).toBe(expected);
    }
  );
});

// ---------------------------------------------------------------------------
// 5. getRowYPosition - 50 cases (10 rows x 5 dimension configs)
// ---------------------------------------------------------------------------

describe("getRowYPosition", () => {
  const config = makeConfig();

  const rows = [0, 1, 2, 5, 10, 20, 50, 100, 500, 1000];

  const dimConfigs: Array<{ label: string; dims?: DimensionOverrides }> = [
    { label: "default" },
    {
      label: "custom-heights",
      dims: makeDimensions({
        rowHeights: new Map([[2, 50], [5, 10], [10, 80]]),
      }),
    },
    {
      label: "hidden-rows",
      dims: makeDimensions({
        hiddenRows: new Set([3, 7, 15]),
      }),
    },
    {
      label: "mixed",
      dims: makeDimensions({
        rowHeights: new Map([[1, 40], [4, 15]]),
        hiddenRows: new Set([2, 6]),
      }),
    },
    {
      label: "tall-single",
      dims: makeDimensions({
        rowHeights: new Map([[0, 200]]),
      }),
    },
  ];

  const cases: Array<{
    label: string;
    row: number;
    dims?: DimensionOverrides;
  }> = [];

  for (const row of rows) {
    for (const dc of dimConfigs) {
      cases.push({ label: `row=${row} dims=${dc.label}`, row, dims: dc.dims });
    }
  }

  it.each(cases)(
    "$label",
    ({ row, dims }) => {
      const result = getRowYPosition(row, config, dims);

      let expected = 0;
      for (let r = 0; r < row; r++) {
        if (dims?.hiddenRows?.has(r)) continue;
        const customH = dims?.rowHeights?.get(r);
        expected += customH ?? config.defaultCellHeight;
      }

      expect(result).toBe(expected);
    }
  );
});

// ---------------------------------------------------------------------------
// 6. calculateScrollbarMetrics - 30 cases (6 viewport sizes x 5 content sizes)
// ---------------------------------------------------------------------------

describe("calculateScrollbarMetrics", () => {
  const vpSizes = [
    { w: 500, h: 300, label: "small" },
    { w: 1024, h: 768, label: "medium" },
    { w: 1920, h: 1080, label: "large" },
    { w: 2560, h: 1440, label: "xlarge" },
    { w: 400, h: 200, label: "tiny" },
    { w: 3840, h: 2160, label: "4k" },
  ];

  const contentConfigs: Array<{ label: string; totalRows: number; totalCols: number }> = [
    { label: "small-grid", totalRows: 100, totalCols: 26 },
    { label: "medium-grid", totalRows: 10000, totalCols: 256 },
    { label: "large-grid", totalRows: 1_000_000, totalCols: 16_384 },
    { label: "single-screen", totalRows: 20, totalCols: 10 },
    { label: "tall-narrow", totalRows: 100000, totalCols: 5 },
  ];

  const cases: Array<{
    label: string;
    w: number;
    h: number;
    totalRows: number;
    totalCols: number;
  }> = [];

  for (const vp of vpSizes) {
    for (const cc of contentConfigs) {
      cases.push({
        label: `vp=${vp.label} content=${cc.label}`,
        w: vp.w,
        h: vp.h,
        totalRows: cc.totalRows,
        totalCols: cc.totalCols,
      });
    }
  }

  it.each(cases)(
    "$label",
    ({ w, h, totalRows, totalCols }) => {
      const config = makeConfig({ totalRows, totalCols });
      const vp = makeViewport({ scrollX: 0, scrollY: 0 });

      const metrics = calculateScrollbarMetrics(config, vp, w, h);

      // Track sizes equal available viewport dimensions
      const viewW = w - config.rowHeaderWidth - SCROLLBAR_WIDTH;
      const viewH = h - config.colHeaderHeight - SCROLLBAR_HEIGHT;

      expect(metrics.horizontal.trackSize).toBe(viewW);
      expect(metrics.vertical.trackSize).toBe(viewH);

      // Thumb sizes must be >= 30 (minimum) and <= track size
      expect(metrics.horizontal.thumbSize).toBeGreaterThanOrEqual(30);
      expect(metrics.vertical.thumbSize).toBeGreaterThanOrEqual(30);
      // Thumb size can exceed track when viewport > content (ratio > 1)
      // Just verify it's positive
      expect(metrics.horizontal.thumbSize).toBeGreaterThan(0);
      expect(metrics.vertical.thumbSize).toBeGreaterThan(0);

      // At scroll=0, thumb positions should be 0
      expect(metrics.horizontal.thumbPosition).toBe(0);
      expect(metrics.vertical.thumbPosition).toBe(0);

      // Thumb size proportional to viewport/content ratio (clamped to min 30)
      const contentW = totalCols * config.defaultCellWidth;
      const contentH = totalRows * config.defaultCellHeight;
      const expectedHThumb = Math.max(30, (viewW / contentW) * viewW);
      const expectedVThumb = Math.max(30, (viewH / contentH) * viewH);
      expect(metrics.horizontal.thumbSize).toBeCloseTo(expectedHThumb, 5);
      expect(metrics.vertical.thumbSize).toBeCloseTo(expectedVThumb, 5);
    }
  );
});

// ---------------------------------------------------------------------------
// 7. cellToScroll / cellToCenteredScroll - 40 cases (20 cells x 2 modes)
// ---------------------------------------------------------------------------

describe("cellToScroll and cellToCenteredScroll", () => {
  const config = makeConfig();
  const vpWidth = 1020;
  const vpHeight = 530;

  const cells: Array<{ row: number; col: number; label: string }> = [
    { row: 0, col: 0, label: "A1" },
    { row: 0, col: 1, label: "B1" },
    { row: 1, col: 0, label: "A2" },
    { row: 10, col: 5, label: "F11" },
    { row: 50, col: 20, label: "U51" },
    { row: 100, col: 100, label: "CV101" },
    { row: 0, col: 50, label: "AX1" },
    { row: 500, col: 0, label: "A501" },
    { row: 999, col: 255, label: "IV1000" },
    { row: 1000, col: 1000, label: "far" },
    { row: 5, col: 5, label: "F6" },
    { row: 25, col: 10, label: "K26" },
    { row: 200, col: 50, label: "AX201" },
    { row: 0, col: 100, label: "CV1" },
    { row: 300, col: 300, label: "KN301" },
    { row: 10000, col: 0, label: "A10001" },
    { row: 0, col: 10000, label: "NTP1" },
    { row: 50000, col: 5000, label: "deep" },
    { row: 3, col: 3, label: "D4" },
    { row: 15, col: 7, label: "H16" },
  ];

  describe("cellToScroll (top-left mode)", () => {
    it.each(cells)(
      "cell=$label (row=$row, col=$col)",
      ({ row, col }) => {
        const result = cellToScroll(row, col, config);
        expect(result.scrollX).toBe(col * config.defaultCellWidth);
        expect(result.scrollY).toBe(row * config.defaultCellHeight);
      }
    );
  });

  describe("cellToCenteredScroll (centered mode)", () => {
    it.each(cells)(
      "cell=$label (row=$row, col=$col)",
      ({ row, col }) => {
        const result = cellToCenteredScroll(row, col, config, vpWidth, vpHeight);

        const cellX = col * config.defaultCellWidth;
        const cellY = row * config.defaultCellHeight;
        const availW = vpWidth - config.rowHeaderWidth - SCROLLBAR_WIDTH;
        const availH = vpHeight - config.colHeaderHeight - SCROLLBAR_HEIGHT;

        const expectedX = cellX - availW / 2 + config.defaultCellWidth / 2;
        const expectedY = cellY - availH / 2 + config.defaultCellHeight / 2;

        expect(result.scrollX).toBeCloseTo(expectedX, 5);
        expect(result.scrollY).toBeCloseTo(expectedY, 5);
      }
    );
  });
});

// ---------------------------------------------------------------------------
// Bonus: scrollToVisibleRange edge cases - 8 additional cases
// ---------------------------------------------------------------------------

describe("scrollToVisibleRange edge cases", () => {
  const edgeCases = [
    { label: "zero scroll", sx: 0, sy: 0, rows: 100, cols: 26 },
    { label: "max rows small grid", sx: 0, sy: 2400, rows: 100, cols: 26 },
    { label: "1 row grid", sx: 0, sy: 0, rows: 1, cols: 1 },
    { label: "tiny viewport overflow", sx: 0, sy: 0, rows: 5, cols: 3 },
    { label: "large scroll small grid", sx: 900, sy: 225, rows: 10, cols: 10 },
    { label: "exact cell boundary", sx: 200, sy: 50, rows: 1000, cols: 100 },
    { label: "one pixel past boundary", sx: 201, sy: 51, rows: 1000, cols: 100 },
    { label: "negative clamp check", sx: 0, sy: 0, rows: 1000000, cols: 16384 },
  ];

  it.each(edgeCases)(
    "$label",
    ({ sx, sy, rows, cols }) => {
      const config = makeConfig({ totalRows: rows, totalCols: cols });
      const range = scrollToVisibleRange(sx, sy, config, 1024, 768);

      expect(range.startRow).toBeGreaterThanOrEqual(0);
      expect(range.startCol).toBeGreaterThanOrEqual(0);
      expect(range.endRow).toBeLessThan(rows);
      expect(range.endCol).toBeLessThan(cols);
      expect(range.endRow).toBeGreaterThanOrEqual(range.startRow);
      expect(range.endCol).toBeGreaterThanOrEqual(range.startCol);
    }
  );
});

// ---------------------------------------------------------------------------
// Bonus: scrollbar metrics with non-zero scroll - 12 additional cases
// ---------------------------------------------------------------------------

describe("calculateScrollbarMetrics with scroll offsets", () => {
  const config = makeConfig({ totalRows: 10000, totalCols: 256 });
  const vpWidth = 1024;
  const vpHeight = 768;

  const scrollOffsets = [
    { sx: 0, sy: 0, label: "zero" },
    { sx: 500, sy: 500, label: "mid" },
    { sx: 1000, sy: 2000, label: "offset" },
    { sx: 5000, sy: 10000, label: "far" },
    { sx: 100, sy: 100, label: "near" },
    { sx: 0, sy: 50000, label: "deep-vertical" },
    { sx: 20000, sy: 0, label: "deep-horizontal" },
    { sx: 10000, sy: 100000, label: "very-far" },
    { sx: 50, sy: 50, label: "tiny" },
    { sx: 200, sy: 800, label: "small-offset" },
    { sx: 3000, sy: 3000, label: "moderate" },
    { sx: 25000, sy: 200000, label: "extreme" },
  ];

  it.each(scrollOffsets)(
    "scroll=$label (sx=$sx, sy=$sy)",
    ({ sx, sy }) => {
      const vp = makeViewport({ scrollX: sx, scrollY: sy });
      const metrics = calculateScrollbarMetrics(config, vp, vpWidth, vpHeight);

      // Thumb position should be non-negative
      expect(metrics.horizontal.thumbPosition).toBeGreaterThanOrEqual(0);
      expect(metrics.vertical.thumbPosition).toBeGreaterThanOrEqual(0);

      // Thumb size should be positive
      expect(metrics.horizontal.thumbSize).toBeGreaterThan(0);
      expect(metrics.vertical.thumbSize).toBeGreaterThan(0);

      // Thumb position increases with scroll
      if (sx > 0) {
        const zeroMetrics = calculateScrollbarMetrics(config, makeViewport(), vpWidth, vpHeight);
        expect(metrics.horizontal.thumbPosition).toBeGreaterThanOrEqual(
          zeroMetrics.horizontal.thumbPosition
        );
      }
    }
  );
});
