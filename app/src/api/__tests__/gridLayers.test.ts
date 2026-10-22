//! FILENAME: app/src/api/__tests__/gridLayers.test.ts
// PURPOSE: Unit tests for the grid-layer registry (granular bricks phase 4):
//          anchor buckets, priority order, error containment, save/restore
//          balance, and fast flags.

import { describe, it, expect, vi } from "vitest";
import {
  registerGridLayer,
  unregisterGridLayer,
  hasGridLayers,
  paintGridLayers,
  listGridLayers,
  cellAreaOrigin,
  gridlineGeometry,
  rangeToCanvasRect,
  type GridLayerContext,
} from "../gridLayers";
import { gridlineGeometry as coreGridlineGeometry } from "../../core/lib/gridRenderer/rendering/grid";
import { DEFAULT_GRID_CONFIG } from "../../core/types";

function mockContext(): GridLayerContext {
  return {
    ctx: {
      save: vi.fn(),
      restore: vi.fn(),
      fillRect: vi.fn(),
    } as unknown as CanvasRenderingContext2D,
    config: {} as never,
    viewport: {} as never,
    dimensions: {} as never,
    canvasWidth: 800,
    canvasHeight: 600,
    freezeConfig: null,
  };
}

describe("gridLayers registry", () => {
  it("paints layers at their anchor in priority order", () => {
    const order: string[] = [];
    const c1 = registerGridLayer({
      id: "late",
      anchor: "under-selection",
      priority: 10,
      paint: () => order.push("late"),
    });
    const c2 = registerGridLayer({
      id: "early",
      anchor: "under-selection",
      priority: 1,
      paint: () => order.push("early"),
    });
    const c3 = registerGridLayer({
      id: "other-anchor",
      anchor: "over-headers",
      paint: () => order.push("other"),
    });
    try {
      expect(hasGridLayers("under-selection")).toBe(true);
      expect(hasGridLayers("under-cells")).toBe(false);
      paintGridLayers("under-selection", mockContext());
      expect(order).toEqual(["early", "late"]);
    } finally {
      c1();
      c2();
      c3();
    }
    expect(hasGridLayers("under-selection")).toBe(false);
    expect(hasGridLayers("over-headers")).toBe(false);
  });

  it("contains layer errors and keeps painting the rest, save/restore balanced", () => {
    const painted = vi.fn();
    const c1 = registerGridLayer({
      id: "boom",
      anchor: "over-selection",
      priority: 0,
      paint: () => {
        throw new Error("boom");
      },
    });
    const c2 = registerGridLayer({
      id: "ok",
      anchor: "over-selection",
      priority: 1,
      paint: painted,
    });
    const context = mockContext();
    try {
      paintGridLayers("over-selection", context);
      expect(painted).toHaveBeenCalledTimes(1);
      // One save/restore pair per layer, even when a layer throws.
      expect(context.ctx.save).toHaveBeenCalledTimes(2);
      expect(context.ctx.restore).toHaveBeenCalledTimes(2);
    } finally {
      c1();
      c2();
    }
  });

  it("unregisters by id across anchors and lists sorted", () => {
    registerGridLayer({ id: "b", anchor: "under-cells", paint: () => {} });
    registerGridLayer({ id: "a", anchor: "over-headers", paint: () => {} });
    try {
      expect(listGridLayers().map((l) => l.id)).toEqual(["a", "b"]);
      unregisterGridLayer("b");
      expect(hasGridLayers("under-cells")).toBe(false);
      expect(listGridLayers().map((l) => l.id)).toEqual(["a"]);
    } finally {
      unregisterGridLayer("a");
    }
  });
});

describe("gridLayers geometry for a painter that lands on Core's own lines", () => {
  it("gridlineGeometry IS Core's (the function both gridline painters call), not a copy", () => {
    expect(gridlineGeometry).toBe(coreGridlineGeometry);
    const ctx = { getTransform: () => ({ a: 2 }) } as unknown as CanvasRenderingContext2D;
    const g = gridlineGeometry(ctx);
    expect(g.lineWidth).toBe(0.5);
    expect(g.snap(150.58)).toBe((Math.round(150.58 * 2) + 0.5) / 2);
  });

  it("cellAreaOrigin is the cell area's top-left: below and right of the headers, 0 when they are hidden", () => {
    const ctx = mockContext();
    expect(cellAreaOrigin({ ...ctx, config: { rowHeaderWidth: 22, colHeaderHeight: 20 } as never })).toEqual({ x: 22, y: 20 });
    // View > Headings off: the frame's (effective) config carries 0, a real answer.
    expect(cellAreaOrigin({ ...ctx, config: { rowHeaderWidth: 0, colHeaderHeight: 0 } as never })).toEqual({ x: 0, y: 0 });
    // A config with no sizes reads the product defaults, as every painter does.
    expect(cellAreaOrigin({ ...ctx, config: {} as never })).toEqual({
      x: DEFAULT_GRID_CONFIG.rowHeaderWidth,
      y: DEFAULT_GRID_CONFIG.colHeaderHeight,
    });
  });

  it("cellAreaOrigin agrees with where rangeToCanvasRect clips a range under the headers", () => {
    const ctx: GridLayerContext = {
      ...mockContext(),
      config: { ...DEFAULT_GRID_CONFIG, rowHeaderWidth: 30, colHeaderHeight: 25 },
      viewport: { scrollX: 100, scrollY: 100, startRow: 0, startCol: 0, rowCount: 30, colCount: 10 },
      dimensions: { columnWidths: new Map(), rowHeights: new Map() } as never,
    };
    const rect = rangeToCanvasRect(ctx, 0, 0, 20, 5)!;
    expect(rect.clippedTop && rect.clippedLeft).toBe(true);
    expect({ x: rect.x, y: rect.y }).toEqual(cellAreaOrigin(ctx));
  });
});
