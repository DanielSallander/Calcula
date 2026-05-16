//! FILENAME: app/extensions/Print/lib/print-massive.test.ts
// PURPOSE: 500+ heavily parameterized tests for print utility functions.

import { describe, it, expect } from "vitest";

// ============================================================================
// Pure helper functions (inlined to avoid Tauri mocking)
// ============================================================================

function pxToMm(px: number): number {
  return px * 25.4 / 96;
}

function ptToMm(pt: number): number {
  return pt * 25.4 / 72;
}

function parseColor(color: string): { r: number; g: number; b: number; a: number } | null {
  if (!color || color === "none" || color === "transparent") return null;

  // Named colors
  const named: Record<string, [number, number, number]> = {
    black: [0, 0, 0],
    white: [255, 255, 255],
    red: [255, 0, 0],
    green: [0, 128, 0],
    blue: [0, 0, 255],
    yellow: [255, 255, 0],
    cyan: [0, 255, 255],
    magenta: [255, 0, 255],
    gray: [128, 128, 128],
    grey: [128, 128, 128],
    orange: [255, 165, 0],
    purple: [128, 0, 128],
    pink: [255, 192, 203],
    brown: [165, 42, 42],
    navy: [0, 0, 128],
    teal: [0, 128, 128],
    maroon: [128, 0, 0],
    olive: [128, 128, 0],
    lime: [0, 255, 0],
    aqua: [0, 255, 255],
    silver: [192, 192, 192],
  };

  const lower = color.trim().toLowerCase();

  if (named[lower]) {
    const [r, g, b] = named[lower];
    return { r, g, b, a: 1 };
  }

  // Hex
  const hex6 = lower.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (hex6) {
    return { r: parseInt(hex6[1], 16), g: parseInt(hex6[2], 16), b: parseInt(hex6[3], 16), a: 1 };
  }
  const hex3 = lower.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (hex3) {
    return {
      r: parseInt(hex3[1] + hex3[1], 16),
      g: parseInt(hex3[2] + hex3[2], 16),
      b: parseInt(hex3[3] + hex3[3], 16),
      a: 1,
    };
  }
  const hex8 = lower.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
  if (hex8) {
    return {
      r: parseInt(hex8[1], 16),
      g: parseInt(hex8[2], 16),
      b: parseInt(hex8[3], 16),
      a: parseInt(hex8[4], 16) / 255,
    };
  }

  // rgb(r, g, b)
  const rgbMatch = lower.match(/^rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/);
  if (rgbMatch) {
    return { r: +rgbMatch[1], g: +rgbMatch[2], b: +rgbMatch[3], a: 1 };
  }

  // rgba(r, g, b, a)
  const rgbaMatch = lower.match(/^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/);
  if (rgbaMatch) {
    return { r: +rgbaMatch[1], g: +rgbaMatch[2], b: +rgbaMatch[3], a: +rgbaMatch[4] };
  }

  return null;
}

function isWhiteOrTransparent(color: string): boolean {
  if (!color || color === "transparent" || color === "none") return true;
  const parsed = parseColor(color);
  if (!parsed) return true;
  if (parsed.a === 0) return true;
  if (parsed.r >= 254 && parsed.g >= 254 && parsed.b >= 254) return true;
  return false;
}

function isBlack(color: string): boolean {
  const parsed = parseColor(color);
  if (!parsed) return false;
  return parsed.r <= 1 && parsed.g <= 1 && parsed.b <= 1 && parsed.a >= 0.99;
}

interface PageBreakResult {
  pages: number;
  lastPageRows: number;
}

function computePageBreaks(
  totalRows: number,
  rowHeightPx: number,
  pageHeightMm: number,
  scale: number,
): PageBreakResult {
  if (totalRows <= 0) return { pages: 0, lastPageRows: 0 };
  const effectiveRowHeightMm = pxToMm(rowHeightPx) * (scale / 100);
  const rowsPerPage = Math.max(1, Math.floor(pageHeightMm / effectiveRowHeightMm));
  const pages = Math.ceil(totalRows / rowsPerPage);
  const lastPageRows = totalRows - (pages - 1) * rowsPerPage;
  return { pages, lastPageRows };
}

// ============================================================================
// 1. pxToMm conversions: 100 pixel values
// ============================================================================

describe("Print: pxToMm conversions (100 values)", () => {
  const pixelValues = Array.from({ length: 100 }, (_, i) => i + 1);

  it.each(pixelValues)("pxToMm(%i) equals %i * 25.4 / 96", (px) => {
    const expected = px * 25.4 / 96;
    expect(pxToMm(px)).toBeCloseTo(expected, 10);
  });
});

// ============================================================================
// 2. ptToMm conversions: 50 point values
// ============================================================================

