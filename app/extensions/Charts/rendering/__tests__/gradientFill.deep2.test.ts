//! FILENAME: app/extensions/Charts/rendering/__tests__/gradientFill.deep2.test.ts
// PURPOSE: Tests for gradient fill utility functions (pure logic, no canvas).

import { describe, it, expect } from "vitest";
import { lightenHexColor, autoGradientFromColor } from "../gradientFill";

// ============================================================================
// lightenHexColor
// ============================================================================

describe("lightenHexColor", () => {
  it("returns same color when amount is 0", () => {
    expect(lightenHexColor("#000000", 0)).toBe("#000000");
  });

  it("returns white when amount is 1", () => {
    expect(lightenHexColor("#000000", 1)).toBe("#ffffff");
  });

  it("lightens a mid-gray", () => {
    const result = lightenHexColor("#808080", 0.5);
    // 128 + (255-128)*0.5 = 128 + 63.5 = 191.5 => 192 = c0
    expect(result).toBe("#c0c0c0");
  });

  it("handles 3-digit hex shorthand", () => {
    const result = lightenHexColor("#f00", 0);
    expect(result).toBe("#ff0000");
  });

  it("lightens red", () => {
    const result = lightenHexColor("#ff0000", 0.5);
    // R: 255 + 0 = 255, G: 0 + 128 = 128, B: 0 + 128 = 128
    expect(result).toBe("#ff8080");
  });

  it("handles already white color", () => {
    expect(lightenHexColor("#ffffff", 0.5)).toBe("#ffffff");
  });

  it("handles amount 0.3 on dark blue", () => {
    const result = lightenHexColor("#003366", 0.3);
    // R: 0 + 255*0.3 = 77, G: 51 + 204*0.3 = 112, B: 102 + 153*0.3 = 148
    const r = Math.round(0 + 255 * 0.3);
    const g = Math.round(51 + (255 - 51) * 0.3);
    const b = Math.round(102 + (255 - 102) * 0.3);
    expect(result).toBe(`#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`);
  });
});

// ============================================================================
// autoGradientFromColor
// ============================================================================

describe("autoGradientFromColor", () => {
  it("creates a two-stop linear gradient", () => {
    const fill = autoGradientFromColor("#ff0000");
    expect(fill.type).toBe("linear");
    expect(fill.stops).toHaveLength(2);
    expect(fill.stops[0].offset).toBe(0);
    expect(fill.stops[1].offset).toBe(1);
  });

  it("first stop is the base color", () => {
    const fill = autoGradientFromColor("#4E79A7");
    expect(fill.stops[0].color).toBe("#4E79A7");
  });

  it("second stop is lighter than base", () => {
    const fill = autoGradientFromColor("#000000", 0.5);
    expect(fill.stops[1].color).toBe("#808080");
  });

  it("defaults to topToBottom direction", () => {
    const fill = autoGradientFromColor("#ff0000");
    expect(fill.direction).toBe("topToBottom");
  });

  it("respects custom direction", () => {
    const fill = autoGradientFromColor("#ff0000", 0.3, "leftToRight");
    expect(fill.direction).toBe("leftToRight");
  });

  it("respects custom lighten amount", () => {
    const fill0 = autoGradientFromColor("#000000", 0);
    const fill1 = autoGradientFromColor("#000000", 1);
    expect(fill0.stops[1].color).toBe("#000000");
    expect(fill1.stops[1].color).toBe("#ffffff");
  });
});
