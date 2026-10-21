//! FILENAME: app/extensions/Charts/lib/chartStylePresets.ts
// PURPOSE: Predefined chart style presets (Excel-like Chart Styles gallery).
// CONTEXT: Each preset defines a visual combination of palette, theme overrides,
//          and chart element visibility. Applied via updateChartSpec() as a
//          one-click style change.

import type { ChartRenderTheme } from "../rendering/chartTheme";
import type { AxisSpec, ChartContainerFormat } from "../types";
import { solidBackgroundPatch, type VisualContainerPatch } from "@api/visualContainer";

// ============================================================================
// Preset Type
// ============================================================================

export interface ChartStylePreset {
  /** Unique preset ID. */
  id: string;
  /** Display name. */
  name: string;
  /** Category for grouping in the gallery. */
  category: "colorful" | "monochromatic" | "dark" | "outline" | "gradient";
  /** Color palette name. */
  palette: string;
  /**
   * The chart's outer background colour. It is the visual CONTAINER's
   * (`spec.container.background.color`, D-FORMAT), never a theme key -- one
   * spelling for the fact, which Core paints under the chart.
   */
  background: string;
  /** Theme overrides applied to ChartRenderTheme (never the derived background). */
  theme: Partial<Omit<ChartRenderTheme, "background" | "titleStyle">>;
  /** Whether gridlines should be visible. */
  gridLines: boolean;
  /** Bar border radius. */
  barBorderRadius: number;
}

// ============================================================================
// Helper: Preset colors for thumbnails
// ============================================================================

/** Get the first 4 colors of a preset for thumbnail rendering. */
export function getPresetColors(preset: ChartStylePreset): string[] {
  const palettes: Record<string, string[]> = {
    default: ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2"],
    vivid: ["#E64B35", "#4DBBD5", "#00A087", "#3C5488"],
    pastel: ["#A1C9F4", "#FFB482", "#8DE5A1", "#FF9F9B"],
    ocean: ["#003F5C", "#2F4B7C", "#665191", "#A05195"],
  };
  return palettes[preset.palette] ?? palettes.default;
}

// ============================================================================
// Colorful Styles (multi-hue palettes, light backgrounds)
// ============================================================================
//
// The colorful and the light outline styles set NO plot fill: the plot area is
// transparent (Power BI), so the visual's background -- the container colour,
// the Format pane's Background row -- recolours the whole visual. Mono, dark,
// "Gray Background" and gradient styles keep a deliberately tinted plot.

const colorfulStyles: ChartStylePreset[] = [
  {
    id: "colorful-1",
    name: "Classic",
    category: "colorful",
    palette: "default",
    background: "#ffffff",
    theme: { gridLineColor: "#e8e8e8" },
    gridLines: true,
    barBorderRadius: 2,
  },
  {
    id: "colorful-2",
    name: "Vivid",
    category: "colorful",
    palette: "vivid",
    background: "#ffffff",
    theme: { gridLineColor: "#e8e8e8" },
    gridLines: true,
    barBorderRadius: 2,
  },
  {
    id: "colorful-3",
    name: "Pastel",
    category: "colorful",
    palette: "pastel",
    background: "#ffffff",
    theme: { gridLineColor: "#e0e0e0" },
    gridLines: true,
    barBorderRadius: 3,
  },
  {
    id: "colorful-4",
    name: "Ocean",
    category: "colorful",
    palette: "ocean",
    background: "#ffffff",
    theme: { gridLineColor: "#e0e0e0" },
    gridLines: true,
    barBorderRadius: 0,
  },
  {
    id: "colorful-5",
    name: "Clean",
    category: "colorful",
    palette: "default",
    background: "#ffffff",
    theme: { gridLineColor: "#f0f0f0", gridLineWidth: 1 },
    gridLines: true,
    barBorderRadius: 0,
  },
  {
    id: "colorful-6",
    name: "Minimal",
    category: "colorful",
    palette: "default",
    background: "#ffffff",
    theme: { gridLineWidth: 0 },
    gridLines: false,
    barBorderRadius: 4,
  },
  {
    id: "colorful-7",
    name: "Warm",
    category: "colorful",
    palette: "vivid",
    background: "#fffdf7",
    theme: { gridLineColor: "#efe8d8" },
    gridLines: true,
    barBorderRadius: 3,
  },
  {
    id: "colorful-8",
    name: "Cool",
    category: "colorful",
    palette: "pastel",
    background: "#f7faff",
    theme: { gridLineColor: "#dde6f0" },
    gridLines: true,
    barBorderRadius: 3,
  },
];