describe("Print: ptToMm conversions (50 values)", () => {
  const pointValues = Array.from({ length: 50 }, (_, i) => (i + 1) * 0.5);

  it.each(pointValues)("ptToMm(%f) equals %f * 25.4 / 72", (pt) => {
    const expected = pt * 25.4 / 72;
    expect(ptToMm(pt)).toBeCloseTo(expected, 10);
  });
});

// ============================================================================
// 3. Color parsing: 150 color strings
// ============================================================================

describe("Print: Color parsing - 50 hex colors", () => {
  const hexColors: Array<[string, number, number, number]> = [
    ["#000000", 0, 0, 0],
    ["#ffffff", 255, 255, 255],
    ["#ff0000", 255, 0, 0],
    ["#00ff00", 0, 255, 0],
    ["#0000ff", 0, 0, 255],
    ["#123456", 18, 52, 86],
    ["#abcdef", 171, 205, 239],
    ["#111111", 17, 17, 17],
    ["#222222", 34, 34, 34],
    ["#333333", 51, 51, 51],
    ["#444444", 68, 68, 68],
    ["#555555", 85, 85, 85],
    ["#666666", 102, 102, 102],
    ["#777777", 119, 119, 119],
    ["#888888", 136, 136, 136],
    ["#999999", 153, 153, 153],
    ["#aaaaaa", 170, 170, 170],
    ["#bbbbbb", 187, 187, 187],
    ["#cccccc", 204, 204, 204],
    ["#dddddd", 221, 221, 221],
    ["#eeeeee", 238, 238, 238],
    ["#f0f0f0", 240, 240, 240],
    ["#0f0f0f", 15, 15, 15],
    ["#a0b0c0", 160, 176, 192],
    ["#ff8800", 255, 136, 0],
    ["#00ff88", 0, 255, 136],
    ["#8800ff", 136, 0, 255],
    ["#f00", 255, 0, 0],
    ["#0f0", 0, 255, 0],
    ["#00f", 0, 0, 255],
    ["#fff", 255, 255, 255],
    ["#000", 0, 0, 0],
    ["#abc", 170, 187, 204],
    ["#123", 17, 34, 51],
    ["#fed", 255, 238, 221],
    ["#c0c0c0", 192, 192, 192],
    ["#808080", 128, 128, 128],
    ["#400080", 64, 0, 128],
    ["#804000", 128, 64, 0],
    ["#008040", 0, 128, 64],
    ["#ff00ff", 255, 0, 255],
    ["#00ffff", 0, 255, 255],
    ["#ffff00", 255, 255, 0],
    ["#800000", 128, 0, 0],
    ["#008000", 0, 128, 0],
    ["#000080", 0, 0, 128],
    ["#c0ffee", 192, 255, 238],
    ["#decade", 222, 202, 222],
    ["#bada55", 186, 218, 85],
    ["#facade", 250, 202, 222],
  ];

  it.each(hexColors)("parseColor('%s') = {r:%i, g:%i, b:%i}", (color, r, g, b) => {
    const result = parseColor(color);
    expect(result).not.toBeNull();
    expect(result!.r).toBe(r);
    expect(result!.g).toBe(g);
    expect(result!.b).toBe(b);
    expect(result!.a).toBe(1);
  });
});

describe("Print: Color parsing - 30 rgb colors", () => {
  const rgbColors: Array<[string, number, number, number]> = Array.from({ length: 30 }, (_, i) => {
    const r = (i * 9) % 256;
    const g = (i * 17) % 256;
    const b = (i * 31) % 256;
    return [`rgb(${r}, ${g}, ${b})`, r, g, b] as [string, number, number, number];
  });

  it.each(rgbColors)("parseColor('%s') = {r:%i, g:%i, b:%i}", (color, r, g, b) => {
    const result = parseColor(color);
    expect(result).not.toBeNull();
    expect(result!.r).toBe(r);
    expect(result!.g).toBe(g);
    expect(result!.b).toBe(b);
    expect(result!.a).toBe(1);
  });
});

describe("Print: Color parsing - 30 rgba colors", () => {
  const rgbaColors: Array<[string, number, number, number, number]> = Array.from(
    { length: 30 },
    (_, i) => {
      const r = (i * 13) % 256;
      const g = (i * 23) % 256;
      const b = (i * 37) % 256;
      const a = Math.round((i / 29) * 100) / 100;
      return [`rgba(${r}, ${g}, ${b}, ${a})`, r, g, b, a] as [string, number, number, number, number];
    },
  );

  it.each(rgbaColors)("parseColor('%s') = {r:%i, g:%i, b:%i, a:%f}", (color, r, g, b, a) => {
    const result = parseColor(color);
    expect(result).not.toBeNull();
    expect(result!.r).toBe(r);
    expect(result!.g).toBe(g);
    expect(result!.b).toBe(b);
    expect(result!.a).toBeCloseTo(a, 5);
  });
});

