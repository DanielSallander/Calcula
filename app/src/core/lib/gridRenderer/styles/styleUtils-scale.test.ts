//! FILENAME: app/src/core/lib/gridRenderer/styles/styleUtils-scale.test.ts
// PURPOSE: Scale tests for style cache and color validation

import { describe, it, expect } from "vitest";
import { getStyleFromCache, isValidColor } from "./styleUtils";
import type { StyleData, StyleDataMap } from "../../../types";
import { DEFAULT_STYLE } from "../../../types";

// ============================================================================
// getStyleFromCache with 100+ styles
// ============================================================================

describe("getStyleFromCache with 100+ styles", () => {
  function buildLargeCache(count: number): StyleDataMap {
    const cache: StyleDataMap = new Map();
    cache.set(0, DEFAULT_STYLE);
    for (let i = 1; i <= count; i++) {
      cache.set(i, { ...DEFAULT_STYLE, fontSize: 10 + i, bold: i % 2 === 0 });
    }
    return cache;
  }

  it("retrieves each of 150 styles by index", () => {
    const cache = buildLargeCache(150);
    for (let i = 1; i <= 150; i++) {
      const style = getStyleFromCache(cache, i);
      expect(style.fontSize).toBe(10 + i);
      expect(style.bold).toBe(i % 2 === 0);
    }
  });

  it("falls back to index 0 for missing indices beyond range", () => {
    const cache = buildLargeCache(100);
    const result = getStyleFromCache(cache, 999);
    expect(result).toBe(cache.get(0));
  });

  it("handles 500 styles without issues", () => {
    const cache = buildLargeCache(500);
    expect(cache.size).toBe(501);
    expect(getStyleFromCache(cache, 500).fontSize).toBe(510);
    expect(getStyleFromCache(cache, 1).fontSize).toBe(11);
  });

  it("index 0 always returns default even with large cache", () => {
    const cache = buildLargeCache(200);
    expect(getStyleFromCache(cache, 0)).toBe(DEFAULT_STYLE);
  });
});

// ============================================================================
// isValidColor with all CSS named colors (140+)
// ============================================================================

describe("isValidColor with CSS named colors", () => {
  // The implementation only recognizes a subset of named colors.
  // Test those that ARE recognized.
  const recognizedColors = [
    "black", "white", "red", "green", "blue", "yellow", "cyan", "magenta",
    "gray", "grey", "orange", "pink", "purple", "brown", "transparent",
  ];

  it("validates all recognized named colors", () => {
    for (const color of recognizedColors) {
      expect(isValidColor(color)).toBe(true);
    }
  });

  it("validates recognized named colors case-insensitively", () => {
    for (const color of recognizedColors) {
      expect(isValidColor(color.toUpperCase())).toBe(true);
    }
  });

  // Extended CSS named colors that are NOT in the recognized list
  const unrecognizedCssColors = [
    "aliceblue", "antiquewhite", "aqua", "aquamarine", "azure",
    "beige", "bisque", "blanchedalmond", "blueviolet", "burlywood",
    "cadetblue", "chartreuse", "chocolate", "coral", "cornflowerblue",
    "cornsilk", "crimson", "darkblue", "darkcyan", "darkgoldenrod",
    "darkgray", "darkgreen", "darkkhaki", "darkmagenta", "darkolivegreen",
    "darkorange", "darkorchid", "darkred", "darksalmon", "darkseagreen",
    "darkslateblue", "darkslategray", "darkturquoise", "darkviolet",
    "deeppink", "deepskyblue", "dimgray", "dodgerblue", "firebrick",
    "floralwhite", "forestgreen", "fuchsia", "gainsboro", "ghostwhite",
    "gold", "goldenrod", "greenyellow", "honeydew", "hotpink",
    "indianred", "indigo", "ivory", "khaki", "lavender",
    "lavenderblush", "lawngreen", "lemonchiffon", "lightblue", "lightcoral",
    "lightcyan", "lightgoldenrodyellow", "lightgray", "lightgreen", "lightpink",
    "lightsalmon", "lightseagreen", "lightskyblue", "lightslategray",
    "lightsteelblue", "lightyellow", "lime", "limegreen", "linen",
    "maroon", "mediumaquamarine", "mediumblue", "mediumorchid", "mediumpurple",
    "mediumseagreen", "mediumslateblue", "mediumspringgreen", "mediumturquoise",
    "mediumvioletred", "midnightblue", "mintcream", "mistyrose", "moccasin",
    "navajowhite", "navy", "oldlace", "olive", "olivedrab",
    "orangered", "orchid", "palegoldenrod", "palegreen", "paleturquoise",
    "palevioletred", "papayawhip", "peachpuff", "peru", "plum",
    "powderblue", "rebeccapurple", "rosybrown", "royalblue", "saddlebrown",
    "salmon", "sandybrown", "seagreen", "seashell", "sienna",
    "silver", "skyblue", "slateblue", "slategray", "snow",
    "springgreen", "steelblue", "tan", "teal", "thistle",
    "tomato", "turquoise", "violet", "wheat", "whitesmoke",
    "yellowgreen",
  ];

  it("rejects extended CSS named colors not in the recognized list", () => {
    for (const color of unrecognizedCssColors) {
      expect(isValidColor(color)).toBe(false);
    }
  });
});