// ============================================================================
// Monochromatic Styles (single-hue variants)
// ============================================================================

const monochromaticStyles: ChartStylePreset[] = [
  {
    id: "mono-blue",
    name: "Blue",
    category: "monochromatic",
    palette: "default",
    background: "#ffffff",
    theme: {
      plotBackground: "#f0f5fa",
      gridLineColor: "#d0dce8", axisColor: "#4E79A7",
      titleColor: "#2c4a6e",
    },
    gridLines: true,
    barBorderRadius: 2,
  },
  {
    id: "mono-green",
    name: "Green",
    category: "monochromatic",
    palette: "default",
    background: "#ffffff",
    theme: {
      plotBackground: "#f0faf5",
      gridLineColor: "#c8e6d8", axisColor: "#59A14F",
      titleColor: "#2d6a3f",
    },
    gridLines: true,
    barBorderRadius: 2,
  },
  {
    id: "mono-gray",
    name: "Gray",
    category: "monochromatic",
    palette: "default",
    background: "#ffffff",
    theme: {
      plotBackground: "#f5f5f5",
      gridLineColor: "#ddd", axisColor: "#888",
      titleColor: "#444",
    },
    gridLines: true,
    barBorderRadius: 0,
  },
  {
    id: "mono-orange",
    name: "Orange",
    category: "monochromatic",
    palette: "vivid",
    background: "#ffffff",
    theme: {
      plotBackground: "#fff8f0",
      gridLineColor: "#f0dcc8", axisColor: "#d47520",
      titleColor: "#8b4c10",
    },
    gridLines: true,
    barBorderRadius: 2,
  },
];

// ============================================================================
// Dark Styles (dark backgrounds)
// ============================================================================

const darkStyles: ChartStylePreset[] = [
  {
    id: "dark-1",
    name: "Dark",
    category: "dark",
    palette: "vivid",
    background: "#1e1e1e",
    theme: {
      plotBackground: "#252525",
      gridLineColor: "#3a3a3a", gridLineWidth: 1,
      axisColor: "#666", axisLabelColor: "#aaa",
      axisTitleColor: "#ccc", titleColor: "#e0e0e0",
      legendTextColor: "#bbb",
    },
    gridLines: true,
    barBorderRadius: 2,
  },
  {
    id: "dark-2",
    name: "Midnight",
    category: "dark",
    palette: "pastel",
    background: "#0d1b2a",
    theme: {
      plotBackground: "#1b2838",
      gridLineColor: "#2a3a4a", gridLineWidth: 1,
      axisColor: "#4a5a6a", axisLabelColor: "#8a9aaa",
      axisTitleColor: "#aabbcc", titleColor: "#d0e0f0",
      legendTextColor: "#99aabb",
    },
    gridLines: true,
    barBorderRadius: 3,
  },
  {
    id: "dark-3",
    name: "Charcoal",
    category: "dark",
    palette: "default",
    background: "#2d2d2d",
    theme: {
      plotBackground: "#333333",
      gridLineColor: "#444", gridLineWidth: 1,
      axisColor: "#777", axisLabelColor: "#aaa",
      axisTitleColor: "#ccc", titleColor: "#eee",
      legendTextColor: "#bbb",
    },
    gridLines: true,
    barBorderRadius: 0,
  },
  {
    id: "dark-4",
    name: "Dark Clean",
    category: "dark",
    palette: "vivid",
    background: "#1a1a2e",
    theme: {
      plotBackground: "#16213e",
      gridLineWidth: 0,
      axisColor: "#555", axisLabelColor: "#8899aa",
      axisTitleColor: "#aabbcc", titleColor: "#ddeeff",
      legendTextColor: "#99aacc",
    },
    gridLines: false,
    barBorderRadius: 4,
  },
];

// ============================================================================
// Outline / Flat Styles
// ============================================================================

