//! FILENAME: app/extensions/Charts/rendering/__tests__/gradientFill-deep.test.ts
// PURPOSE: Deep tests for gradient fill — multiple stops, edge cases, radial gradients.

import { describe, it, expect, vi } from "vitest";
import {
  createCanvasGradient,
  applyFillStyle,
  autoGradientFromColor,
  lightenHexColor,
} from "../gradientFill";
import type { GradientFill } from "../../types";

// ============================================================================
// Helpers
// ============================================================================

function makeCtx() {
  const stops: Array<[number, string]> = [];
  const mockGradient = {
    addColorStop: vi.fn((offset: number, color: string) => stops.push([offset, color])),
    _stops: stops,
  };
  return {
    ctx: {
      createLinearGradient: vi.fn().mockReturnValue(mockGradient),
      createRadialGradient: vi.fn().mockReturnValue(mockGradient),
      fillStyle: "",
    } as unknown as CanvasRenderingContext2D,
    mockGradient,
    stops,
  };
}

// ============================================================================
// Multiple Color Stops
// ============================================================================

describe("gradientFill - multiple color stops", () => {
  it("handles exactly 2 stops", () => {
    const { ctx, mockGradient } = makeCtx();
    const fill: GradientFill = {
      type: "linear",
      stops: [
        { offset: 0, color: "#000" },
        { offset: 1, color: "#fff" },
      ],
    };
    createCanvasGradient(ctx, fill, 0, 0, 100, 100);
    expect(mockGradient.addColorStop).toHaveBeenCalledTimes(2);
  });

  it("handles 3 stops", () => {
    const { ctx, mockGradient } = makeCtx();
    const fill: GradientFill = {
      type: "linear",
      stops: [
        { offset: 0, color: "#f00" },
        { offset: 0.5, color: "#0f0" },
        { offset: 1, color: "#00f" },
      ],
    };
    createCanvasGradient(ctx, fill, 0, 0, 100, 100);
    expect(mockGradient.addColorStop).toHaveBeenCalledTimes(3);
    expect(mockGradient.addColorStop).toHaveBeenCalledWith(0.5, "#0f0");
  });

  it("handles 5 stops", () => {
    const { ctx, mockGradient } = makeCtx();
    const fill: GradientFill = {
      type: "linear",
      stops: Array.from({ length: 5 }, (_, i) => ({
        offset: i / 4,
        color: `#${(i * 60).toString(16).padStart(2, "0")}0000`,
      })),
    };
    createCanvasGradient(ctx, fill, 0, 0, 200, 200);
    expect(mockGradient.addColorStop).toHaveBeenCalledTimes(5);
  });

  it("handles 10 stops", () => {
    const { ctx, mockGradient } = makeCtx();
    const fill: GradientFill = {
      type: "linear",
      stops: Array.from({ length: 10 }, (_, i) => ({
        offset: i / 9,
        color: "#aabbcc",
      })),
    };
    createCanvasGradient(ctx, fill, 0, 0, 100, 100);
    expect(mockGradient.addColorStop).toHaveBeenCalledTimes(10);
  });
});

// ============================================================================
// Edge Cases: Single Stop, Same Position, Reverse Order
// ============================================================================

describe("gradientFill - edge cases", () => {
  it("handles a single stop without error", () => {
    const { ctx, mockGradient } = makeCtx();
    const fill: GradientFill = {
      type: "linear",
      stops: [{ offset: 0.5, color: "#ff0000" }],
    };
    expect(() => createCanvasGradient(ctx, fill, 0, 0, 100, 100)).not.toThrow();
    expect(mockGradient.addColorStop).toHaveBeenCalledTimes(1);
  });

  it("handles two stops at the same position", () => {
    const { ctx, mockGradient } = makeCtx();
    const fill: GradientFill = {
      type: "linear",
      stops: [
        { offset: 0.5, color: "#ff0000" },
        { offset: 0.5, color: "#0000ff" },
      ],
    };
    expect(() => createCanvasGradient(ctx, fill, 0, 0, 100, 100)).not.toThrow();
    expect(mockGradient.addColorStop).toHaveBeenCalledTimes(2);
  });

  it("handles stops in reverse order", () => {
    const { ctx, stops } = makeCtx();
    const fill: GradientFill = {
      type: "linear",
      stops: [
        { offset: 1, color: "#0000ff" },
        { offset: 0, color: "#ff0000" },
      ],
    };
    createCanvasGradient(ctx, fill, 0, 0, 100, 100);
    // Stops should be added in the order provided (no auto-sorting)
    expect(stops[0][0]).toBe(1);
    expect(stops[1][0]).toBe(0);
  });

  it("clamps negative offsets to 0", () => {
    const { ctx, stops } = makeCtx();
    const fill: GradientFill = {
      type: "linear",
      stops: [{ offset: -2, color: "#000" }, { offset: 1, color: "#fff" }],
    };
    createCanvasGradient(ctx, fill, 0, 0, 100, 100);
    expect(stops[0][0]).toBe(0);
  });

  it("clamps offsets above 1 to 1", () => {
    const { ctx, stops } = makeCtx();
    const fill: GradientFill = {
      type: "linear",
      stops: [{ offset: 0, color: "#000" }, { offset: 3.5, color: "#fff" }],
    };
    createCanvasGradient(ctx, fill, 0, 0, 100, 100);
    expect(stops[1][0]).toBe(1);
  });

  it("applyFillStyle falls back to solid with empty stops array", () => {
    const { ctx } = makeCtx();
    const fill: GradientFill = { type: "linear", stops: [] };
    const result = applyFillStyle(ctx, "#abc", fill, 0, 0, 100, 100);
    expect(result).toBe(false);
    expect(ctx.fillStyle).toBe("#abc");
  });
});

