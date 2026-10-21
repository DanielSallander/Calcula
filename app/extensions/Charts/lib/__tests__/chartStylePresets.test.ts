//! FILENAME: app/extensions/Charts/lib/__tests__/chartStylePresets.test.ts
// PURPOSE: Tests for chart style preset definitions and application logic.

import { describe, it, expect, vi, afterEach } from "vitest";

// The BUG-0489 repro below drives the REAL chart store, which reaches these.
vi.mock("@api/dialogs", () => ({ alertAsync: vi.fn(() => Promise.resolve()) }));
vi.mock("@api/gridOverlays", () => ({
  removeGridRegionsByType: vi.fn(),
  addGridRegions: vi.fn(),
}));
vi.mock("@api/events", () => ({
  AppEvents: { GRID_REFRESH: "app:grid-refresh", MUTATION_REFRESH: "app:mutation-refresh" },
  emitAppEvent: vi.fn(),
}));

import {
  CHART_STYLE_PRESETS,
  PRESET_THEME_KEYS,
  getPresetById,
  getPresetsByCategory,
  getPresetColors,
  applyPreset,
  buildPresetUpdates,
  presetContainerPatch,
  presetThemePatch,
  specHasPresetBackground,
  type ChartStylePreset,
} from "../chartStylePresets";
import { getChartById, loadChartsFromBackend, resetChartStore, updateChartSpec } from "../chartStore";
import { chartsBackend } from "../chartsBackend";
import { resolveChartTheme, DEFAULT_CHART_THEME } from "../../rendering/chartTheme";
import type { ChartSpec } from "../../types";

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

  it("every preset has a background colour, and it is the CONTAINER's, never a theme key", () => {
    // D-FORMAT: the chart's outer background moved from theme.background to
    // container.background.color -- one spelling for the fact.
    for (const preset of CHART_STYLE_PRESETS) {
      expect(preset.background).toMatch(/^#[0-9a-fA-F]{3,8}$/);
      expect("background" in preset.theme).toBe(false);
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
    expect((updates.config as any).theme.background).toBeUndefined();
    // The background rides the container, merged (padding, border ... stay).
    // A preset is a SOLID background commit (round 2, G1): it shows the
    // background and clears a gradient -- `undefined`, the deep-merge spelling
    // of "clear" (a `null` would be stored).
    expect(updates.container).toEqual({ background: { color: "#ffffff", show: true, gradient: undefined } });
    expect("gradient" in (updates.container as { background: object }).background).toBe(true);
    expect(updates.container).toEqual(presetContainerPatch(preset));
  });

  it("the gallery's current ring compares the CONTAINER background (white when unset)", () => {
    const white = getPresetById("colorful-1")!;
    const dark = getPresetById("dark-1")!;
    expect(specHasPresetBackground({}, white)).toBe(true);
    expect(specHasPresetBackground({ container: { background: { color: "#1E1E1E" } } }, dark)).toBe(true);
    expect(specHasPresetBackground({ container: { background: { color: "#1e1e1e" } } }, white)).toBe(false);
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
      const bg = preset.background;
      // Dark backgrounds should have low luminance (first hex byte < 0x40)
      const r = parseInt(bg.slice(1, 3), 16);
      expect(r).toBeLessThan(64);
    }
  });
});

// ============================================================================
// Transparent plot area (Power BI) -- which presets keep a tinted plot
// ============================================================================