const outlineStyles: ChartStylePreset[] = [
  {
    id: "outline-1",
    name: "Flat",
    category: "outline",
    palette: "default",
    background: "#ffffff",
    theme: {
      gridLineWidth: 0, axisColor: "#ccc",
    },
    gridLines: false,
    barBorderRadius: 0,
  },
  {
    id: "outline-2",
    name: "Rounded",
    category: "outline",
    palette: "pastel",
    background: "#ffffff",
    theme: {
      gridLineColor: "#f0f0f0", gridLineWidth: 1,
      axisColor: "#ddd",
    },
    gridLines: true,
    barBorderRadius: 6,
  },
  {
    id: "outline-3",
    name: "Bold Grid",
    category: "outline",
    palette: "vivid",
    background: "#ffffff",
    theme: {
      gridLineColor: "#ccc", gridLineWidth: 2,
      axisColor: "#999",
    },
    gridLines: true,
    barBorderRadius: 0,
  },
  {
    id: "outline-4",
    name: "Gray Background",
    category: "outline",
    palette: "default",
    background: "#f0f0f0",
    theme: {
      plotBackground: "#e8e8e8",
      gridLineColor: "#d0d0d0", gridLineWidth: 1,
      axisColor: "#999",
    },
    gridLines: true,
    barBorderRadius: 2,
  },
];

// ============================================================================
// Gradient Styles (background gradients)
// ============================================================================

const gradientStyles: ChartStylePreset[] = [
  {
    id: "gradient-1",
    name: "Sky",
    category: "gradient",
    palette: "default",
    background: "#ffffff",
    theme: {
      plotBackground: "#f0f5ff",
      plotBackgroundGradient: {
        type: "linear",
        direction: "topToBottom",
        stops: [
          { offset: 0, color: "#e8f0fe" },
          { offset: 1, color: "#f8faff" },
        ],
      },
    },
    gridLines: true,
    barBorderRadius: 2,
  },
  {
    id: "gradient-2",
    name: "Sunset",
    category: "gradient",
    palette: "vivid",
    background: "#fff8f0",
    theme: {
      plotBackground: "#fff5e8",
      plotBackgroundGradient: {
        type: "linear",
        direction: "topToBottom",
        stops: [
          { offset: 0, color: "#fff0e0" },
          { offset: 1, color: "#fffaf5" },
        ],
      },
    },
    gridLines: true,
    barBorderRadius: 3,
  },
  {
    id: "gradient-3",
    name: "Dark Gradient",
    category: "gradient",
    palette: "vivid",
    background: "#1a1a2e",
    theme: {
      plotBackground: "#16213e",
      plotBackgroundGradient: {
        type: "linear",
        direction: "topToBottom",
        stops: [
          { offset: 0, color: "#1a1a2e" },
          { offset: 1, color: "#0f3460" },
        ],
      },
      gridLineColor: "#2a3a5a", gridLineWidth: 1,
      axisColor: "#556", axisLabelColor: "#8899bb",
      axisTitleColor: "#aabbdd", titleColor: "#ddeeff",
      legendTextColor: "#99bbdd",
    },
    gridLines: true,
    barBorderRadius: 2,
  },
  {
    id: "gradient-4",
    name: "Mint",
    category: "gradient",
    palette: "pastel",
    background: "#f0fff0",
    theme: {
      plotBackground: "#e8fae8",
      plotBackgroundGradient: {
        type: "linear",
        direction: "topToBottom",
        stops: [
          { offset: 0, color: "#e0f5e0" },
          { offset: 1, color: "#f5fff5" },
        ],
      },
    },
    gridLines: true,
    barBorderRadius: 4,
  },
];

// ============================================================================
// All Presets
// ============================================================================

export const CHART_STYLE_PRESETS: ChartStylePreset[] = [
  ...colorfulStyles,
  ...monochromaticStyles,
  ...darkStyles,
  ...outlineStyles,
  ...gradientStyles,
];

/**
 * Find a preset by ID.
 */
export function getPresetById(id: string): ChartStylePreset | undefined {
  return CHART_STYLE_PRESETS.find((p) => p.id === id);
}

/**
 * Get presets grouped by category.
 */
export function getPresetsByCategory(): Record<string, ChartStylePreset[]> {
  const grouped: Record<string, ChartStylePreset[]> = {};
  for (const preset of CHART_STYLE_PRESETS) {
    if (!grouped[preset.category]) grouped[preset.category] = [];
    grouped[preset.category].push(preset);
  }
  return grouped;
}

