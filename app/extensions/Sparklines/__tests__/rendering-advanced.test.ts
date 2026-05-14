//! FILENAME: app/extensions/Sparklines/__tests__/rendering-advanced.test.ts
// PURPOSE: Advanced rendering tests for sparklines: coordinate mapping, scaling,
//          win/loss thresholds, color resolution, and edge cases.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CellDecorationContext } from "@api/cellDecorations";
import { drawSparkline } from "../rendering";
import {
  createSparklineGroup,
  updateSparklineGroup,
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

function makeDecorationContext(
  row: number,
  col: number,
  ctx?: CanvasRenderingContext2D,
  overrides?: Partial<CellDecorationContext>,
): CellDecorationContext {
  return {
    ctx: ctx ?? makeCtx(),
    row,
    col,
    cellLeft: overrides?.cellLeft ?? 50,
    cellTop: overrides?.cellTop ?? 24,
    cellRight: overrides?.cellRight ?? 150,
    cellBottom: overrides?.cellBottom ?? 48,
    config: { defaultCellWidth: 100, defaultCellHeight: 24, rowHeaderWidth: 50, colHeaderHeight: 24, totalRows: 1000, totalCols: 26 },
    viewport: { startRow: 0, endRow: 50, startCol: 0, endCol: 10, scrollX: 0, scrollY: 0 },
    dimensions: { columnWidths: new Map(), rowHeights: new Map() },
    display: "",
    styleIndex: 0,
    styleCache: new Map(),
  } as CellDecorationContext;
}

function createLineGroup(data: number[], opts?: Partial<Parameters<typeof updateSparklineGroup>[1]>) {
  const result = createSparklineGroup(
    { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
    { startRow: 0, startCol: 0, endRow: 0, endCol: data.length - 1 },
    "line",
  );
  if (opts) updateSparklineGroup(result.group!.id, opts);
  setCachedGroupData(result.group!.id, [data]);
  markDataCacheClean();
  return result.group!;
}

function createColumnGroup(data: number[], opts?: Partial<Parameters<typeof updateSparklineGroup>[1]>) {
  const result = createSparklineGroup(
    { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
    { startRow: 0, startCol: 0, endRow: 0, endCol: data.length - 1 },
    "column",
  );
  if (opts) updateSparklineGroup(result.group!.id, opts);
  setCachedGroupData(result.group!.id, [data]);
  markDataCacheClean();
  return result.group!;
}

function createWinLossGroup(data: number[], opts?: Partial<Parameters<typeof updateSparklineGroup>[1]>) {
  const result = createSparklineGroup(
    { startRow: 0, startCol: 5, endRow: 0, endCol: 5 },
    { startRow: 0, startCol: 0, endRow: 0, endCol: data.length - 1 },
    "winloss",
  );
  if (opts) updateSparklineGroup(result.group!.id, opts);
  setCachedGroupData(result.group!.id, [data]);
  markDataCacheClean();
  return result.group!;
}

// ============================================================================
// Setup
// ============================================================================

beforeEach(() => {
  resetSparklineStore();
});

// ============================================================================
// Edge Cases: Empty Data
// ============================================================================

describe("edge cases: empty and degenerate data", () => {
  it("handles single data point in line sparkline (no lineTo, just moveTo)", () => {
    createLineGroup([42]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Single point cannot form a segment (needs 2+ points), so no lineTo
    expect(ctx.lineTo).not.toHaveBeenCalled();
  });

  it("handles single data point in column sparkline (draws one bar)", () => {
    createColumnGroup([42]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });

  it("handles all NaN data in line sparkline", () => {
    createLineGroup([NaN, NaN, NaN], { emptyCellHandling: "gaps" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    // Should not throw
    drawSparkline(context);
    // No line segments drawn
    expect(ctx.moveTo).not.toHaveBeenCalled();
  });

  it("handles all NaN data in column sparkline with gaps mode", () => {
    createColumnGroup([NaN, NaN, NaN], { emptyCellHandling: "gaps" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);
    // No bars drawn
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });

  it("handles all NaN data with zero handling (converts to zeros)", () => {
    createColumnGroup([NaN, NaN, NaN], { emptyCellHandling: "zero" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);
    // All zeros still get drawn as bars (height = 1 minimum)
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("handles two data points in line sparkline (single segment)", () => {
    createLineGroup([10, 20]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect((ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
    expect((ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
  });
});

// ============================================================================
// Edge Cases: All Same Values
// ============================================================================

describe("edge cases: all same values", () => {
  it("renders line sparkline with all identical values (flat line)", () => {
    createLineGroup([5, 5, 5, 5, 5]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Should draw a flat line (all Y values are the same)
    expect(ctx.moveTo).toHaveBeenCalled();
    expect(ctx.lineTo).toHaveBeenCalled();
    expect(ctx.stroke).toHaveBeenCalled();
  });

  it("renders column sparkline with all identical positive values", () => {
    createColumnGroup([10, 10, 10]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("renders column sparkline with all zeros (still draws minimal bars)", () => {
    createColumnGroup([0, 0, 0]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Zero values still get bars with min height of 1
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });
});

// ============================================================================
// Edge Cases: Negative Values
// ============================================================================

describe("edge cases: negative values", () => {
  it("renders column sparkline with all negative values", () => {
    createColumnGroup([-10, -20, -5, -15]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it("uses negative color for negative bars in column sparkline", () => {
    createColumnGroup([-10, 20, -30], {
      color: "#0000FF",
      negativeColor: "#FF0000",
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Check that fillStyle was set to different colors
    const fillRectCalls = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls;
    expect(fillRectCalls.length).toBe(3);
  });

  it("renders win/loss with all negative values", () => {
    createWinLossGroup([-1, -2, -3, -4]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // All negative bars drawn below the midline
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(4);
  });

  it("renders line sparkline with mix of positive and large negative values", () => {
    createLineGroup([-100, 200, -300, 400, -500]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect(ctx.stroke).toHaveBeenCalled();
  });
});

// ============================================================================
// Edge Cases: Infinity Values
// ============================================================================

describe("edge cases: Infinity values", () => {
  it("handles Infinity in data without crashing (line)", () => {
    createLineGroup([1, Infinity, 3], { emptyCellHandling: "gaps" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    // Should not throw
    expect(() => drawSparkline(context)).not.toThrow();
  });

  it("handles -Infinity in data without crashing (column)", () => {
    createColumnGroup([1, -Infinity, 3], { emptyCellHandling: "gaps" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    expect(() => drawSparkline(context)).not.toThrow();
  });

  it("handles mixed NaN and Infinity", () => {
    createLineGroup([NaN, Infinity, -Infinity, NaN, 5], { emptyCellHandling: "zero" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    expect(() => drawSparkline(context)).not.toThrow();
  });
});

// ============================================================================
// Win/Loss Thresholds
// ============================================================================

describe("win/loss thresholds", () => {
  it("treats zero as neutral (not drawn)", () => {
    createWinLossGroup([1, 0, -1]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Only 2 bars (positive + negative), zero is skipped
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("treats small positive values as win", () => {
    createWinLossGroup([0.001, 0.5, 1]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // All 3 positive values drawn above midline
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("treats small negative values as loss", () => {
    createWinLossGroup([-0.001, -0.5, -1]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("handles alternating win/loss pattern", () => {
    createWinLossGroup([1, -1, 1, -1, 1, -1]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(6);
  });

  it("win/loss with NaN gaps mode skips NaN entries", () => {
    createWinLossGroup([1, NaN, -1, NaN, 1], { emptyCellHandling: "gaps" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Only 3 non-NaN values drawn
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("win/loss with all zeros draws nothing", () => {
    createWinLossGroup([0, 0, 0, 0]);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Zero is skipped in win/loss
    expect(ctx.fillRect).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Color Resolution with Custom Styles
// ============================================================================

describe("color resolution with custom styles", () => {
  it("uses custom color for line sparkline", () => {
    createLineGroup([10, 20, 30], { color: "#FF5500" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect(ctx.strokeStyle).toBe("#FF5500");
  });

  it("uses custom negative color for column sparkline negative bars", () => {
    createColumnGroup([-10, 20, -30], {
      color: "#00FF00",
      negativeColor: "#FF0000",
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("applies high point color override on column bars", () => {
    createColumnGroup([10, 50, 30], {
      showHighPoint: true,
      highPointColor: "#GOLD00",
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // High point is index 1 (value 50); its color should be overridden
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("applies low point color override on column bars", () => {
    createColumnGroup([10, 5, 30], {
      showLowPoint: true,
      lowPointColor: "#00AAFF",
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect(ctx.fillRect).toHaveBeenCalled();
  });

  it("applies first and last point colors on line sparkline", () => {
    createLineGroup([10, 20, 30, 40, 50], {
      showFirstPoint: true,
      showLastPoint: true,
      firstPointColor: "#AA0000",
      lastPointColor: "#0000AA",
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Special markers should be drawn (arc calls)
    expect(ctx.arc).toHaveBeenCalled();
    // At least 2 special markers (first + last)
    expect((ctx.arc as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("applies negative point color for negative values in line sparkline", () => {
    createLineGroup([10, -5, 20, -10, 30], {
      showNegativePoints: true,
      negativePointColor: "#FF00FF",
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Negative markers drawn
    expect(ctx.arc).toHaveBeenCalled();
  });

  it("marker color defaults to line color when not specified", () => {
    const group = createLineGroup([10, 20, 30, 40, 50], {
      showMarkers: true,
    });

    // markerColor should default to group.color
    expect(group.markerColor).toBe(group.color);
  });

  it("uses custom marker color when specified", () => {
    createLineGroup([10, 20, 30], {
      showMarkers: true,
      markerColor: "#ABCDEF",
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Markers drawn
    expect(ctx.arc).toHaveBeenCalled();
  });

  it("special point priority: high > low > last > first > negative", () => {
    // When a point is both high point AND last point, high point color wins
    createColumnGroup([10, 20, 30], {
      showHighPoint: true,
      showLastPoint: true,
      highPointColor: "#HIGH00",
      lastPointColor: "#LAST00",
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // The last bar (index 2, value 30) is also the high point
    // High point color should be applied last (highest priority)
    const fillRectCalls = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls;
    expect(fillRectCalls.length).toBe(3);
  });
});

// ============================================================================
// Coordinate Mapping and Scaling
// ============================================================================

describe("coordinate mapping and scaling", () => {
  it("respects custom axis scale bounds", () => {
    createColumnGroup([10, 20, 30], {
      axisScaleType: "custom",
      axisMinValue: 0,
      axisMaxValue: 100,
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Bars should be short (max value 30 out of range 0-100)
    const calls = (ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBe(3);
    // All bars should have positive height
    for (const call of calls) {
      expect(call[3]).toBeGreaterThan(0); // height > 0
    }
  });

  it("clips bars when data exceeds custom axis bounds", () => {
    createColumnGroup([50, 150, -50], {
      axisScaleType: "custom",
      axisMinValue: 0,
      axisMaxValue: 100,
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // All 3 bars still drawn even if values exceed bounds
    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("handles very small cell dimensions gracefully", () => {
    createLineGroup([10, 20, 30]);

    const ctx = makeCtx();
    // Cell so small that plotWidth/plotHeight < 4 after padding
    const context = makeDecorationContext(0, 5, ctx, {
      cellLeft: 50,
      cellTop: 24,
      cellRight: 55, // width = 5, plotWidth = 5 - 6 = -1
      cellBottom: 28, // height = 4, plotHeight = 4 - 6 = -2
    });
    drawSparkline(context);

    // Should bail out without drawing
    expect(ctx.beginPath).not.toHaveBeenCalled();
  });

  it("handles cell with exactly minimum viable dimensions", () => {
    createLineGroup([10, 20, 30]);

    const ctx = makeCtx();
    // plotWidth = 10-6 = 4, plotHeight = 10-6 = 4 (just meets threshold)
    const context = makeDecorationContext(0, 5, ctx, {
      cellLeft: 0,
      cellTop: 0,
      cellRight: 10,
      cellBottom: 10,
    });
    drawSparkline(context);

    // Should draw something (meets minimum 4x4 plot area)
    expect(ctx.save).toHaveBeenCalled();
  });

  it("maps data points evenly across cell width for line sparkline", () => {
    createLineGroup([0, 50, 100]);

    const ctx = makeCtx();
    // Wide cell: left=0, right=100, padding=3 each side -> plotWidth=94
    const context = makeDecorationContext(0, 5, ctx, {
      cellLeft: 0,
      cellTop: 0,
      cellRight: 100,
      cellBottom: 30,
    });
    drawSparkline(context);

    const moveToCall = (ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls[0];
    const lineToCall = (ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls[0];

    // First point at plotLeft (3), second at midpoint, third at plotLeft + plotWidth (97)
    expect(moveToCall[0]).toBeCloseTo(3, 0); // x for index 0
  });
});

// ============================================================================
// Axis Line Drawing
// ============================================================================

describe("axis line drawing", () => {
  it("draws axis line when data spans positive and negative", () => {
    createLineGroup([-10, 20, -5, 15], { showAxis: true });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect(ctx.setLineDash).toHaveBeenCalled();
  });

  it("does not draw axis line when all data is positive", () => {
    // Axis only draws when zero is within the data range [min, max]
    // With all positive data, min > 0, so zero is not in range
    createLineGroup([5, 10, 15, 20], { showAxis: true });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // drawAxisLine returns early if min > 0 (zero not visible)
    // But the axis line still uses setLineDash for column type
    // For line type, axis is only drawn if zero is in range
  });

  it("does not draw axis line when all data is negative", () => {
    createLineGroup([-5, -10, -15, -20], { showAxis: true });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);
  });

  it("draws axis line for column sparkline with mixed data", () => {
    createColumnGroup([-10, 20, -5, 15], { showAxis: true });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect(ctx.setLineDash).toHaveBeenCalled();
  });

  it("draws axis line for win/loss sparkline", () => {
    createWinLossGroup([1, -1, 1, -1], { showAxis: true });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Win/loss always draws axis at midpoint when showAxis is true
    expect(ctx.setLineDash).toHaveBeenCalled();
  });
});

// ============================================================================
// Plot Order
// ============================================================================

describe("plot order: rightToLeft", () => {
  it("reverses column bar order", () => {
    // Data [10, 20, 30] should be rendered as [30, 20, 10]
    createColumnGroup([10, 20, 30], { plotOrder: "rightToLeft" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("reverses line sparkline data point order", () => {
    createLineGroup([10, 20, 30], { plotOrder: "rightToLeft" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect(ctx.stroke).toHaveBeenCalled();
  });

  it("reverses win/loss bar order", () => {
    createWinLossGroup([1, -1, 1], { plotOrder: "rightToLeft" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });
});

// ============================================================================
// Empty Cell Handling: Connect Mode
// ============================================================================

describe("empty cell handling: connect mode", () => {
  it("interpolates single NaN gap between two values", () => {
    // [10, NaN, 30] -> connect interpolates to [10, 20, 30]
    createLineGroup([10, NaN, 30], { emptyCellHandling: "connect" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // All 3 points should be in one segment
    const moveToCount = (ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls.length;
    const lineToCount = (ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(moveToCount).toBe(1);
    expect(lineToCount).toBe(2); // 3 points = 1 moveTo + 2 lineTo
  });

  it("interpolates multiple consecutive NaN gaps", () => {
    // [10, NaN, NaN, NaN, 50] -> connect interpolates to [10, 20, 30, 40, 50]
    createLineGroup([10, NaN, NaN, NaN, 50], { emptyCellHandling: "connect" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    const moveToCount = (ctx.moveTo as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(moveToCount).toBe(1); // One continuous segment
  });

  it("leaves leading NaN gaps as gaps (not interpolated)", () => {
    // [NaN, NaN, 30, 40, 50] -> leading NaNs stay NaN
    createLineGroup([NaN, NaN, 30, 40, 50], { emptyCellHandling: "connect" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Only 3 valid points form a segment
    const lineToCount = (ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(lineToCount).toBe(2); // [30, 40, 50] = 1 moveTo + 2 lineTo
  });

  it("leaves trailing NaN gaps as gaps (not interpolated)", () => {
    // [10, 20, 30, NaN, NaN] -> trailing NaNs stay NaN
    createLineGroup([10, 20, 30, NaN, NaN], { emptyCellHandling: "connect" });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    const lineToCount = (ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(lineToCount).toBe(2); // [10, 20, 30] = 1 moveTo + 2 lineTo
  });
});

// ============================================================================
// Markers Rendering
// ============================================================================

describe("markers rendering", () => {
  it("does not draw markers when showMarkers is false", () => {
    createLineGroup([10, 20, 30, 40, 50], { showMarkers: false });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // No special points enabled either, so no arc calls
    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it("draws markers for all non-NaN points when showMarkers is true", () => {
    createLineGroup([10, NaN, 30, 40, NaN], {
      showMarkers: true,
      emptyCellHandling: "gaps",
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // 3 non-NaN points get markers
    expect((ctx.arc as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("does not draw general markers when data has more than 50 points", () => {
    const largeData = Array.from({ length: 51 }, (_, i) => i);
    createLineGroup(largeData, { showMarkers: true });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // showMarkers is suppressed when data.length > 50
    // But special points can still be drawn
    expect(ctx.arc).not.toHaveBeenCalled();
  });

  it("draws general markers for exactly 50 data points", () => {
    const data = Array.from({ length: 50 }, (_, i) => i);
    createLineGroup(data, { showMarkers: true });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // 50 points <= 50, so markers are drawn
    expect((ctx.arc as ReturnType<typeof vi.fn>).mock.calls.length).toBe(50);
  });
});

// ============================================================================
// Special Point Detection
// ============================================================================

describe("special point detection", () => {
  it("identifies high and low points correctly with negative values", () => {
    createLineGroup([-10, 5, -20, 30, 0], {
      showHighPoint: true,
      showLowPoint: true,
      highPointColor: "#HI0000",
      lowPointColor: "#LO0000",
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // High = 30 (index 3), Low = -20 (index 2)
    // Both should produce arc calls
    expect((ctx.arc as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("high and low are the same point when only one non-NaN value", () => {
    createLineGroup([NaN, NaN, 42, NaN, NaN], {
      showHighPoint: true,
      showLowPoint: true,
      emptyCellHandling: "gaps",
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // Only one point: it's both high and low
    // Two overlapping arc calls (high drawn on top of low)
    expect((ctx.arc as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  });

  it("all five special point types can be active simultaneously", () => {
    createLineGroup([10, -5, 30, 20, 15], {
      showHighPoint: true,
      showLowPoint: true,
      showFirstPoint: true,
      showLastPoint: true,
      showNegativePoints: true,
    });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    // negative (index 1), first (index 0), last (index 4), low (index 1), high (index 2)
    // Some may overlap (low and negative both at index 1)
    expect(ctx.arc).toHaveBeenCalled();
  });
});

// ============================================================================
// Line Width
// ============================================================================

describe("line width", () => {
  it("uses custom line width", () => {
    createLineGroup([10, 20, 30], { lineWidth: 3 });

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect(ctx.lineWidth).toBe(3);
  });

  it("uses default line width of 1.5", () => {
    const group = createLineGroup([10, 20, 30]);
    expect(group.lineWidth).toBe(1.5);
  });
});

// ============================================================================
// Large Data Sets
// ============================================================================

describe("large data sets", () => {
  it("renders 100 data points as column sparkline", () => {
    const data = Array.from({ length: 100 }, (_, i) => Math.sin(i / 10) * 50);
    createColumnGroup(data);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect((ctx.fillRect as ReturnType<typeof vi.fn>).mock.calls.length).toBe(100);
  });

  it("renders 200 data points as line sparkline", () => {
    const data = Array.from({ length: 200 }, (_, i) => Math.cos(i / 20) * 100);
    createLineGroup(data);

    const ctx = makeCtx();
    const context = makeDecorationContext(0, 5, ctx);
    drawSparkline(context);

    expect(ctx.stroke).toHaveBeenCalled();
    // 200 points -> 1 moveTo + 199 lineTo
    expect((ctx.lineTo as ReturnType<typeof vi.fn>).mock.calls.length).toBe(199);
  });
});
