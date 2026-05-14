//! FILENAME: app/extensions/Charts/rendering/__tests__/gradientFill.test.ts
// PURPOSE: Tests for gradient fill utilities and Canvas 2D gradient creation.

import { describe, it, expect, vi } from "vitest";
import {
  createCanvasGradient,
  applyFillStyle,
  autoGradientFromColor,
  lightenHexColor,
} from "../gradientFill";
import type { GradientFill, GradientDirection } from "../../types";

// ============================================================================
// Mock Canvas Context
// ============================================================================

function makeCtx(): CanvasRenderingContext2D {
  const mockGradient = {
    addColorStop: vi.fn(),
  };
  return {
    createLinearGradient: vi.fn().mockReturnValue(mockGradient),
    createRadialGradient: vi.fn().mockReturnValue(mockGradient),
    fillStyle: "",
  } as unknown as CanvasRenderingContext2D;
}

// ============================================================================
// createCanvasGradient
// ============================================================================

describe("createCanvasGradient", () => {
  describe("linear gradients", () => {
    it("creates a linear gradient with default direction (topToBottom)", () => {
      const ctx = makeCtx();
      const fill: GradientFill = {
        type: "linear",
        stops: [
          { offset: 0, color: "#FF0000" },
          { offset: 1, color: "#0000FF" },
        ],
      };

      createCanvasGradient(ctx, fill, 10, 20, 100, 200);

      expect(ctx.createLinearGradient).toHaveBeenCalledWith(
        60, 20, // x0=10+0.5*100, y0=20+0*200
        60, 220, // x1=10+0.5*100, y1=20+1*200
      );
    });

    it("creates a leftToRight gradient", () => {
      const ctx = makeCtx();
      const fill: GradientFill = {
        type: "linear",
        direction: "leftToRight",
        stops: [
          { offset: 0, color: "#FF0000" },
          { offset: 1, color: "#0000FF" },
        ],
      };

      createCanvasGradient(ctx, fill, 0, 0, 200, 100);

      expect(ctx.createLinearGradient).toHaveBeenCalledWith(
        0, 50,  // x0=0, y0=50
        200, 50, // x1=200, y1=50
      );
    });

    it("creates a topLeftToBottomRight diagonal gradient", () => {
      const ctx = makeCtx();
      const fill: GradientFill = {
        type: "linear",
        direction: "topLeftToBottomRight",
        stops: [
          { offset: 0, color: "#000" },
          { offset: 1, color: "#FFF" },
        ],
      };

      createCanvasGradient(ctx, fill, 0, 0, 100, 100);

      expect(ctx.createLinearGradient).toHaveBeenCalledWith(0, 0, 100, 100);
    });

    it("adds color stops to the gradient", () => {
      const ctx = makeCtx();
      const fill: GradientFill = {
        type: "linear",
        stops: [
          { offset: 0, color: "#FF0000" },
          { offset: 0.5, color: "#00FF00" },
          { offset: 1, color: "#0000FF" },
        ],
      };

      const gradient = createCanvasGradient(ctx, fill, 0, 0, 100, 100);

      expect(gradient.addColorStop).toHaveBeenCalledTimes(3);
      expect(gradient.addColorStop).toHaveBeenCalledWith(0, "#FF0000");
      expect(gradient.addColorStop).toHaveBeenCalledWith(0.5, "#00FF00");
      expect(gradient.addColorStop).toHaveBeenCalledWith(1, "#0000FF");
    });

    it("clamps stop offsets to 0-1 range", () => {
      const ctx = makeCtx();
      const fill: GradientFill = {
        type: "linear",
        stops: [
          { offset: -0.5, color: "#FF0000" },
          { offset: 1.5, color: "#0000FF" },
        ],
      };

      const gradient = createCanvasGradient(ctx, fill, 0, 0, 100, 100);

      expect(gradient.addColorStop).toHaveBeenCalledWith(0, "#FF0000");
      expect(gradient.addColorStop).toHaveBeenCalledWith(1, "#0000FF");
    });
  });

  describe("radial gradients", () => {
    it("creates a centered radial gradient", () => {
      const ctx = makeCtx();
      const fill: GradientFill = {
        type: "radial",
        stops: [
          { offset: 0, color: "#FFF" },
          { offset: 1, color: "#000" },
        ],
      };

      createCanvasGradient(ctx, fill, 0, 0, 200, 100);

      // Center at (100, 50), radius = max(200,100)/2 = 100
      expect(ctx.createRadialGradient).toHaveBeenCalledWith(100, 50, 0, 100, 50, 100);
    });
  });

  describe("all gradient directions", () => {
    const directions: GradientDirection[] = [
      "topToBottom", "bottomToTop", "leftToRight", "rightToLeft",
      "topLeftToBottomRight", "bottomRightToTopLeft",
      "topRightToBottomLeft", "bottomLeftToTopRight",
    ];

    for (const dir of directions) {
      it(`handles direction "${dir}" without error`, () => {
        const ctx = makeCtx();
        const fill: GradientFill = {
          type: "linear",
          direction: dir,
          stops: [
            { offset: 0, color: "#000" },
            { offset: 1, color: "#FFF" },
          ],
        };
        expect(() => createCanvasGradient(ctx, fill, 0, 0, 100, 100)).not.toThrow();
        expect(ctx.createLinearGradient).toHaveBeenCalled();
      });
    }
  });
});