/**
 * Every theme key a preset can set (the union over CHART_STYLE_PRESETS, plus the
 * plot fill pair and the bar radius every preset writes). A preset patch sends
 * ALL of them -- the keys the new preset leaves at the default as an explicit
 * `undefined` -- because `config.theme` is deep-merged (chartStore
 * `deepMergeSpec`): without the reset, the previous preset's keys survive
 * (BUG-0489: mono-blue then colorful-1 kept the blue axis and title). The
 * test pins that every preset's keys are listed here.
 */
export const PRESET_THEME_KEYS: ReadonlyArray<keyof ChartRenderTheme> = [
  "plotBackground",
  "plotBackgroundGradient",
  "gridLineColor",
  "gridLineWidth",
  "axisColor",
  "axisLabelColor",
  "axisTitleColor",
  "titleColor",
  "legendTextColor",
  "barBorderRadius",
];

/**
 * The `config.theme` patch a preset writes: every PRESET_THEME_KEYS key, the
 * ones the preset does not set as `undefined` (deepMergeSpec assigns it, so
 * the key falls back to the default; JSON drops it on save).
 */
export function presetThemePatch(preset: ChartStylePreset): Partial<ChartRenderTheme> {
  const set: Record<string, unknown> = { ...preset.theme, barBorderRadius: preset.barBorderRadius };
  const patch: Record<string, unknown> = {};
  for (const key of PRESET_THEME_KEYS) patch[key] = set[key];
  // A key a preset sets that the list forgot still travels (never silently dropped).
  for (const [key, value] of Object.entries(set)) if (!(key in patch)) patch[key] = value;
  return patch as Partial<ChartRenderTheme>;
}

/** The palette / theme / container updates of a preset (the part that needs no current spec). */
function presetBaseUpdates(preset: ChartStylePreset): Record<string, unknown> {
  return {
    palette: preset.palette,
    config: { theme: presetThemePatch(preset) },
    // The background is the container's (merged: padding, border ... stay).
    container: presetContainerPatch(preset),
  };
}

/**
 * Apply a chart style preset to a ChartSpec.
 * Returns the partial spec updates to pass to updateChartSpec(). The same
 * builder as buildPresetUpdates, without the gridline change (which needs the
 * current Y axis), so the two cannot drift.
 */
export function applyPreset(preset: ChartStylePreset): Record<string, unknown> {
  return presetBaseUpdates(preset);
}

/**
 * A container patch in the form `deepMergeSpec` (chartStore) understands: there
 * `undefined` CLEARS a key and `null` would be STORED as a value, so the
 * solid-background rule's one `gradient: null` leaf travels as `undefined`.
 */
function forDeepMerge(patch: VisualContainerPatch): ChartContainerFormat {
  const background: Record<string, unknown> = { ...(patch.background ?? {}) };
  if (background.gradient === null) background.gradient = undefined;
  return { ...patch, background } as ChartContainerFormat;
}

/**
 * The container patch a preset writes: a SOLID background in the preset's
 * colour (a merge: padding, border, title ... stay). Applying a preset is a
 * solid background commit (round 2, G1): it clears a stored gradient and
 * switches the background on, by the one rule in @api `solidBackgroundPatch`
 * (unconditional form -- a preset always paints its colour).
 */
export function presetContainerPatch(preset: ChartStylePreset): ChartContainerFormat {
  return forDeepMerge(solidBackgroundPatch(preset.background));
}

/** Whether `spec` already shows this preset's background (the gallery's "current" ring). */
export function specHasPresetBackground(
  spec: { container?: ChartContainerFormat },
  preset: ChartStylePreset,
): boolean {
  const current = spec.container?.background?.color;
  const shown = current === undefined || current === "" ? "#ffffff" : current;
  return shown.toLowerCase() === preset.background.toLowerCase();
}

/**
 * Build the full set of spec updates for a preset, including gridline changes.
 */
export function buildPresetUpdates(
  preset: ChartStylePreset,
  currentSpec: { yAxis: AxisSpec; markOptions?: unknown },
): Record<string, unknown> {
  return {
    ...presetBaseUpdates(preset),
    yAxis: { ...currentSpec.yAxis, gridLines: preset.gridLines },
  };
}
