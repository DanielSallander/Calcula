//! FILENAME: app/extensions/Charts/rendering/__tests__/colorHelpers.test.ts
// PURPOSE: Tests for darkenColor (trendlinePainter) and lightenHexColor (gradientFill).

import { describe, it, expect } from "vitest";
import { darkenColor } from "../trendlinePainter";
import { lightenHexColor, autoGradientFromColor } from "../gradientFill";

// ============================================================================
// darkenColor
// ============================================================================

describe("darkenColor", () => {
  it("returns same color for amount 0", () => {
    expect(darkenColor("#ffffff", 0)).toBe("#ffffff");
  });

  it("returns black for amount 1", () => {
    expect(darkenColor("#ffffff", 1)).toBe("#000000");
  });

  it("darkens red by 50%", () => {
    const result = darkenColor("#ff0000", 0.5);
    // R: 255 * 0.5 = 128 -> 0x80
    expect(result).toBe("#800000");
  });

  it("darkens a mid-tone color", () => {
    const result = darkenColor("#4472c4", 0.3);
    // R: 68 * 0.7 ~= 48 -> 0x30
    // G: 114 * 0.7 ~= 80 -> 0x50
    // B: 196 * 0.7 ~= 137 -> 0x89
    expect(result).toMatch(/^#[0-9a-f]{6}$/);
    // Verify it's darker than original
    const origR = parseInt("44", 16);
    const resultR = parseInt(result.slice(1, 3), 16);
    expect(resultR).toBeLessThan(origR);
  });
});

// ============================================================================
// lightenHexColor
// ============================================================================

describe("lightenHexColor", () => {
  it("returns same color for amount 0", () => {
    expect(lightenHexColor("#000000", 0)).toBe("#000000");
  });

  it("returns white for amount 1", () => {
    expect(lightenHexColor("#000000", 1)).toBe("#ffffff");
  });

  it("lightens black by 50%", () => {
    const result = lightenHexColor("#000000", 0.5);
    // Each channel: 0 + (255-0)*0.5 = 128 -> 0x80
    expect(result).toBe("#808080");
  });

  it("handles 3-character hex codes", () => {
    const result = lightenHexColor("#f00", 0.5);
    // R: 255 + (255-255)*0.5 = 255
    // G: 0 + (255-0)*0.5 = 128
    // B: 0 + (255-0)*0.5 = 128
    expect(result).toBe("#ff8080");
  });

  it("lightening white stays white", () => {
    expect(lightenHexColor("#ffffff", 0.5)).toBe("#ffffff");
  });
});

// ============================================================================
// autoGradientFromColor
// ============================================================================

describe("autoGradientFromColor", () => {
  it("creates a linear gradient with 2 stops", () => {
    const grad = autoGradientFromColor("#4472c4");
    expect(grad.type).toBe("linear");
    expect(grad.stops).toHaveLength(2);
    expect(grad.stops[0].offset).toBe(0);
    expect(grad.stops[1].offset).toBe(1);
  });

  it("uses the base color as first stop", () => {
    const grad = autoGradientFromColor("#ff0000");
    expect(grad.stops[0].color).toBe("#ff0000");
  });

  it("second stop is lighter than first", () => {
    const grad = autoGradientFromColor("#4472c4", 0.3);
    const r1 = parseInt(grad.stops[0].color.slice(1, 3), 16);
    const r2 = parseInt(grad.stops[1].color.slice(1, 3), 16);
    expect(r2).toBeGreaterThanOrEqual(r1);
  });

  it("uses default topToBottom direction", () => {
    const grad = autoGradientFromColor("#000000");
    expect(grad.direction).toBe("topToBottom");
  });

  it("accepts custom direction", () => {
    const grad = autoGradientFromColor("#000000", 0.3, "leftToRight");
    expect(grad.direction).toBe("leftToRight");
  });
});
