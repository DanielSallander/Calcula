// FILENAME: app/extensions/Collaboration/lib/__tests__/inkContrast.test.ts
// PURPOSE: The colour arithmetic behind the rejected-value ink: which spellings
//          parse as an OPAQUE colour, the WCAG contrast ratio, and the first
//          ink of a list that reads (3:1) on a fill.

import { describe, it, expect } from "vitest";
import {
  contrastRatio,
  firstReadableInk,
  parseOpaqueColour,
  relativeLuminance,
  MIN_INK_CONTRAST,
} from "../inkContrast";

describe("parseOpaqueColour", () => {
  it("reads the spellings a cell style and a theme token use", () => {
    expect(parseOpaqueColour("#ffc7ce")).toEqual([255, 199, 206]);
    expect(parseOpaqueColour("#FFC7CE")).toEqual([255, 199, 206]);
    expect(parseOpaqueColour("ffc7ce")).toEqual([255, 199, 206]);
    expect(parseOpaqueColour("#fc0")).toEqual([255, 204, 0]);
    expect(parseOpaqueColour("#fc0f")).toEqual([255, 204, 0]);
    expect(parseOpaqueColour("#ffc7ceff")).toEqual([255, 199, 206]);
    expect(parseOpaqueColour("rgb(31, 78, 121)")).toEqual([31, 78, 121]);
    expect(parseOpaqueColour(" rgba(31,78,121,1) ")).toEqual([31, 78, 121]);
    expect(parseOpaqueColour("rgba(31, 78, 121, 100%)")).toEqual([31, 78, 121]);
  });

  it("refuses what it cannot know is painted as written: translucent, named, functions, nonsense", () => {
    for (const c of [
      undefined,
      null,
      "",
      "#ff000080",
      "#f008",
      "rgba(255, 0, 0, 0.5)",
      "rgba(255, 0, 0, 50%)",
      "red",
      "transparent",
      "color-mix(in srgb, red, blue)",
      "var(--tone-danger-fg)",
      "#12345",
      "rgb(300, 0, 0)",
    ]) {
      expect(parseOpaqueColour(c as string), String(c)).toBeNull();
    }
  });
});

describe("contrast", () => {
  it("is WCAG 2's: white on black 21:1, a colour on itself 1:1", () => {
    expect(relativeLuminance([255, 255, 255])).toBeCloseTo(1, 9);
    expect(relativeLuminance([0, 0, 0])).toBe(0);
    expect(contrastRatio([255, 255, 255], [0, 0, 0])).toBeCloseTo(21, 9);
    expect(contrastRatio([0, 0, 0], [255, 255, 255])).toBeCloseTo(21, 9);
    expect(contrastRatio([31, 78, 121], [31, 78, 121])).toBe(1);
  });

  it("measures the review's cases (2026-10-22)", () => {
    const light = parseOpaqueColour("#b42318")!;
    const dark = parseOpaqueColour("#fda29b")!;
    expect(contrastRatio(dark, parseOpaqueColour("#ffc7ce")!)).toBeCloseTo(1.32, 2);
    expect(contrastRatio(light, parseOpaqueColour("#ffc7ce")!)).toBeCloseTo(4.48, 2);
    expect(contrastRatio(light, parseOpaqueColour("#ffffff")!)).toBeCloseTo(6.57, 2);
    expect(contrastRatio(dark, parseOpaqueColour("#1e1e1e")!)).toBeCloseTo(8.59, 2);
  });
});

describe("firstReadableInk", () => {
  it("the first ink, in order, that reaches 3:1 on the fill", () => {
    expect(MIN_INK_CONTRAST).toBe(3);
    expect(firstReadableInk("#ffc7ce", ["#fda29b", "#b42318"])).toBe("#b42318");
    expect(firstReadableInk("#ffc7ce", ["#b42318", "#fda29b"])).toBe("#b42318");
    expect(firstReadableInk("#1f4e79", ["#b42318", "#fda29b"])).toBe("#fda29b");
  });

  it("null when none reads, or when the fill cannot be read; an ink that cannot be parsed is passed over", () => {
    expect(firstReadableInk("#4472c4", ["#b42318", "#fda29b"])).toBeNull();
    expect(firstReadableInk("rgba(0,0,0,0.5)", ["#b42318"])).toBeNull();
    expect(firstReadableInk("#ffc7ce", ["var(--x)", "#b42318"])).toBe("#b42318");
  });
});
