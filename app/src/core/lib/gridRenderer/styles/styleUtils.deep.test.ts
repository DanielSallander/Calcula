//! FILENAME: app/src/core/lib/gridRenderer/styles/styleUtils.deeptest.ts
// PURPOSE: Deep tests for style utilities - color validation edge cases

import { describe, it, expect } from "vitest";
import {
  isValidColor,
  isDefaultTextColor,
  isDefaultBackgroundColor,
  getStyleFromCache,
} from "./styleUtils";
import type { StyleData, StyleDataMap } from "../../../types";
import { DEFAULT_STYLE } from "../../../types";

// ============================================================================
// isValidColor - exhaustive edge cases
// ============================================================================

describe("isValidColor - edge cases", () => {
  describe("hex formats", () => {
    it("validates 4-digit hex (with alpha)", () => {
      expect(isValidColor("#f00f")).toBe(true);
      expect(isValidColor("#0000")).toBe(true);
    });

    it("rejects invalid hex lengths", () => {
      expect(isValidColor("#f")).toBe(false);
      expect(isValidColor("#ff")).toBe(false);
      expect(isValidColor("#fffff")).toBe(false);
      expect(isValidColor("#fffffff")).toBe(false);
      expect(isValidColor("#fffffffff")).toBe(false);
    });

    it("rejects hex with invalid characters", () => {
      expect(isValidColor("#xyz")).toBe(false);
      expect(isValidColor("#gggggg")).toBe(false);
      expect(isValidColor("#zzzzzz")).toBe(false);
    });

    it("validates 8-digit hex without #", () => {
      expect(isValidColor("ff000080")).toBe(true);
    });

    it("rejects 3-digit hex without # (ambiguous with named colors)", () => {
      // 3-digit without # is NOT matched by the regex
      expect(isValidColor("fff")).toBe(false);
    });
  });

  describe("rgb/rgba formats", () => {
    it("validates rgb with no spaces", () => {
      expect(isValidColor("rgb(0,0,0)")).toBe(true);
    });

    it("validates rgb with spaces", () => {
      expect(isValidColor("rgb(255, 128, 0)")).toBe(true);
    });

    it("validates rgba with decimal alpha", () => {
      expect(isValidColor("rgba(0, 0, 0, 0.5)")).toBe(true);
      expect(isValidColor("rgba(255,255,255,0)")).toBe(true);
      expect(isValidColor("rgba(255,255,255,1)")).toBe(true);
    });

    it("rejects rgb with non-numeric values", () => {
      expect(isValidColor("rgb(a,b,c)")).toBe(false);
    });

    it("rejects incomplete rgb", () => {
      expect(isValidColor("rgb(255)")).toBe(false);
      expect(isValidColor("rgb(255, 0)")).toBe(false);
    });
  });

  describe("named colors", () => {
    const validNames = [
      "black", "white", "red", "green", "blue", "yellow",
      "cyan", "magenta", "gray", "grey", "orange", "pink",
      "purple", "brown", "transparent",
    ];

    for (const name of validNames) {
      it(`validates "${name}"`, () => {
        expect(isValidColor(name)).toBe(true);
      });
    }

    it("validates case-insensitive named colors", () => {
      expect(isValidColor("Red")).toBe(true);
      expect(isValidColor("BLUE")).toBe(true);
      expect(isValidColor("Transparent")).toBe(true);
    });

    it("rejects unknown named colors", () => {
      expect(isValidColor("chartreuse")).toBe(false);
      expect(isValidColor("coral")).toBe(false);
      expect(isValidColor("not-a-color")).toBe(false);
    });
  });

  describe("whitespace handling", () => {
    it("trims whitespace before validation", () => {
      expect(isValidColor("  #ff0000  ")).toBe(true);
      expect(isValidColor("  red  ")).toBe(true);
    });
  });

  describe("type safety", () => {
    it("rejects non-string types", () => {
      expect(isValidColor(null)).toBe(false);
      expect(isValidColor(undefined)).toBe(false);
      expect(isValidColor("")).toBe(false);
    });
  });
});

// ============================================================================
// isDefaultTextColor - edge cases
// ============================================================================

