//! FILENAME: app/src/core/lib/gridRenderer/styles/styleUtils.test.ts
// PURPOSE: Tests for style cache management and color validation utilities

import { describe, it, expect } from "vitest";
import {
  ensureDimensions,
  ensureStyleCache,
  getStyleFromCache,
  isValidColor,
  isDefaultTextColor,
  isDefaultBackgroundColor,
} from "./styleUtils";
import type { StyleData, StyleDataMap } from "../../../types";
import { DEFAULT_STYLE, createEmptyDimensionOverrides } from "../../../types";

// ============================================================================
// ensureDimensions
// ============================================================================

describe("ensureDimensions", () => {
  it("returns default when null", () => {
    const dims = ensureDimensions(null);
    expect(dims.columnWidths).toBeInstanceOf(Map);
    expect(dims.rowHeights).toBeInstanceOf(Map);
  });

  it("returns default when undefined", () => {
    const dims = ensureDimensions(undefined);
    expect(dims.columnWidths).toBeInstanceOf(Map);
  });

  it("returns the same object when valid", () => {
    const input = createEmptyDimensionOverrides();
    expect(ensureDimensions(input)).toBe(input);
  });
});

// ============================================================================
// ensureStyleCache
// ============================================================================

describe("ensureStyleCache", () => {
  it("returns default cache when null", () => {
    const cache = ensureStyleCache(null);
    expect(cache.size).toBe(1);
    expect(cache.get(0)).toEqual(DEFAULT_STYLE);
  });

  it("returns default cache when empty map", () => {
    const cache = ensureStyleCache(new Map());
    expect(cache.size).toBe(1);
  });

  it("returns provided cache when non-empty", () => {
    const input: StyleDataMap = new Map();
    input.set(0, DEFAULT_STYLE);
    input.set(1, { ...DEFAULT_STYLE, bold: true });
    expect(ensureStyleCache(input)).toBe(input);
  });
});

// ============================================================================
// getStyleFromCache
// ============================================================================

describe("getStyleFromCache", () => {
  it("returns style at given index", () => {
    const cache: StyleDataMap = new Map();
    const boldStyle = { ...DEFAULT_STYLE, bold: true };
    cache.set(0, DEFAULT_STYLE);
    cache.set(5, boldStyle);
    expect(getStyleFromCache(cache, 5)).toBe(boldStyle);
  });

  it("falls back to index 0 when index not found", () => {
    const cache: StyleDataMap = new Map();
    cache.set(0, DEFAULT_STYLE);
    expect(getStyleFromCache(cache, 999)).toBe(DEFAULT_STYLE);
  });

  it("falls back to DEFAULT_STYLE when cache has no index 0", () => {
    const cache: StyleDataMap = new Map();
    cache.set(5, { ...DEFAULT_STYLE, bold: true });
    const result = getStyleFromCache(cache, 99);
    expect(result).toEqual(DEFAULT_STYLE);
  });
});

// ============================================================================
// isValidColor
// ============================================================================

describe("isValidColor", () => {
  it("returns false for null/undefined/empty", () => {
    expect(isValidColor(null)).toBe(false);
    expect(isValidColor(undefined)).toBe(false);
    expect(isValidColor("")).toBe(false);
    expect(isValidColor("  ")).toBe(false);
  });

  it("validates 3-digit hex", () => {
    expect(isValidColor("#fff")).toBe(true);
    expect(isValidColor("#F00")).toBe(true);
  });

  it("validates 6-digit hex", () => {
    expect(isValidColor("#ff0000")).toBe(true);
    expect(isValidColor("#ABCDEF")).toBe(true);
  });

  it("validates 8-digit hex (with alpha)", () => {
    expect(isValidColor("#ff000080")).toBe(true);
  });

  it("validates hex without # prefix", () => {
    expect(isValidColor("ff0000")).toBe(true);
    expect(isValidColor("ABCDEF")).toBe(true);
  });

  it("validates rgb()", () => {
    expect(isValidColor("rgb(255, 0, 0)")).toBe(true);
    expect(isValidColor("rgb(0,0,0)")).toBe(true);
  });

  it("validates rgba()", () => {
    expect(isValidColor("rgba(255, 0, 0, 0.5)")).toBe(true);
  });

  it("validates named colors", () => {
    expect(isValidColor("red")).toBe(true);
    expect(isValidColor("Blue")).toBe(true);
    expect(isValidColor("transparent")).toBe(true);
  });

  it("rejects invalid strings", () => {
    expect(isValidColor("not-a-color")).toBe(false);
    expect(isValidColor("#xyz")).toBe(false);
    expect(isValidColor("rgb(a,b,c)")).toBe(false);
  });
});

// ============================================================================
// isDefaultTextColor
// ============================================================================

describe("isDefaultTextColor", () => {
  it("returns true for null/undefined", () => {
    expect(isDefaultTextColor(null)).toBe(true);
    expect(isDefaultTextColor(undefined)).toBe(true);
  });

  it("returns true for black variants", () => {
    expect(isDefaultTextColor("#000000")).toBe(true);
    expect(isDefaultTextColor("#000")).toBe(true);
    expect(isDefaultTextColor("000000")).toBe(true);
    expect(isDefaultTextColor("black")).toBe(true);
    expect(isDefaultTextColor("rgb(0, 0, 0)")).toBe(true);
    expect(isDefaultTextColor("rgb(0,0,0)")).toBe(true);
    expect(isDefaultTextColor("rgba(0, 0, 0, 1)")).toBe(true);
  });

  it("returns false for non-black colors", () => {
    expect(isDefaultTextColor("#ff0000")).toBe(false);
    expect(isDefaultTextColor("red")).toBe(false);
    expect(isDefaultTextColor("rgb(0, 0, 1)")).toBe(false);
  });
});

// ============================================================================
// isDefaultBackgroundColor
// ============================================================================

describe("isDefaultBackgroundColor", () => {
  it("returns true for null/undefined", () => {
    expect(isDefaultBackgroundColor(null)).toBe(true);
    expect(isDefaultBackgroundColor(undefined)).toBe(true);
  });

  it("returns true for white variants", () => {
    expect(isDefaultBackgroundColor("#ffffff")).toBe(true);
    expect(isDefaultBackgroundColor("#fff")).toBe(true);
    expect(isDefaultBackgroundColor("ffffff")).toBe(true);
    expect(isDefaultBackgroundColor("white")).toBe(true);
    expect(isDefaultBackgroundColor("rgb(255, 255, 255)")).toBe(true);
  });

  it("returns true for transparent variants", () => {
    expect(isDefaultBackgroundColor("transparent")).toBe(true);
    expect(isDefaultBackgroundColor("rgba(0, 0, 0, 0)")).toBe(true);
  });

  it("returns false for non-white/non-transparent colors", () => {
    expect(isDefaultBackgroundColor("#f0f0f0")).toBe(false);
    expect(isDefaultBackgroundColor("red")).toBe(false);
  });
});