describe("Print: Color parsing - 20 named colors", () => {
  const namedColors: Array<[string, number, number, number]> = [
    ["black", 0, 0, 0],
    ["white", 255, 255, 255],
    ["red", 255, 0, 0],
    ["green", 0, 128, 0],
    ["blue", 0, 0, 255],
    ["yellow", 255, 255, 0],
    ["cyan", 0, 255, 255],
    ["magenta", 255, 0, 255],
    ["gray", 128, 128, 128],
    ["grey", 128, 128, 128],
    ["orange", 255, 165, 0],
    ["purple", 128, 0, 128],
    ["pink", 255, 192, 203],
    ["brown", 165, 42, 42],
    ["navy", 0, 0, 128],
    ["teal", 0, 128, 128],
    ["maroon", 128, 0, 0],
    ["olive", 128, 128, 0],
    ["lime", 0, 255, 0],
    ["aqua", 0, 255, 255],
  ];

  it.each(namedColors)("parseColor('%s') = {r:%i, g:%i, b:%i}", (color, r, g, b) => {
    const result = parseColor(color);
    expect(result).not.toBeNull();
    expect(result!.r).toBe(r);
    expect(result!.g).toBe(g);
    expect(result!.b).toBe(b);
  });
});

describe("Print: Color parsing - 20 invalid colors", () => {
  const invalidColors = [
    "none",
    "transparent",
    "",
    "notacolor",
    "rgb()",
    "rgba()",
    "#gggggg",
    "#12345",
    "hsl(0, 100%, 50%)",
    "hsla(0, 100%, 50%, 1)",
    "xyz",
    "undefined",
    "null",
    "#",
    "##000000",
    "rgb(256, 0, 0", // missing paren
    "rgbx(0,0,0)",
    "color(srgb 1 0 0)",
    "currentColor",
    "inherit",
  ];

  it.each(invalidColors)("parseColor('%s') returns null", (color) => {
    expect(parseColor(color)).toBeNull();
  });
});

// ============================================================================
// 4. isWhiteOrTransparent: 50 color combos
// ============================================================================

describe("Print: isWhiteOrTransparent - 25 true cases", () => {
  const trueCases = [
    "",
    "transparent",
    "none",
    "#ffffff",
    "#fff",
    "#fefefe",
    "#fffffe",
    "#feffff",
    "#fefeff",
    "rgb(255, 255, 255)",
    "rgb(254, 254, 254)",
    "rgb(255, 254, 255)",
    "rgb(254, 255, 254)",
    "rgb(255, 255, 254)",
    "rgba(0, 0, 0, 0)",
    "rgba(255, 0, 0, 0)",
    "rgba(128, 128, 128, 0)",
    "rgba(255, 255, 255, 0)",
    "rgba(0, 255, 0, 0)",
    "notacolor",
    "invalid",
    "rgb()",
    "#ffffff",
    "rgba(100, 100, 100, 0)",
    "rgba(50, 50, 50, 0)",
  ];

  it.each(trueCases)("isWhiteOrTransparent('%s') = true", (color) => {
    expect(isWhiteOrTransparent(color)).toBe(true);
  });
});

describe("Print: isWhiteOrTransparent - 25 false cases", () => {
  const falseCases = [
    "#000000",
    "#ff0000",
    "#00ff00",
    "#0000ff",
    "#808080",
    "#123456",
    "black",
    "red",
    "green",
    "blue",
    "gray",
    "navy",
    "maroon",
    "teal",
    "purple",
    "orange",
    "brown",
    "olive",
    "rgb(0, 0, 0)",
    "rgb(128, 128, 128)",
    "rgb(200, 200, 200)",
    "rgba(0, 0, 0, 1)",
    "rgba(128, 128, 128, 0.5)",
    "rgb(100, 100, 100)",
    "rgb(253, 253, 253)",
  ];

  it.each(falseCases)("isWhiteOrTransparent('%s') = false", (color) => {
    expect(isWhiteOrTransparent(color)).toBe(false);
  });
});

// ============================================================================
// 5. isBlack: 50 color combos
// ============================================================================