describe("isDefaultTextColor - edge cases", () => {
  it("returns true for empty string", () => {
    expect(isDefaultTextColor("")).toBe(true);
  });

  it("handles whitespace around black values", () => {
    expect(isDefaultTextColor("  #000000  ")).toBe(true);
    expect(isDefaultTextColor("  black  ")).toBe(true);
  });

  it("handles case variations", () => {
    expect(isDefaultTextColor("BLACK")).toBe(true);
    expect(isDefaultTextColor("Black")).toBe(true);
    expect(isDefaultTextColor("#000000")).toBe(true);
  });

  it("rejects near-black colors", () => {
    expect(isDefaultTextColor("#000001")).toBe(false);
    expect(isDefaultTextColor("#010101")).toBe(false);
    expect(isDefaultTextColor("rgb(0, 0, 1)")).toBe(false);
    expect(isDefaultTextColor("#111")).toBe(false);
  });

  it("rejects dark grey as non-default", () => {
    expect(isDefaultTextColor("#333333")).toBe(false);
    expect(isDefaultTextColor("gray")).toBe(false);
  });
});

// ============================================================================
// isDefaultBackgroundColor - edge cases
// ============================================================================

describe("isDefaultBackgroundColor - edge cases", () => {
  it("returns true for empty string", () => {
    expect(isDefaultBackgroundColor("")).toBe(true);
  });

  it("handles whitespace around white values", () => {
    expect(isDefaultBackgroundColor("  #ffffff  ")).toBe(true);
    expect(isDefaultBackgroundColor("  white  ")).toBe(true);
  });

  it("handles case variations", () => {
    expect(isDefaultBackgroundColor("WHITE")).toBe(true);
    expect(isDefaultBackgroundColor("White")).toBe(true);
    expect(isDefaultBackgroundColor("TRANSPARENT")).toBe(true);
  });

  it("detects fully transparent rgba as default", () => {
    expect(isDefaultBackgroundColor("rgba(0, 0, 0, 0)")).toBe(true);
    expect(isDefaultBackgroundColor("rgba(0,0,0,0)")).toBe(true);
  });

  it("rejects near-white colors", () => {
    expect(isDefaultBackgroundColor("#fffffe")).toBe(false);
    expect(isDefaultBackgroundColor("#f0f0f0")).toBe(false);
    expect(isDefaultBackgroundColor("rgb(254, 255, 255)")).toBe(false);
  });

  it("rejects semi-transparent as non-default", () => {
    expect(isDefaultBackgroundColor("rgba(0, 0, 0, 0.5)")).toBe(false);
    expect(isDefaultBackgroundColor("rgba(255, 255, 255, 0.5)")).toBe(false);
  });
});

// ============================================================================
// getStyleFromCache - edge cases
// ============================================================================

describe("getStyleFromCache - edge cases", () => {
  it("handles very large style indices", () => {
    const cache: StyleDataMap = new Map();
    cache.set(0, DEFAULT_STYLE);
    const result = getStyleFromCache(cache, 999999);
    expect(result).toBe(DEFAULT_STYLE);
  });

  it("handles negative index (falls back to 0)", () => {
    const cache: StyleDataMap = new Map();
    cache.set(0, DEFAULT_STYLE);
    const result = getStyleFromCache(cache, -1);
    expect(result).toBe(DEFAULT_STYLE);
  });

  it("returns correct style when multiple styles exist", () => {
    const cache: StyleDataMap = new Map();
    const s0 = { ...DEFAULT_STYLE };
    const s1 = { ...DEFAULT_STYLE, bold: true };
    const s2 = { ...DEFAULT_STYLE, italic: true };
    const s3 = { ...DEFAULT_STYLE, textColor: "#ff0000" };
    cache.set(0, s0);
    cache.set(1, s1);
    cache.set(2, s2);
    cache.set(3, s3);

    expect(getStyleFromCache(cache, 0)).toBe(s0);
    expect(getStyleFromCache(cache, 1)).toBe(s1);
    expect(getStyleFromCache(cache, 2)).toBe(s2);
    expect(getStyleFromCache(cache, 3)).toBe(s3);
    expect(getStyleFromCache(cache, 4)).toBe(s0); // fallback to 0
  });
});
