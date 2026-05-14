//! FILENAME: app/extensions/Charts/lib/__tests__/chartStylePresets.test.ts
// PURPOSE: Tests for chart style preset definitions and application logic.

import { describe, it, expect } from "vitest";
import {
  CHART_STYLE_PRESETS,
  getPresetById,
  getPresetsByCategory,
  getPresetColors,
  buildPresetUpdates,
  type ChartStylePreset,
} from "../chartStylePresets";

// ============================================================================
// Preset Collection Tests
// ============================================================================

describe("CHART_STYLE_PRESETS", () => {
  it("has at least 16 presets", () => {
    expect(CHART_STYLE_PRESETS.length).toBeGreaterThanOrEqual(16);
  });

  it("all presets have unique IDs", () => {
    const ids = CHART_STYLE_PRESETS.map((p) => p.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  it("all presets have required fields", () => {
    for (const preset of CHART_STYLE_PRESETS) {
      expect(preset.id).toBeTruthy();
      expect(preset.name).toBeTruthy();
      expect(preset.category).toBeTruthy();
      expect(preset.palette).toBeTruthy();
      expect(preset.theme).toBeDefined();
      expect(typeof preset.gridLines).toBe("boolean");
      expect(typeof preset.barBorderRadius).toBe("number");
    }
  });

  it("all presets reference valid palette names", () => {
    const validPalettes = ["default", "vivid", "pastel", "ocean"];
    for (const preset of CHART_STYLE_PRESETS) {
      expect(validPalettes).toContain(preset.palette);
    }
  });

  it("all presets have valid categories", () => {
    const validCategories = ["colorful", "monochromatic", "dark", "outline", "gradient"];
    for (const preset of CHART_STYLE_PRESETS) {
      expect(validCategories).toContain(preset.category);
    }
  });

  it("all presets have a background color in theme", () => {
    for (const preset of CHART_STYLE_PRESETS) {
      expect(preset.theme.background).toBeTruthy();
    }
  });
});

// ============================================================================
// Preset Lookup Tests
// ============================================================================

describe("getPresetById", () => {
  it("finds existing presets", () => {
    const preset = getPresetById("colorful-1");
    expect(preset).toBeDefined();
    expect(preset!.name).toBe("Classic");
  });

  it("returns undefined for non-existent ID", () => {
    expect(getPresetById("nonexistent")).toBeUndefined();
  });

  it("finds presets in all categories", () => {
    expect(getPresetById("colorful-1")).toBeDefined();
    expect(getPresetById("mono-blue")).toBeDefined();
    expect(getPresetById("dark-1")).toBeDefined();
    expect(getPresetById("outline-1")).toBeDefined();
  });
});

// ============================================================================
// Category Grouping Tests
// ============================================================================

describe("getPresetsByCategory", () => {
  it("groups presets by category", () => {
    const grouped = getPresetsByCategory();
    expect(Object.keys(grouped).length).toBeGreaterThanOrEqual(4);
    expect(grouped.colorful).toBeDefined();
    expect(grouped.monochromatic).toBeDefined();
    expect(grouped.dark).toBeDefined();
    expect(grouped.outline).toBeDefined();
  });

  it("each category has at least 3 presets", () => {
    const grouped = getPresetsByCategory();
    for (const category of Object.values(grouped)) {
      expect(category.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("total across categories matches CHART_STYLE_PRESETS length", () => {
    const grouped = getPresetsByCategory();
    const total = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
    expect(total).toBe(CHART_STYLE_PRESETS.length);
  });
});

// ============================================================================
// Preset Colors Tests
// ============================================================================

describe("getPresetColors", () => {
  it("returns 4 colors for each preset", () => {
    for (const preset of CHART_STYLE_PRESETS) {
      const colors = getPresetColors(preset);
      expect(colors).toHaveLength(4);
      for (const color of colors) {
        expect(color).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });
});

// ============================================================================
// Apply Preset Tests
// ============================================================================

describe("buildPresetUpdates", () => {
  const mockSpec = {
    yAxis: { gridLines: true, showLabels: true, title: null, labelAngle: 0, min: null, max: null },
    markOptions: {},
  };

  it("returns palette and config updates", () => {
    const preset = getPresetById("colorful-1")!;
    const updates = buildPresetUpdates(preset, mockSpec);

    expect(updates.palette).toBe("default");
    expect(updates.config).toBeDefined();
    expect((updates.config as any).theme).toBeDefined();
    expect((updates.config as any).theme.background).toBe("#ffffff");
  });

  it("includes gridLines update in yAxis", () => {
    const preset = getPresetById("colorful-6")!; // Minimal — no gridlines
    const updates = buildPresetUpdates(preset, mockSpec);

    expect((updates.yAxis as any).gridLines).toBe(false);
  });

  it("includes barBorderRadius in theme overrides", () => {
    const preset = getPresetById("outline-2")!; // Rounded — radius 6
    const updates = buildPresetUpdates(preset, mockSpec);

    expect((updates.config as any).theme.barBorderRadius).toBe(6);
  });

  it("preserves existing yAxis properties", () => {
    const preset = getPresetById("dark-1")!;
    const updates = buildPresetUpdates(preset, mockSpec);

    expect((updates.yAxis as any).showLabels).toBe(true);
    expect((updates.yAxis as any).title).toBeNull();
  });

  it("dark presets have dark background colors", () => {
    const darkPresets = CHART_STYLE_PRESETS.filter((p) => p.category === "dark");
    for (const preset of darkPresets) {
      const bg = preset.theme.background!;
      // Dark backgrounds should have low luminance (first hex byte < 0x40)
      const r = parseInt(bg.slice(1, 3), 16);
      expect(r).toBeLessThan(64);
    }
  });
});

// ============================================================================
// Serialization Tests
// ============================================================================

describe("preset serialization", () => {
  it("all presets survive JSON roundtrip", () => {
    const json = JSON.stringify(CHART_STYLE_PRESETS);
    const parsed: ChartStylePreset[] = JSON.parse(json);

    expect(parsed).toHaveLength(CHART_STYLE_PRESETS.length);
    for (let i = 0; i < parsed.length; i++) {
      expect(parsed[i].id).toBe(CHART_STYLE_PRESETS[i].id);
      expect(parsed[i].name).toBe(CHART_STYLE_PRESETS[i].name);
      expect(parsed[i].palette).toBe(CHART_STYLE_PRESETS[i].palette);
      expect(parsed[i].theme.background).toBe(CHART_STYLE_PRESETS[i].theme.background);
    }
  });
});
