//! FILENAME: app/src/core/lib/gridRenderer/styles/color-parameterized.test.ts
// PURPOSE: Parameterized tests for color validation and default-color detection.
// CONTEXT: Exhaustive input coverage for isValidColor, isDefaultTextColor, isDefaultBackgroundColor.

import { describe, it, expect } from "vitest";
import { isValidColor, isDefaultTextColor, isDefaultBackgroundColor } from "./styleUtils";

// ============================================================================
// isValidColor - 200 inputs
// ============================================================================

describe("isValidColor", () => {
  // --- 50 valid hex colors ---
  describe("valid hex colors", () => {
    it.each([
      // 6-digit with #
      ["#000000"], ["#ffffff"], ["#FF0000"], ["#00ff00"], ["#0000FF"],
      ["#4472c4"], ["#123456"], ["#abcdef"], ["#ABCDEF"], ["#aAbBcC"],
      ["#112233"], ["#445566"], ["#778899"], ["#aabbcc"], ["#ddeeff"],
      ["#010101"], ["#fefefe"], ["#a0b0c0"], ["#d1e2f3"], ["#987654"],
      // 3-digit with #
      ["#000"], ["#fff"], ["#f00"], ["#0f0"], ["#00f"],
      ["#abc"], ["#ABC"], ["#123"], ["#fFf"], ["#a1b"],
      // 8-digit with # (RGBA)
      ["#00000000"], ["#ffffffff"], ["#FF000080"], ["#12345678"], ["#abcdef99"],
      // 4-digit with # (RGBA shorthand)
      ["#0000"], ["#ffff"], ["#f00f"], ["#abcd"], ["#ABCD"],
      // 6-digit without # (backend format)
      ["000000"], ["ffffff"], ["FF0000"], ["4472c4"], ["abcdef"],
      // 8-digit without #
      ["00000000"], ["ffffffff"], ["FF000080"], ["12345678"], ["abcdef99"],
    ] as [string][])("accepts %s", (color) => {
      expect(isValidColor(color)).toBe(true);
    });
  });

  // --- 30 valid rgb/rgba ---
  describe("valid rgb/rgba strings", () => {
    it.each([
      ["rgb(0, 0, 0)"], ["rgb(255, 255, 255)"], ["rgb(128, 128, 128)"],
      ["rgb(0,0,0)"], ["rgb(255,255,255)"], ["rgb(100, 200, 50)"],
      ["rgb(1, 2, 3)"], ["rgb(10, 20, 30)"], ["rgb(99, 99, 99)"],
      ["rgb(255, 0, 0)"], ["rgb(0, 255, 0)"], ["rgb(0, 0, 255)"],
      ["rgb(127, 127, 127)"], ["rgb(64, 128, 192)"], ["rgb(33, 66, 99)"],
      ["rgba(0, 0, 0, 1)"], ["rgba(255, 255, 255, 0)"], ["rgba(128, 128, 128, 0.5)"],
      ["rgba(0,0,0,1)"], ["rgba(255,255,255,0.5)"], ["rgba(100, 200, 50, 0.75)"],
      ["rgba(255, 0, 0, 1)"], ["rgba(0, 255, 0, 0.1)"], ["rgba(0, 0, 255, 0.99)"],
      ["rgba(10, 20, 30, 0)"], ["rgba(50, 100, 150, 0.333)"],
      ["RGB(0, 0, 0)"], ["Rgb(128, 128, 128)"], ["RGBA(0, 0, 0, 1)"],
      ["rgba(0, 0, 0, 0)"],
    ] as [string][])("accepts %s", (color) => {
      expect(isValidColor(color)).toBe(true);
    });
  });

  // --- 20 valid named colors ---
  describe("valid named colors", () => {
    it.each([
      ["black"], ["white"], ["red"], ["green"], ["blue"],
      ["yellow"], ["cyan"], ["magenta"], ["gray"], ["grey"],
      ["orange"], ["pink"], ["purple"], ["brown"], ["transparent"],
      ["Black"], ["WHITE"], ["Red"], ["GREEN"], ["Blue"],
    ] as [string][])("accepts %s", (color) => {
      expect(isValidColor(color)).toBe(true);
    });
  });

  // --- 50 invalid strings ---
  describe("invalid strings", () => {
    it.each([
      [""], ["   "], ["#"], ["##000000"], ["#0"], ["#00"],
      ["#00000"], ["#0000000"], ["#000000000"],
      ["#gggggg"], ["#xyz"], ["#GHIJKL"], ["#12345g"],
      ["rgb("], ["rgb()"],
      ["rgb(0, 0)"],
      ["hsl(0, 100%, 50%)"], ["hsla(0, 100%, 50%, 1)"],
      ["not-a-color"], ["redd"], ["bluee"], ["greenish"],
      ["#red"], ["color"], ["none"], ["inherit"], ["initial"],
      ["currentColor"], ["unset"], ["revert"],
      ["12345"], ["1234567"], ["123"],
      ["rgb 0 0 0"], ["rgb[0,0,0]"], ["rgb{0,0,0}"],
      ["0x000000"], ["0xFF0000"],
      ["null"], ["undefined"], ["NaN"], ["true"], ["false"],
      ["hello world"], [" # 000000"], ["#000 000"],
      ["rgb(0, 0, 0, 0, 0)"],
    ] as [string][])("rejects '%s'", (color) => {
      expect(isValidColor(color)).toBe(false);
    });
  });

  // --- 50 edge/borderline cases ---
  describe("edge cases", () => {
    it.each([
      // null/undefined
      [null as unknown as string, false],
      [undefined as unknown as string, false],
      // whitespace around valid values
      ["  #000000  ", true],
      ["  rgb(0, 0, 0)  ", true],
      ["  black  ", true],
      [" #fff ", true],
      ["\t#000000\t", true],
      ["\n#ffffff\n", true],
      // mixed case hex
      ["#aAbBcC", true],
      ["#FfFfFf", true],
      ["#AbCdEf", true],
      ["FFFFFF", true],
      ["aabbcc", true],
      // numbers as type coercion edge
      [0 as unknown as string, false],
      [123 as unknown as string, false],
      [NaN as unknown as string, false],
      [false as unknown as string, false],
      [true as unknown as string, false],
      [{} as unknown as string, false],
      [[] as unknown as string, false],
      // unicode and special characters
      ["\u0000", false],
      ["\u00ff", false],
      ["#\u0030\u0030\u0030\u0030\u0030\u0030", true], // unicode digits for #000000
      ["\u200b#000000", false], // zero-width space prefix
      ["#000000\u200b", false], // zero-width space suffix
      // named color variations
      ["BLACK", true],
      ["White", true],
      ["TRANSPARENT", true],
      ["  transparent  ", true],
      ["blac", false],
      ["whi", false],
      ["reds", false],
      ["darkblue", false], // not in the named list
      ["lightgreen", false],
      ["navy", false],
      ["teal", false],
      ["coral", false],
      ["salmon", false],
      ["indigo", false],
      ["violet", false],
      ["lime", false],
      ["aqua", false],
      ["maroon", false],
      ["olive", false],
      ["silver", false],
      ["fuchsia", false],
      // extreme whitespace
      ["     ", false],
      ["\t\t\t", false],
      ["\n\n", false],
    ] as [unknown, boolean][])("isValidColor(%j) => %s", (color, expected) => {
      expect(isValidColor(color as string)).toBe(expected);
    });
  });
});

