//! FILENAME: app/extensions/ConditionalFormatting/lib/__tests__/cfTypes.test.ts
// PURPOSE: Tests for CF preset definitions and the adjustColorBrightness utility.

import { describe, it, expect } from "vitest";
import {
  PRESET_STYLES,
  PRESET_COLOR_SCALES,
  PRESET_DATA_BAR_COLORS,
} from "../../types";

// ============================================================================
// Preset Styles Tests
// ============================================================================

describe("PRESET_STYLES", () => {
  it("contains 6 preset styles", () => {
    expect(PRESET_STYLES).toHaveLength(6);
  });

  it("each preset has label, backgroundColor, and textColor", () => {
    for (const preset of PRESET_STYLES) {
      expect(preset).toHaveProperty("label");
      expect(preset).toHaveProperty("backgroundColor");
      expect(preset).toHaveProperty("textColor");
      expect(typeof preset.label).toBe("string");
      expect(typeof preset.backgroundColor).toBe("string");
      expect(typeof preset.textColor).toBe("string");
    }
  });

  it("first preset is Light Red Fill with Dark Red Text", () => {
    expect(PRESET_STYLES[0].label).toBe("Light Red Fill with Dark Red Text");
    expect(PRESET_STYLES[0].backgroundColor).toBe("#FFC7CE");
    expect(PRESET_STYLES[0].textColor).toBe("#9C0006");
  });

  it("Yellow preset has correct colors", () => {
    const yellow = PRESET_STYLES.find((p) =>
      p.label.includes("Yellow"),
    );
    expect(yellow).toBeDefined();
    expect(yellow!.backgroundColor).toBe("#FFEB9C");
    expect(yellow!.textColor).toBe("#9C5700");
  });

  it("Green preset has correct colors", () => {
    const green = PRESET_STYLES.find((p) =>
      p.label.includes("Green Fill"),
    );
    expect(green).toBeDefined();
    expect(green!.backgroundColor).toBe("#C6EFCE");
    expect(green!.textColor).toBe("#006100");
  });

  it("some presets have empty backgroundColor or textColor", () => {
    const redText = PRESET_STYLES.find((p) => p.label === "Red Text");
    expect(redText).toBeDefined();
    expect(redText!.backgroundColor).toBe("");
    expect(redText!.textColor).toBe("#9C0006");

    const redBorder = PRESET_STYLES.find((p) => p.label === "Red Border");
    expect(redBorder).toBeDefined();
    expect(redBorder!.backgroundColor).toBe("");
    expect(redBorder!.textColor).toBe("");
  });

  it("all non-empty colors are valid hex colors", () => {
    const hexPattern = /^#[0-9A-Fa-f]{6}$/;
    for (const preset of PRESET_STYLES) {
      if (preset.backgroundColor) {
        expect(preset.backgroundColor).toMatch(hexPattern);
      }
      if (preset.textColor) {
        expect(preset.textColor).toMatch(hexPattern);
      }
    }
  });
});

// ============================================================================
// Preset Color Scales Tests
// ============================================================================

describe("PRESET_COLOR_SCALES", () => {
  it("contains 8 color scale presets", () => {
    expect(PRESET_COLOR_SCALES).toHaveLength(8);
  });

  it("each preset has label, minColor, and maxColor", () => {
    for (const scale of PRESET_COLOR_SCALES) {
      expect(scale).toHaveProperty("label");
      expect(scale).toHaveProperty("minColor");
      expect(scale).toHaveProperty("maxColor");
      expect(typeof scale.label).toBe("string");
    }
  });

  it("three-color scales have midColor", () => {
    const threeColorScales = PRESET_COLOR_SCALES.filter(
      (s) => s.midColor !== undefined,
    );
    expect(threeColorScales.length).toBeGreaterThanOrEqual(4);
    for (const scale of threeColorScales) {
      expect(typeof scale.midColor).toBe("string");
    }
  });

  it("two-color scales do not have midColor", () => {
    const twoColorScales = PRESET_COLOR_SCALES.filter(
      (s) => s.midColor === undefined,
    );
    expect(twoColorScales.length).toBeGreaterThanOrEqual(4);
  });

  it("Green-Yellow-Red scale has correct colors", () => {
    const gyr = PRESET_COLOR_SCALES[0];
    expect(gyr.label).toBe("Green - Yellow - Red");
    expect(gyr.minColor).toBe("#63BE7B");
    expect(gyr.midColor).toBe("#FFEB84");
    expect(gyr.maxColor).toBe("#F8696B");
  });

  it("Red-Yellow-Green is reverse of Green-Yellow-Red", () => {
    const gyr = PRESET_COLOR_SCALES[0];
    const ryg = PRESET_COLOR_SCALES[1];
    expect(ryg.minColor).toBe(gyr.maxColor);
    expect(ryg.maxColor).toBe(gyr.minColor);
    expect(ryg.midColor).toBe(gyr.midColor);
  });

  it("all colors are valid hex", () => {
    const hexPattern = /^#[0-9A-Fa-f]{6}$/;
    for (const scale of PRESET_COLOR_SCALES) {
      expect(scale.minColor).toMatch(hexPattern);
      expect(scale.maxColor).toMatch(hexPattern);
      if (scale.midColor) {
        expect(scale.midColor).toMatch(hexPattern);
      }
    }
  });
});

// ============================================================================
// Preset Data Bar Colors Tests
// ============================================================================

describe("PRESET_DATA_BAR_COLORS", () => {
  it("contains 6 colors", () => {
    expect(PRESET_DATA_BAR_COLORS).toHaveLength(6);
  });

  it("first color is blue (default)", () => {
    expect(PRESET_DATA_BAR_COLORS[0]).toBe("#638EC6");
  });

  it("all are valid hex colors", () => {
    const hexPattern = /^#[0-9A-Fa-f]{6}$/;
    for (const color of PRESET_DATA_BAR_COLORS) {
      expect(color).toMatch(hexPattern);
    }
  });

  it("all colors are unique", () => {
    const unique = new Set(PRESET_DATA_BAR_COLORS);
    expect(unique.size).toBe(PRESET_DATA_BAR_COLORS.length);
  });
});
