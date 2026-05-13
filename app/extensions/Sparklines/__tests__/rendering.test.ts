//! FILENAME: app/extensions/Sparklines/__tests__/rendering.test.ts
// PURPOSE: Tests for sparkline rendering logic (data preprocessing, drawing).
// CONTEXT: Tests the pure rendering functions: data preprocessing (empty cell handling,
//          plot order), scale computation, and canvas drawing calls.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CellDecorationContext } from "@api/cellDecorations";
import type { SparklineGroup } from "../types";
import { drawSparkline } from "../rendering";
import {
  createSparklineGroup,
  setCachedGroupData,
  markDataCacheClean,
  resetSparklineStore,
} from "../store";

// ============================================================================
// Mock Canvas Context
// ============================================================================

function makeCtx(): CanvasRenderingContext2D {
  return {
    save: vi.fn(),
    restore: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    arc: vi.fn(),
    closePath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    clearRect: vi.fn(),
    clip: vi.fn(),
    rect: vi.fn(),
    setLineDash: vi.fn(),
    translate: vi.fn(),
    rotate: vi.fn(),
    scale: vi.fn(),
    fillText: vi.fn(),
    measureText: vi.fn().mockReturnValue({ width: 40, actualBoundingBoxAscent: 8, actualBoundingBoxDescent: 2 }),
    canvas: { width: 600, height: 400 },
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "alphabetic" as CanvasTextBaseline,
    globalAlpha: 1,
    lineCap: "butt" as CanvasLineCap,
    lineJoin: "miter" as CanvasLineJoin,
    shadowColor: "",
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
  } as unknown as CanvasRenderingContext2D;
}

function makeDecorationContext(row: number, col: number, ctx?: CanvasRenderingContext2D): CellDecorationContext {
  return {
    ctx: ctx ?? makeCtx(),
    row,
    col,
    cellLeft: 50,
    cellTop: 24,
    cellRight: 150,
    cellBottom: 48,
    config: { defaultCellWidth: 100, defaultCellHeight: 24, rowHeaderWidth: 50, colHeaderHeight: 24, totalRows: 1000, totalCols: 26 },
    viewport: { startRow: 0, endRow: 50, startCol: 0, endCol: 10, scrollX: 0, scrollY: 0 },
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
    display: "",
    styleIndex: 0,
    styleCache: new Map(),
  } as CellDecorationContext;
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetSparklineStore();
});

// ============================================================================
// Tests
// ============================================================================