// ============================================================================
// isDefaultTextColor - 40 inputs
// ============================================================================

describe("isDefaultTextColor", () => {
  describe("should return true for black/default representations", () => {
    it.each([
      [null as unknown as string],
      [undefined as unknown as string],
      [""],
      ["#000000"],
      ["#000"],
      ["000000"],
      ["black"],
      ["BLACK"],
      ["Black"],
      ["  black  "],
      [" #000000 "],
      [" #000 "],
      [" 000000 "],
      ["rgb(0, 0, 0)"],
      ["rgb(0,0,0)"],
      ["RGB(0, 0, 0)"],
      ["  rgb(0, 0, 0)  "],
      ["rgba(0, 0, 0, 1)"],
      ["rgba(0,0,0,1)"],
      ["  rgba(0, 0, 0, 1)  "],
    ] as [unknown][])("isDefaultTextColor(%j) => true", (color) => {
      expect(isDefaultTextColor(color as string)).toBe(true);
    });
  });

  describe("should return false for non-black colors", () => {
    it.each([
      ["#000001"],
      ["#010101"],
      ["#111111"],
      ["#ffffff"],
      ["#ff0000"],
      ["white"],
      ["red"],
      ["rgb(1, 0, 0)"],
      ["rgb(0, 1, 0)"],
      ["rgb(0, 0, 1)"],
      ["rgba(0, 0, 0, 0)"],
      ["rgba(0, 0, 0, 0.5)"],
      ["rgba(0, 0, 0, 0.99)"],
      ["#333333"],
      ["#0a0a0a"],
      ["dark"],
      ["rgb(10, 10, 10)"],
      ["transparent"],
      ["#00000000"],
      ["rgba(0,0,0,0)"],
    ] as [string][])("isDefaultTextColor('%s') => false", (color) => {
      expect(isDefaultTextColor(color)).toBe(false);
    });
  });
});

// ============================================================================
// isDefaultBackgroundColor - 40 inputs
// ============================================================================

describe("isDefaultBackgroundColor", () => {
  describe("should return true for white/transparent/default", () => {
    it.each([
      [null as unknown as string],
      [undefined as unknown as string],
      [""],
      ["#ffffff"],
      ["#fff"],
      ["ffffff"],
      ["white"],
      ["WHITE"],
      ["White"],
      ["  white  "],
      [" #ffffff "],
      [" #fff "],
      [" ffffff "],
      ["transparent"],
      ["TRANSPARENT"],
      ["  transparent  "],
      ["rgb(255, 255, 255)"],
      ["rgb(255,255,255)"],
      ["  rgb(255, 255, 255)  "],
      ["rgba(255, 255, 255, 1)"],
      ["rgba(255,255,255,1)"],
      ["rgba(0, 0, 0, 0)"],
      ["rgba(0,0,0,0)"],
    ] as [unknown][])("isDefaultBackgroundColor(%j) => true", (color) => {
      expect(isDefaultBackgroundColor(color as string)).toBe(true);
    });
  });

  describe("should return false for non-white/non-transparent", () => {
    it.each([
      ["#fffffe"],
      ["#fefefe"],
      ["#f0f0f0"],
      ["#000000"],
      ["#ff0000"],
      ["black"],
      ["red"],
      ["rgb(255, 255, 254)"],
      ["rgb(254, 255, 255)"],
      ["rgb(0, 0, 0)"],
      ["rgba(255, 255, 255, 0.5)"],
      ["rgba(255, 255, 255, 0)"],
      ["rgba(0, 0, 0, 1)"],
      ["#eeeeee"],
      ["#cccccc"],
      ["rgb(128, 128, 128)"],
      ["rgba(255, 255, 255, 0.99)"],
    ] as [string][])("isDefaultBackgroundColor('%s') => false", (color) => {
      expect(isDefaultBackgroundColor(color)).toBe(false);
    });
  });
});
