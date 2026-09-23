//! FILENAME: app/extensions/Slicer/lib/__tests__/slicerStyles.test.ts
// PURPOSE: The slicer style presets moved from the gallery component into
//          lib/slicerStyles.ts. Their ids are PERSISTED (Slicer.stylePreset),
//          so the move must not renumber, reorder or drop one — and the old
//          import path the canvas renderer uses must hand back the very same
//          objects, not a second copy that could drift.

import { describe, it, expect } from "vitest";
import {
  SLICER_STYLES,
  SLICER_STYLES_BY_ID,
  DEFAULT_SLICER_STYLE_ID,
  generateSlicerStyles,
  slicerStyleName,
  slicerStyleNumber,
} from "../slicerStyles";
import * as galleryModule from "../../components/SlicerStylesGallery";

describe("slicer style presets", () => {
  it("are Light 1-28 then Dark 1-14, numbered as Excel numbers them", () => {
    const ids = SLICER_STYLES.map((s) => s.id);
    const expected = [
      ...Array.from({ length: 28 }, (_, i) => `slicer-light-${i + 1}`),
      ...Array.from({ length: 14 }, (_, i) => `slicer-dark-${i + 1}`),
    ];
    expect(ids).toEqual(expected);
    for (const s of SLICER_STYLES) {
      expect(s.id).toBe(`slicer-${s.category}-${slicerStyleNumber(s)}`);
    }
  });

  it("index every preset by id, including the default", () => {
    expect(SLICER_STYLES_BY_ID.size).toBe(SLICER_STYLES.length);
    expect(SLICER_STYLES_BY_ID.get(DEFAULT_SLICER_STYLE_ID)?.accentIndex).toBe(1);
  });

  it("keep the colours the renderer paints (Light 2 = the blue accent, coloured header)", () => {
    expect(SLICER_STYLES_BY_ID.get("slicer-light-2")?.thumb).toEqual({
      headerBg: "#4472c4",
      headerFg: "#ffffff",
      selectedBg: "#4472c4",
      selectedFg: "#ffffff",
      itemBg: "#edf2f9",
      itemFg: "#333333",
      bg: "#ffffff",
      border: "#8faadc",
    });
  });

  it("are generated deterministically", () => {
    expect(generateSlicerStyles()).toEqual(SLICER_STYLES);
  });

  it("carry the gallery names", () => {
    expect(slicerStyleName(SLICER_STYLES_BY_ID.get("slicer-light-9")!)).toBe("Light 9");
    expect(slicerStyleName(SLICER_STYLES_BY_ID.get("slicer-dark-14")!)).toBe("Dark 14");
  });

  it("are re-exported unchanged from the gallery module the renderer imports", () => {
    expect(galleryModule.SLICER_STYLES).toBe(SLICER_STYLES);
    expect(galleryModule.SLICER_STYLES_BY_ID).toBe(SLICER_STYLES_BY_ID);
    expect(galleryModule.DEFAULT_SLICER_STYLE_ID).toBe(DEFAULT_SLICER_STYLE_ID);
  });
});