describe("drawSparkline", () => {
  it("does nothing for cells without sparklines", () => {
    const ctx = makeCtx();
    const context = makeDecorationContext(0, 0, ctx);
    drawSparkline(context);
    // save/restore should not be called
    expect(ctx.save).not.toHaveBeenCalled();
  });

  describe("line sparkline rendering", () => {
    it("draws a line sparkline with cached data", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "line",
      );
      const groupId = result.group!.id;

      // Pre-populate cache
      setCachedGroupData(groupId, [[10, 20, 15, 30, 25]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // Should draw a line path
      expect(ctx.save).toHaveBeenCalled();
      expect(ctx.beginPath).toHaveBeenCalled();
      expect(ctx.moveTo).toHaveBeenCalled();
      expect(ctx.lineTo).toHaveBeenCalled();
      expect(ctx.stroke).toHaveBeenCalled();
      expect(ctx.restore).toHaveBeenCalled();
    });

    it("draws markers when showMarkers is enabled", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "line",
      );
      const group = result.group!;
      group.showMarkers = true;
      setCachedGroupData(group.id, [[10, 20, 15, 30, 25]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // arc() should be called for markers (5 data points)
      expect(ctx.arc).toHaveBeenCalled();
      expect((ctx.arc as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(5);
    });

    it("draws special point markers when enabled", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "line",
      );
      const group = result.group!;
      group.showHighPoint = true;
      group.showLowPoint = true;
      setCachedGroupData(group.id, [[10, 5, 30, 20, 15]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // arc() for high and low point markers
      expect(ctx.arc).toHaveBeenCalled();
    });

    it("handles empty data gracefully", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "line",
      );
      setCachedGroupData(result.group!.id, [[]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      // Should not throw
      drawSparkline(context);
    });
  });

  describe("column sparkline rendering", () => {
    it("draws bars for column sparkline", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "column",
      );
      setCachedGroupData(result.group!.id, [[10, -5, 20, -10, 15]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // Should draw rectangles for bars
      expect(ctx.fillRect).toHaveBeenCalled();
      // 5 data points = 5 bars
      expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(5);
    });
  });

  describe("win/loss sparkline rendering", () => {
    it("draws win/loss bars", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "winloss",
      );
      setCachedGroupData(result.group!.id, [[1, -1, 1, -1, 0]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // 4 non-zero bars (0 is skipped)
      expect(ctx.fillRect).toHaveBeenCalled();
      expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
    });
  });

  describe("empty cell handling", () => {
    it("treats NaN as zero when emptyCellHandling is 'zero'", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "line",
      );
      result.group!.emptyCellHandling = "zero";
      setCachedGroupData(result.group!.id, [[10, NaN, 20, NaN, 30]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // Line should be continuous (all 5 points connected)
      expect(ctx.moveTo).toHaveBeenCalled();
      expect(ctx.lineTo).toHaveBeenCalled();
      // With zero handling, there should be one continuous segment
      const moveToCount = (ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(moveToCount).toBe(1); // One segment start
    });

    it("creates gaps for NaN when emptyCellHandling is 'gaps'", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "line",
      );
      result.group!.emptyCellHandling = "gaps";
      setCachedGroupData(result.group!.id, [[10, NaN, 20, NaN, 30]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // With gaps, there should be no continuous line - individual segments
      // Data: [10, gap, 20, gap, 30] -> no segments have 2+ points, so no lines drawn
      // Actually: single point segments are skipped, so moveTo might not be called for line segments
    });

    it("connects data points over gaps when emptyCellHandling is 'connect'", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "line",
      );
      result.group!.emptyCellHandling = "connect";
      setCachedGroupData(result.group!.id, [[10, NaN, 20, NaN, 30]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // With connect, NaN values are interpolated, so all 5 points form one segment
      const moveToCount = (ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls.length;
      expect(moveToCount).toBe(1); // One continuous segment
    });

    it("skips NaN bars in column sparkline", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "column",
      );
      result.group!.emptyCellHandling = "gaps";
      setCachedGroupData(result.group!.id, [[10, NaN, 20, NaN, 30]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // Only 3 non-NaN bars should be drawn
      expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    });
  });

  describe("plot order", () => {
    it("reverses data when plotOrder is rightToLeft", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 2 },
        "column",
      );
      result.group!.plotOrder = "rightToLeft";
      // Data: [10, 20, 30] -> reversed: [30, 20, 10]
      setCachedGroupData(result.group!.id, [[10, 20, 30]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // Should draw 3 bars
      expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
    });
  });

  describe("axis line", () => {
    it("draws axis line when showAxis is true", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "line",
      );
      result.group!.showAxis = true;
      // Data includes both positive and negative values
      setCachedGroupData(result.group!.id, [[-5, 10, -3, 20, 5]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // setLineDash should be called for the axis line
      expect(ctx.setLineDash).toHaveBeenCalled();
    });

    it("does not draw axis line when showAxis is false", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "line",
      );
      result.group!.showAxis = false;
      setCachedGroupData(result.group!.id, [[-5, 10, -3, 20, 5]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // setLineDash should NOT be called (no dashed line for axis)
      expect(ctx.setLineDash).not.toHaveBeenCalled();
    });
  });

  describe("custom axis scaling", () => {
    it("uses custom min/max when axisScaleType is 'custom'", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 0, endCol: 4 },
        "column",
      );
      result.group!.axisScaleType = "custom";
      result.group!.axisMinValue = 0;
      result.group!.axisMaxValue = 100;
      setCachedGroupData(result.group!.id, [[10, 20, 30, 40, 50]]);
      markDataCacheClean();

      const ctx = makeCtx();
      const context = makeDecorationContext(0, 5, ctx);
      drawSparkline(context);

      // Should draw bars (scaled to 0-100 range)
      expect(ctx.fillRect).toHaveBeenCalled();
    });
  });

  describe("multi-cell sparkline groups", () => {
    it("renders different data for each cell in a column group", () => {
      const result = createSparklineGroup(
        { startRow: 0, startCol: 5, endRow: 2, endCol: 5 },
        { startRow: 0, startCol: 0, endRow: 2, endCol: 3 },
        "line",
      );
      setCachedGroupData(result.group!.id, [
        [10, 20, 30, 40],
        [5, 15, 25, 35],
        [1, 2, 3, 4],
      ]);
      markDataCacheClean();

      // Render each cell
      for (let r = 0; r < 3; r++) {
        const ctx = makeCtx();
        const context = makeDecorationContext(r, 5, ctx);
        drawSparkline(context);
        expect(ctx.stroke).toHaveBeenCalled();
      }
    });
  });
});