describe("isValidColor - hex format exhaustive", () => {
  it("validates 3-digit hex with all valid chars", () => {
    expect(isValidColor("#000")).toBe(true);
    expect(isValidColor("#fff")).toBe(true);
    expect(isValidColor("#abc")).toBe(true);
    expect(isValidColor("#ABC")).toBe(true);
    expect(isValidColor("#1a2")).toBe(true);
  });

  it("validates 4-digit hex (with alpha)", () => {
    expect(isValidColor("#0000")).toBe(true);
    expect(isValidColor("#ffff")).toBe(true);
  });

  it("validates 8-digit hex (with alpha)", () => {
    expect(isValidColor("#00000000")).toBe(true);
    expect(isValidColor("#ffffffff")).toBe(true);
    expect(isValidColor("#12345678")).toBe(true);
  });

  it("rejects hex with wrong digit count", () => {
    expect(isValidColor("#1")).toBe(false);
    expect(isValidColor("#12")).toBe(false);
    expect(isValidColor("#12345")).toBe(false);
    expect(isValidColor("#1234567")).toBe(false);
    expect(isValidColor("#123456789")).toBe(false);
  });

  it("rejects hex with invalid characters", () => {
    expect(isValidColor("#xyz")).toBe(false);
    expect(isValidColor("#gggggg")).toBe(false);
  });
});

describe("isValidColor - rgb/rgba edge cases", () => {
  it("validates rgb with no spaces", () => {
    expect(isValidColor("rgb(0,0,0)")).toBe(true);
  });

  it("validates rgb with spaces", () => {
    expect(isValidColor("rgb( 255 , 128 , 0 )")).toBe(true);
  });

  it("validates rgba with decimal alpha", () => {
    expect(isValidColor("rgba(255, 0, 0, 0.5)")).toBe(true);
    expect(isValidColor("rgba(0, 0, 0, 1)")).toBe(true);
    expect(isValidColor("rgba(0, 0, 0, 0)")).toBe(true);
  });

  it("rejects rgb with non-numeric values", () => {
    expect(isValidColor("rgb(a, b, c)")).toBe(false);
  });

  it("rejects malformed rgb", () => {
    expect(isValidColor("rgb(255, 0)")).toBe(false);
    expect(isValidColor("rgb()")).toBe(false);
  });
});

// ============================================================================
// Color validation performance: 10K checks under 100ms
// ============================================================================

describe("color validation performance", () => {
  it("validates 10K hex colors under 100ms", () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      const hex = `#${(i % 0xffffff).toString(16).padStart(6, "0")}`;
      isValidColor(hex);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("validates 10K named color checks under 100ms", () => {
    const colors = ["red", "blue", "green", "black", "white", "notacolor", "transparent", "purple", "orange", "cyan"];
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      isValidColor(colors[i % colors.length]);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });

  it("validates 10K rgb strings under 100ms", () => {
    const start = performance.now();
    for (let i = 0; i < 10000; i++) {
      isValidColor(`rgb(${i % 256}, ${(i * 3) % 256}, ${(i * 7) % 256})`);
    }
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});