// ============================================================================
// Radial Gradient Sizing
// ============================================================================

describe("gradientFill - radial gradient details", () => {
  it("uses max(w,h)/2 as outer radius for non-square bounds", () => {
    const { ctx } = makeCtx();
    const fill: GradientFill = {
      type: "radial",
      stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }],
    };
    createCanvasGradient(ctx, fill, 10, 20, 300, 100);
    // center=(160,70), r=max(300,100)/2=150
    expect(ctx.createRadialGradient).toHaveBeenCalledWith(160, 70, 0, 160, 70, 150);
  });

  it("uses correct center for offset bounds", () => {
    const { ctx } = makeCtx();
    const fill: GradientFill = {
      type: "radial",
      stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }],
    };
    createCanvasGradient(ctx, fill, 50, 50, 200, 200);
    expect(ctx.createRadialGradient).toHaveBeenCalledWith(150, 150, 0, 150, 150, 100);
  });

  it("ignores direction property for radial gradients", () => {
    const { ctx } = makeCtx();
    const fill: GradientFill = {
      type: "radial",
      direction: "leftToRight",
      stops: [{ offset: 0, color: "#fff" }, { offset: 1, color: "#000" }],
    };
    createCanvasGradient(ctx, fill, 0, 0, 100, 100);
    // Should use radial, not linear
    expect(ctx.createRadialGradient).toHaveBeenCalled();
    expect(ctx.createLinearGradient).not.toHaveBeenCalled();
  });
});

// ============================================================================
// autoGradientFromColor - deeper
// ============================================================================

describe("gradientFill - autoGradientFromColor edge cases", () => {
  it("lighten=0 produces identical start and end colors", () => {
    const g = autoGradientFromColor("#4E79A7", 0);
    expect(g.stops[0].color).toBe("#4E79A7");
    expect(g.stops[1].color).toBe(lightenHexColor("#4E79A7", 0));
  });

  it("lighten=1 produces white as end color", () => {
    const g = autoGradientFromColor("#4E79A7", 1);
    expect(g.stops[1].color).toBe("#ffffff");
  });

  it("works with pure black", () => {
    const g = autoGradientFromColor("#000000", 0.5);
    expect(g.stops[0].color).toBe("#000000");
    expect(g.stops[1].color).toBe("#808080");
  });

  it("works with pure white", () => {
    const g = autoGradientFromColor("#ffffff", 0.5);
    expect(g.stops[0].color).toBe("#ffffff");
    expect(g.stops[1].color).toBe("#ffffff");
  });
});

// ============================================================================
// lightenHexColor - deeper
// ============================================================================

describe("gradientFill - lightenHexColor edge cases", () => {
  it("handles 3-char shorthand #F0F", () => {
    const result = lightenHexColor("#F0F", 0);
    expect(result).toBe("#ff00ff");
  });

  it("handles uppercase and lowercase hex", () => {
    const upper = lightenHexColor("#AABBCC", 0.5);
    const lower = lightenHexColor("#aabbcc", 0.5);
    expect(upper).toBe(lower);
  });

  it("all channels lighten independently", () => {
    // R=100, G=0, B=200, lighten by 0.5
    const result = lightenHexColor("#6400C8", 0.5);
    const r = parseInt(result.substring(1, 3), 16);
    const g = parseInt(result.substring(3, 5), 16);
    const b = parseInt(result.substring(5, 7), 16);
    expect(r).toBe(Math.round(100 + (255 - 100) * 0.5)); // 178
    expect(g).toBe(Math.round(0 + 255 * 0.5)); // 128
    expect(b).toBe(Math.round(200 + (255 - 200) * 0.5)); // 228
  });
});
