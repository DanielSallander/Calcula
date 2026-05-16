//! FILENAME: app/extensions/Charts/rendering/__tests__/color-parameterized.test.ts
// PURPOSE: Parameterized tests for chart color utilities (lighten, darken, interpolation, palette cycling).
// CONTEXT: Comprehensive coverage of lightenHexColor, darkenColor, getSeriesColor, and color math.

import { describe, it, expect } from "vitest";
import { lightenHexColor } from "../gradientFill";
import { darkenColor } from "../trendlinePainter";
import { getSeriesColor, PALETTES, PALETTE_NAMES } from "../chartTheme";

// ============================================================================
// Helper: parse hex to RGB tuple
// ============================================================================

function hexToRgb(hex: string): [number, number, number] {
  const c = hex.replace("#", "");
  return [
    parseInt(c.substring(0, 2), 16),
    parseInt(c.substring(2, 4), 16),
    parseInt(c.substring(4, 6), 16),
  ];
}

/** Interpolate between two hex colors. Used to test color math properties. */
function interpolateColor(start: string, end: string, ratio: number): string {
  const [r1, g1, b1] = hexToRgb(start);
  const [r2, g2, b2] = hexToRgb(end);
  const r = Math.round(r1 + (r2 - r1) * ratio);
  const g = Math.round(g1 + (g2 - g1) * ratio);
  const b = Math.round(b1 + (b2 - b1) * ratio);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// ============================================================================
// lightenHexColor - 50 color x amount combos
// ============================================================================

describe("lightenHexColor", () => {
  const lightenCases: [string, number, string][] = [
    // [input, amount, expected]
    // Black lightened
    ["#000000", 0, "#000000"],
    ["#000000", 0.1, "#1a1a1a"],
    ["#000000", 0.2, "#333333"],
    ["#000000", 0.25, "#404040"],
    ["#000000", 0.3, "#4d4d4d"],
    ["#000000", 0.4, "#666666"],
    ["#000000", 0.5, "#808080"],
    ["#000000", 0.6, "#999999"],
    ["#000000", 0.7, "#b3b3b3"],
    ["#000000", 0.75, "#bfbfbf"],
    ["#000000", 0.8, "#cccccc"],
    ["#000000", 0.9, "#e6e6e6"],
    ["#000000", 1, "#ffffff"],
    // White stays white
    ["#ffffff", 0, "#ffffff"],
    ["#ffffff", 0.5, "#ffffff"],
    ["#ffffff", 1, "#ffffff"],
    // Red lightened
    ["#ff0000", 0, "#ff0000"],
    ["#ff0000", 0.25, "#ff4040"],
    ["#ff0000", 0.5, "#ff8080"],
    ["#ff0000", 0.75, "#ffbfbf"],
    ["#ff0000", 1, "#ffffff"],
    // Green lightened
    ["#00ff00", 0, "#00ff00"],
    ["#00ff00", 0.5, "#80ff80"],
    ["#00ff00", 1, "#ffffff"],
    // Blue lightened
    ["#0000ff", 0, "#0000ff"],
    ["#0000ff", 0.5, "#8080ff"],
    ["#0000ff", 1, "#ffffff"],
    // Mid-tone colors
    ["#4472c4", 0.3, "#7c9cd6"],
    ["#4472c4", 0.5, "#a2b9e2"],
    ["#4472c4", 0.7, "#c7d5ed"],
    ["#808080", 0, "#808080"],
    ["#808080", 0.5, "#c0c0c0"],
    ["#808080", 1, "#ffffff"],
    // Palette colors lightened
    ["#4E79A7", 0.2, "#7194b9"],
    ["#F28E2B", 0.2, "#f5a555"],
    ["#E15759", 0.2, "#e7797a"],
    ["#76B7B2", 0.2, "#91c5c1"],
    ["#59A14F", 0.2, "#7ab472"],
    // 3-char hex
    ["#f00", 0.5, "#ff8080"],
    ["#0f0", 0.5, "#80ff80"],
    ["#00f", 0.5, "#8080ff"],
    ["#000", 0.5, "#808080"],
    ["#fff", 0, "#ffffff"],
    ["#fff", 1, "#ffffff"],
    // Dark colors
    ["#1a1a1a", 0.5, "#8d8d8d"],
    ["#333333", 0.5, "#999999"],
    ["#0a0a0a", 0.5, "#858585"],
    // Near-white
    ["#fefefe", 0.5, "#ffffff"],
    ["#f0f0f0", 0.5, "#f8f8f8"],
    ["#e0e0e0", 0.5, "#f0f0f0"],
  ];

  it.each(lightenCases)(
    "lightenHexColor('%s', %f) => '%s'",
    (hex, amount, expected) => {
      expect(lightenHexColor(hex, amount)).toBe(expected);
    },
  );
});

// ============================================================================
// darkenColor - 30 combos
// ============================================================================

describe("darkenColor", () => {
  const darkenCases: [string, number, string][] = [
    // White darkened
    ["#ffffff", 0, "#ffffff"],
    ["#ffffff", 0.1, "#e6e6e6"],
    ["#ffffff", 0.2, "#cccccc"],
    ["#ffffff", 0.3, "#b3b3b3"],
    ["#ffffff", 0.4, "#999999"],
    ["#ffffff", 0.5, "#808080"],
    ["#ffffff", 0.6, "#666666"],
    ["#ffffff", 0.7, "#4d4d4d"],
    ["#ffffff", 0.8, "#333333"],
    ["#ffffff", 0.9, "#191919"],
    ["#ffffff", 1, "#000000"],
    // Black stays black
    ["#000000", 0, "#000000"],
    ["#000000", 0.5, "#000000"],
    ["#000000", 1, "#000000"],
    // Red darkened
    ["#ff0000", 0, "#ff0000"],
    ["#ff0000", 0.25, "#bf0000"],
    ["#ff0000", 0.5, "#800000"],
    ["#ff0000", 0.75, "#400000"],
    ["#ff0000", 1, "#000000"],
    // Green darkened
    ["#00ff00", 0.5, "#008000"],
    ["#00ff00", 1, "#000000"],
    // Blue darkened
    ["#0000ff", 0.5, "#000080"],
    ["#0000ff", 1, "#000000"],
    // Mid-tone
    ["#808080", 0.5, "#404040"],
    ["#4472c4", 0.3, "#305089"],
    ["#4472c4", 0.5, "#223962"],
    // Palette colors
    ["#4E79A7", 0.2, "#3e6186"],
    ["#F28E2B", 0.2, "#c27222"],
    ["#E15759", 0.2, "#b44647"],
    ["#59A14F", 0.2, "#47813f"],
  ];

  it.each(darkenCases)(
    "darkenColor('%s', %f) => '%s'",
    (hex, amount, expected) => {
      expect(darkenColor(hex, amount)).toBe(expected);
    },
  );
});

// ============================================================================
// Color interpolation - 30 start/end/ratio combos
// ============================================================================

describe("color interpolation", () => {
  describe("basic interpolation math", () => {
    const interpolationCases: [string, string, number, string][] = [
      // [start, end, ratio, expected]
      // Extremes
      ["#000000", "#ffffff", 0, "#000000"],
      ["#000000", "#ffffff", 1, "#ffffff"],
      ["#000000", "#ffffff", 0.5, "#808080"],
      ["#ff0000", "#00ff00", 0, "#ff0000"],
      ["#ff0000", "#00ff00", 1, "#00ff00"],
      ["#ff0000", "#00ff00", 0.5, "#808000"],
      ["#ff0000", "#0000ff", 0.5, "#800080"],
      ["#00ff00", "#0000ff", 0.5, "#008080"],
      // Same color
      ["#ff0000", "#ff0000", 0, "#ff0000"],
      ["#ff0000", "#ff0000", 0.5, "#ff0000"],
      ["#ff0000", "#ff0000", 1, "#ff0000"],
      // Grayscale ramp
      ["#000000", "#ffffff", 0.1, "#1a1a1a"],
      ["#000000", "#ffffff", 0.2, "#333333"],
      ["#000000", "#ffffff", 0.25, "#404040"],
      ["#000000", "#ffffff", 0.3, "#4d4d4d"],
      ["#000000", "#ffffff", 0.4, "#666666"],
      ["#000000", "#ffffff", 0.6, "#999999"],
      ["#000000", "#ffffff", 0.7, "#b3b3b3"],
      ["#000000", "#ffffff", 0.75, "#bfbfbf"],
      ["#000000", "#ffffff", 0.8, "#cccccc"],
      ["#000000", "#ffffff", 0.9, "#e6e6e6"],
      // Color to color
      ["#4E79A7", "#F28E2B", 0, "#4e79a7"],
      ["#4E79A7", "#F28E2B", 1, "#f28e2b"],
      ["#4E79A7", "#F28E2B", 0.5, "#a08469"],
      // Reverse direction
      ["#ffffff", "#000000", 0.5, "#808080"],
      ["#00ff00", "#ff0000", 0.5, "#808000"],
      // Small ratios
      ["#000000", "#ff0000", 0.01, "#030000"],
      ["#000000", "#ff0000", 0.99, "#fc0000"],
      // Complementary colors
      ["#ff0000", "#00ffff", 0.5, "#808080"],
      ["#ffff00", "#0000ff", 0.5, "#808080"],
    ];

    it.each(interpolationCases)(
      "interpolate('%s', '%s', %f) => '%s'",
      (start, end, ratio, expected) => {
        expect(interpolateColor(start, end, ratio)).toBe(expected);
      },
    );
  });

  describe("interpolation properties", () => {
    it.each([
      ["#000000", "#ffffff"],
      ["#ff0000", "#00ff00"],
      ["#4E79A7", "#F28E2B"],
      ["#E15759", "#76B7B2"],
      ["#59A14F", "#EDC948"],
    ] as [string, string][])(
      "interpolate(%s, %s) at 0 and 1 returns endpoints",
      (start, end) => {
        expect(interpolateColor(start, end, 0)).toBe(start.toLowerCase());
        expect(interpolateColor(end, start, 0)).toBe(end.toLowerCase());
      },
    );
  });
});

// ============================================================================
// Palette color cycling: 4 palettes x 30 indices = 120 tests
// ============================================================================

describe("getSeriesColor palette cycling", () => {
  const indices = Array.from({ length: 30 }, (_, i) => i);

  for (const paletteName of PALETTE_NAMES) {
    describe(`palette: ${paletteName}`, () => {
      const palette = PALETTES[paletteName];

      it.each(indices)(`index %i cycles correctly`, (idx) => {
        const result = getSeriesColor(paletteName, idx, null);
        const expected = palette[idx % palette.length];
        expect(result).toBe(expected);
      });
    });
  }

  describe("override takes precedence", () => {
    it.each([
      ["default", 0, "#custom1"],
      ["default", 5, "#override"],
      ["vivid", 0, "#ff0000"],
      ["pastel", 3, "#123456"],
      ["ocean", 7, "#abcdef"],
    ] as [string, number, string][])(
      "getSeriesColor('%s', %i, '%s') returns override",
      (palette, idx, override) => {
        expect(getSeriesColor(palette, idx, override)).toBe(override);
      },
    );
  });

  describe("unknown palette falls back to default", () => {
    it.each(indices.slice(0, 10))("index %i with unknown palette", (idx) => {
      const result = getSeriesColor("nonexistent", idx, null);
      const expected = PALETTES.default[idx % PALETTES.default.length];
      expect(result).toBe(expected);
    });
  });
});

// ============================================================================
// lightenHexColor + darkenColor symmetry properties
// ============================================================================

describe("lighten/darken property tests", () => {
  const colors = [
    "#000000", "#ffffff", "#ff0000", "#00ff00", "#0000ff",
    "#808080", "#4472c4", "#4E79A7", "#F28E2B", "#E15759",
  ];

  describe("lighten amount=0 is identity", () => {
    it.each(colors.map((c) => [c] as [string]))("lighten('%s', 0) === input (lowercase)", (c) => {
      expect(lightenHexColor(c, 0)).toBe(c.toLowerCase());
    });
  });

  describe("darken amount=0 is identity", () => {
    it.each(colors.map((c) => [c] as [string]))("darken('%s', 0) === input (lowercase)", (c) => {
      expect(darkenColor(c, 0)).toBe(c.toLowerCase());
    });
  });

  describe("lighten amount=1 always gives white", () => {
    it.each(colors.map((c) => [c] as [string]))("lighten('%s', 1) === #ffffff", (c) => {
      expect(lightenHexColor(c, 1)).toBe("#ffffff");
    });
  });

  describe("darken amount=1 always gives black (or NaN for short hex)", () => {
    const sixDigitColors = colors.filter((c) => c.length === 7);
    it.each(sixDigitColors.map((c) => [c] as [string]))("darken('%s', 1) === #000000", (c) => {
      expect(darkenColor(c, 1)).toBe("#000000");
    });
  });

  describe("lighten produces brighter or equal RGB", () => {
    it.each([
      ["#4472c4", 0.1], ["#4472c4", 0.3], ["#4472c4", 0.5], ["#4472c4", 0.7], ["#4472c4", 0.9],
      ["#000000", 0.5], ["#808080", 0.5], ["#ff0000", 0.5], ["#00ff00", 0.5], ["#0000ff", 0.5],
    ] as [string, number][])("lighten('%s', %f) is brighter", (hex, amount) => {
      const [origR, origG, origB] = hexToRgb(hex);
      const result = lightenHexColor(hex, amount);
      const [newR, newG, newB] = hexToRgb(result);
      expect(newR).toBeGreaterThanOrEqual(origR);
      expect(newG).toBeGreaterThanOrEqual(origG);
      expect(newB).toBeGreaterThanOrEqual(origB);
    });
  });

  describe("darken produces darker or equal RGB", () => {
    it.each([
      ["#4472c4", 0.1], ["#4472c4", 0.3], ["#4472c4", 0.5], ["#4472c4", 0.7], ["#4472c4", 0.9],
      ["#ffffff", 0.5], ["#808080", 0.5], ["#ff0000", 0.5], ["#00ff00", 0.5], ["#0000ff", 0.5],
    ] as [string, number][])("darken('%s', %f) is darker", (hex, amount) => {
      const [origR, origG, origB] = hexToRgb(hex);
      const result = darkenColor(hex, amount);
      const [newR, newG, newB] = hexToRgb(result);
      expect(newR).toBeLessThanOrEqual(origR);
      expect(newG).toBeLessThanOrEqual(origG);
      expect(newB).toBeLessThanOrEqual(origB);
    });
  });
});
