//! FILENAME: app/extensions/Slicer/__tests__/slicerFocusRingContrast.test.ts
// PURPOSE: The keyboard focus ring (M8 S7, plan decision KD4) is visible on
//          EVERY slicer preset: a 2px dark outline with a 1px light line
//          inside it, so whatever fill the focused item has -- a preset's
//          selected fill (the #4472C4 family and its six accents), its
//          unselected fill, its background, or the no-data grey -- one of the
//          two tones reaches 3:1 against it (WCAG 2.2 SC 1.4.11, non-text
//          contrast), and the two tones reach 3:1 against each other.
//          Measured over `slicerPresetColorSets()`: the gallery's presets AND
//          the legacy ids, i.e. every preset the renderer can paint.

import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/slicerStore", () => ({
  getSlicerById: () => undefined,
  getCachedItems: () => undefined,
}));
vi.mock("@api/objectScriptBadge", () => ({ drawObjectScriptBadgeIfPresent: () => {} }));
vi.mock("@api", () => ({ getSlicerItemBitmap: () => null, hasSlicerItemBitmapRenderer: () => false }));

import {
  SLICER_FOCUS_RING_DARK,
  SLICER_FOCUS_RING_LIGHT,
  SLICER_NO_DATA_FILL,
  slicerPresetColorSets,
} from "../rendering/slicerRenderer";

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`not a #rrggbb colour: ${hex}`);
  const lin = (h: string) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]);
}

/** WCAG contrast ratio of two colours (1 .. 21). */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** The better of the ring's two tones against `fill`. */
const ringAgainst = (fill: string) => Math.max(contrast(SLICER_FOCUS_RING_DARK, fill), contrast(SLICER_FOCUS_RING_LIGHT, fill));

describe("the slicer focus ring's contrast (WCAG 2.2 SC 1.4.11)", () => {
  const presets = slicerPresetColorSets();

  it("measures every preset: the gallery's 42 (Light 1-28, Dark 1-14) and the three legacy ids", () => {
    expect(presets.length).toBe(45);
    expect(presets.map((p) => p.id)).toEqual(expect.arrayContaining(["slicer-light-2", "slicer-dark-14", "SlicerStyleLight1", "SlicerStyleDark1"]));
  });

  it("one of the two tones reaches 3:1 against every preset's SELECTED and UNSELECTED fill and its background", () => {
    const failures: string[] = [];
    for (const { id, colors } of presets) {
      for (const [name, fill] of [
        ["selectedBg", colors.selectedBg],
        ["itemBg", colors.itemBg],
        ["bg", colors.bg],
      ] as const) {
        const ratio = ringAgainst(fill);
        if (ratio < 3) failures.push(`${id} ${name} ${fill}: ${ratio.toFixed(2)}:1`);
      }
    }
    expect(failures, "the focus ring is invisible on these fills").toEqual([]);
  });

  it("and against the no-data grey", () => {
    expect(ringAgainst(SLICER_NO_DATA_FILL)).toBeGreaterThanOrEqual(3);
  });

  it("the two tones reach 3:1 against each other (each line stays visible beside the other)", () => {
    expect(contrast(SLICER_FOCUS_RING_DARK, SLICER_FOCUS_RING_LIGHT)).toBeGreaterThanOrEqual(3);
  });
});