// ============================================================================
// applyFillStyle
// ============================================================================

describe("applyFillStyle", () => {
  it("applies solid color when no gradient specified", () => {
    const ctx = makeCtx();
    const result = applyFillStyle(ctx, "#FF0000", undefined, 0, 0, 100, 100);

    expect(result).toBe(false);
    expect(ctx.fillStyle).toBe("#FF0000");
    expect(ctx.createLinearGradient).not.toHaveBeenCalled();
  });

  it("applies gradient when fill has 2+ stops", () => {
    const ctx = makeCtx();
    const fill: GradientFill = {
      type: "linear",
      stops: [
        { offset: 0, color: "#FF0000" },
        { offset: 1, color: "#0000FF" },
      ],
    };

    const result = applyFillStyle(ctx, "#FF0000", fill, 0, 0, 100, 100);

    expect(result).toBe(true);
    expect(ctx.createLinearGradient).toHaveBeenCalled();
  });

  it("falls back to solid color when fill has fewer than 2 stops", () => {
    const ctx = makeCtx();
    const fill: GradientFill = {
      type: "linear",
      stops: [{ offset: 0, color: "#FF0000" }],
    };

    const result = applyFillStyle(ctx, "#00FF00", fill, 0, 0, 100, 100);

    expect(result).toBe(false);
    expect(ctx.fillStyle).toBe("#00FF00");
  });
});

// ============================================================================
// autoGradientFromColor
// ============================================================================

describe("autoGradientFromColor", () => {
  it("creates a two-stop linear gradient from a base color", () => {
    const gradient = autoGradientFromColor("#4E79A7");

    expect(gradient.type).toBe("linear");
    expect(gradient.direction).toBe("topToBottom");
    expect(gradient.stops).toHaveLength(2);
    expect(gradient.stops[0].offset).toBe(0);
    expect(gradient.stops[0].color).toBe("#4E79A7");
    expect(gradient.stops[1].offset).toBe(1);
    // Second stop should be lighter
    expect(gradient.stops[1].color).not.toBe("#4E79A7");
  });

  it("respects custom direction", () => {
    const gradient = autoGradientFromColor("#FF0000", 0.3, "leftToRight");
    expect(gradient.direction).toBe("leftToRight");
  });

  it("respects custom lighten amount", () => {
    const light = autoGradientFromColor("#000000", 0.5);
    const lighter = autoGradientFromColor("#000000", 0.8);
    // More lighten = lighter second stop
    const lightVal = parseInt(light.stops[1].color.substring(1, 3), 16);
    const lighterVal = parseInt(lighter.stops[1].color.substring(1, 3), 16);
    expect(lighterVal).toBeGreaterThan(lightVal);
  });
});

// ============================================================================
// lightenHexColor
// ============================================================================

describe("lightenHexColor", () => {
  it("returns white when amount is 1", () => {
    expect(lightenHexColor("#000000", 1)).toBe("#ffffff");
  });

  it("returns the same color when amount is 0", () => {
    expect(lightenHexColor("#4E79A7", 0)).toBe("#4e79a7");
  });

  it("lightens colors proportionally", () => {
    const result = lightenHexColor("#000000", 0.5);
    // Each channel should be 128 (half way to white)
    expect(result).toBe("#808080");
  });

  it("handles 3-character hex codes", () => {
    const result = lightenHexColor("#F00", 0);
    expect(result).toBe("#ff0000");
  });

  it("returns valid hex color", () => {
    const result = lightenHexColor("#4E79A7", 0.3);
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
  });
});

// ============================================================================
// GradientFill type validation
// ============================================================================

describe("GradientFill type", () => {
  it("supports linear gradient specification", () => {
    const fill: GradientFill = {
      type: "linear",
      direction: "topToBottom",
      stops: [
        { offset: 0, color: "#FF0000" },
        { offset: 0.5, color: "#00FF00" },
        { offset: 1, color: "#0000FF" },
      ],
    };
    expect(fill.stops).toHaveLength(3);
  });

  it("supports radial gradient specification", () => {
    const fill: GradientFill = {
      type: "radial",
      stops: [
        { offset: 0, color: "#FFFFFF" },
        { offset: 1, color: "#000000" },
      ],
    };
    expect(fill.type).toBe("radial");
  });

  it("JSON roundtrip preserves all fields", () => {
    const fill: GradientFill = {
      type: "linear",
      direction: "topLeftToBottomRight",
      stops: [
        { offset: 0, color: "#FF0000" },
        { offset: 0.33, color: "#00FF00" },
        { offset: 0.66, color: "#0000FF" },
        { offset: 1, color: "#FFFF00" },
      ],
    };

    const parsed: GradientFill = JSON.parse(JSON.stringify(fill));
    expect(parsed.type).toBe("linear");
    expect(parsed.direction).toBe("topLeftToBottomRight");
    expect(parsed.stops).toHaveLength(4);
    expect(parsed.stops[1].offset).toBe(0.33);
    expect(parsed.stops[1].color).toBe("#00FF00");
  });
});