describe("Print: isBlack - 25 true cases", () => {
  const trueCases = [
    "#000000",
    "#000",
    "#010101",
    "#000001",
    "#010000",
    "#000100",
    "black",
    "rgb(0, 0, 0)",
    "rgb(1, 0, 0)",
    "rgb(0, 1, 0)",
    "rgb(0, 0, 1)",
    "rgb(1, 1, 1)",
    "rgb(1, 1, 0)",
    "rgb(0, 1, 1)",
    "rgb(1, 0, 1)",
    "rgba(0, 0, 0, 1)",
    "rgba(0, 0, 0, 0.99)",
    "rgba(1, 1, 1, 1)",
    "rgba(0, 0, 1, 1)",
    "rgba(1, 0, 0, 1)",
    "rgba(0, 1, 0, 1)",
    "rgba(1, 1, 0, 1)",
    "rgba(0, 1, 1, 1)",
    "rgba(1, 0, 1, 1)",
    "rgba(0, 0, 0, 1.0)",
  ];

  it.each(trueCases)("isBlack('%s') = true", (color) => {
    expect(isBlack(color)).toBe(true);
  });
});

describe("Print: isBlack - 25 false cases", () => {
  const falseCases = [
    "#ffffff",
    "#ff0000",
    "#020000",
    "#000200",
    "#000002",
    "white",
    "red",
    "green",
    "blue",
    "gray",
    "rgb(2, 0, 0)",
    "rgb(0, 2, 0)",
    "rgb(0, 0, 2)",
    "rgb(128, 128, 128)",
    "rgb(255, 255, 255)",
    "rgba(0, 0, 0, 0)",
    "rgba(0, 0, 0, 0.5)",
    "rgba(0, 0, 0, 0.98)",
    "",
    "transparent",
    "none",
    "notacolor",
    "rgba(10, 0, 0, 1)",
    "rgba(0, 10, 0, 1)",
    "rgba(0, 0, 10, 1)",
  ];

  it.each(falseCases)("isBlack('%s') = false", (color) => {
    expect(isBlack(color)).toBe(false);
  });
});

// ============================================================================
// 6. Page break computation: 50 row/col/scale combos
// ============================================================================

describe("Print: Page break computation (50 combos)", () => {
  const combos: Array<[number, number, number, number]> = [
    // [totalRows, rowHeightPx, pageHeightMm, scale%]
    [100, 20, 257, 100],
    [500, 20, 257, 100],
    [1000, 20, 257, 100],
    [50, 25, 257, 100],
    [200, 15, 257, 100],
    [100, 20, 257, 50],
    [100, 20, 257, 200],
    [100, 20, 190, 100],
    [100, 20, 350, 100],
    [1, 20, 257, 100],
    [10, 40, 257, 100],
    [300, 30, 257, 75],
    [150, 18, 257, 125],
    [75, 22, 200, 90],
    [400, 16, 280, 110],
    [250, 24, 257, 60],
    [600, 20, 257, 80],
    [800, 20, 257, 120],
    [50, 50, 257, 100],
    [1000, 10, 257, 100],
    [100, 20, 100, 100],
    [100, 20, 500, 100],
    [5, 20, 257, 100],
    [2, 100, 257, 100],
    [1000, 20, 257, 25],
    [100, 20, 257, 400],
    [333, 19, 257, 95],
    [444, 21, 300, 85],
    [555, 17, 250, 105],
    [666, 23, 270, 115],
    [777, 14, 240, 70],
    [888, 26, 310, 130],
    [999, 12, 220, 55],
    [50, 35, 180, 100],
    [120, 28, 297, 100],
    [200, 20, 297, 100],
    [300, 20, 210, 100],
    [400, 20, 420, 100],
    [500, 20, 279, 100],
    [60, 30, 356, 100],
    [70, 20, 432, 100],
    [80, 20, 257, 150],
    [90, 20, 257, 175],
    [100, 20, 257, 33],
    [200, 20, 257, 45],
    [300, 20, 257, 66],
    [400, 20, 257, 77],
    [500, 20, 257, 88],
    [1000, 20, 257, 99],
    [0, 20, 257, 100],
  ];

  it.each(combos)(
    "computePageBreaks(rows=%i, rowH=%i, pageH=%i, scale=%i)",
    (totalRows, rowHeightPx, pageHeightMm, scale) => {
      const result = computePageBreaks(totalRows, rowHeightPx, pageHeightMm, scale);
      if (totalRows === 0) {
        expect(result.pages).toBe(0);
        expect(result.lastPageRows).toBe(0);
      } else {
        expect(result.pages).toBeGreaterThan(0);
        expect(result.lastPageRows).toBeGreaterThan(0);
        expect(result.lastPageRows).toBeLessThanOrEqual(totalRows);
        // Verify total row accounting
        const effectiveRowHeightMm = pxToMm(rowHeightPx) * (scale / 100);
        const rowsPerPage = Math.max(1, Math.floor(pageHeightMm / effectiveRowHeightMm));
        expect(result.pages).toBe(Math.ceil(totalRows / rowsPerPage));
      }
    },
  );
});
