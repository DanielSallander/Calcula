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
  type GridLayerContext,
} from "../gridLayers";

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