describe("preset plot fill", () => {
  const TRANSPARENT_PLOT = [
    "colorful-1", "colorful-2", "colorful-3", "colorful-4",
    "colorful-5", "colorful-6", "colorful-7", "colorful-8",
    "outline-1", "outline-2", "outline-3",
  ];

  it("the colorful and light outline presets set NO plot fill, so the visual's background shows", () => {
    for (const id of TRANSPARENT_PLOT) {
      const preset = getPresetById(id)!;
      expect(preset, id).toBeDefined();
      expect("plotBackground" in preset.theme, id).toBe(false);
      expect(resolveChartTheme({ theme: presetThemePatch(preset) }).plotBackground, id).toBe("");
    }
  });

  it("mono, dark, outline-4 and gradient presets keep their deliberately tinted plot", () => {
    for (const preset of CHART_STYLE_PRESETS) {
      if (TRANSPARENT_PLOT.includes(preset.id)) continue;
      expect(preset.theme.plotBackground, preset.id).toMatch(/^#[0-9a-fA-F]{3,8}$/);
      expect(preset.theme.plotBackground!.toLowerCase(), preset.id).not.toBe(preset.background.toLowerCase());
    }
  });
});

// ============================================================================
// BUG-0489 -- a preset must not inherit the previous preset's theme keys
// ============================================================================

describe("BUG-0489: applying a preset resets the theme keys it does not set", () => {
  it("PRESET_THEME_KEYS lists every theme key any preset sets", () => {
    for (const preset of CHART_STYLE_PRESETS) {
      for (const key of Object.keys(preset.theme)) {
        expect(PRESET_THEME_KEYS, `${preset.id}.${key}`).toContain(key);
      }
    }
    expect(PRESET_THEME_KEYS).toContain("plotBackground");
    expect(PRESET_THEME_KEYS).toContain("plotBackgroundGradient");
    expect(PRESET_THEME_KEYS).toContain("barBorderRadius");
  });

  it("the theme patch carries every key, unset ones as an explicit undefined", () => {
    const patch = presetThemePatch(getPresetById("colorful-1")!) as Record<string, unknown>;
    for (const key of PRESET_THEME_KEYS) expect(key in patch, key).toBe(true);
    expect(patch.axisColor).toBeUndefined();
    expect(patch.titleColor).toBeUndefined();
    expect(patch.plotBackground).toBeUndefined();
    expect(patch.gridLineColor).toBe("#e8e8e8");
    expect(patch.barBorderRadius).toBe(2);
  });

  it("applyPreset and buildPresetUpdates send the same palette, theme and container", () => {
    const preset = getPresetById("mono-blue")!;
    const built = buildPresetUpdates(preset, {
      yAxis: { gridLines: false } as ChartSpec["yAxis"],
    });
    const applied = applyPreset(preset);
    expect(applied.palette).toBe(built.palette);
    expect(applied.config).toEqual(built.config);
    expect(applied.container).toEqual(built.container);
    // applyPreset needs no current axis and must never clear it.
    expect("yAxis" in applied).toBe(false);
  });

  describe("through the real chart store", () => {
    const ID = "chart-0489";
    const invokeBackend = vi.fn();

    function seedSpec(): ChartSpec {
      return {
        mark: "bar",
        data: "Sheet1!A1:C4",
        hasHeaders: true,
        seriesOrientation: "columns",
        categoryIndex: 0,
        series: [{ name: "Revenue", sourceIndex: 1, color: null }],
        title: "t",
        xAxis: {},
        yAxis: { gridLines: true },
        legend: { visible: true, position: "right" },
        palette: "default",
      } as unknown as ChartSpec;
    }

    async function seed(): Promise<void> {
      resetChartStore();
      invokeBackend.mockReset();
      invokeBackend.mockImplementation(async (command: string) => {
        if (command === "get_charts") {
          return [{
            id: ID,
            sheetIndex: 0,
            specJson: JSON.stringify({ chartId: ID, name: ID, sheetIndex: 0, x: 0, y: 0, width: 400, height: 300, spec: seedSpec() }),
          }];
        }
        return undefined;
      });
      chartsBackend.set(invokeBackend);
      await loadChartsFromBackend();
      invokeBackend.mockClear();
    }

    function applyThroughStore(presetId: string): void {
      const chart = getChartById(ID)!;
      updateChartSpec(ID, buildPresetUpdates(getPresetById(presetId)!, chart.spec) as Partial<ChartSpec>);
    }

    afterEach(() => resetChartStore());

    it("mono-blue then colorful-1 leaves no blue axis or title (in memory, painted, and after JSON)", async () => {
      await seed();
      applyThroughStore("mono-blue");
      expect(getChartById(ID)!.spec.config?.theme?.axisColor).toBe("#4E79A7");
      expect(getChartById(ID)!.spec.config?.theme?.titleColor).toBe("#2c4a6e");

      applyThroughStore("colorful-1");
      const spec = getChartById(ID)!.spec;
      expect(spec.config?.theme?.axisColor).toBeUndefined();
      expect(spec.config?.theme?.titleColor).toBeUndefined();
      expect(spec.config?.theme?.plotBackground).toBeUndefined();

      // What the painter reads, before any JSON round trip: the defaults.
      const painted = resolveChartTheme(spec.config);
      expect(painted.axisColor).toBe(DEFAULT_CHART_THEME.axisColor);
      expect(painted.titleColor).toBe(DEFAULT_CHART_THEME.titleColor);
      expect(painted.plotBackground).toBe("");

      // What is saved: JSON drops the reset keys entirely.
      const saved = JSON.parse(JSON.stringify(spec)) as ChartSpec;
      const theme = (saved.config?.theme ?? {}) as Record<string, unknown>;
      expect("axisColor" in theme).toBe(false);
      expect("titleColor" in theme).toBe(false);
      expect("plotBackground" in theme).toBe(false);
      expect(theme.gridLineColor).toBe("#e8e8e8");
    });

    it("a preset over a stored container gradient (background switched off) paints its solid colour", async () => {
      await seed();
      updateChartSpec(ID, {
        container: {
          background: {
            show: false,
            gradient: { type: "linear", stops: [{ offset: 0, color: "#ff0000" }, { offset: 1, color: "#0000ff" }] },
          },
        },
      } as Partial<ChartSpec>);
      expect(getChartById(ID)!.spec.container?.background?.gradient).toBeDefined();

      applyThroughStore("dark-1");
      const saved = JSON.parse(JSON.stringify(getChartById(ID)!.spec)) as ChartSpec;
      const background = (saved.container?.background ?? {}) as Record<string, unknown>;
      expect("gradient" in background).toBe(false);
      expect(background.show).toBe(true);
      expect(background.color).toBe(getPresetById("dark-1")!.background);
    });
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
      expect(parsed[i].background).toBe(CHART_STYLE_PRESETS[i].background);
    }
  });
});
