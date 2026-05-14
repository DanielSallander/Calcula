//! FILENAME: app/extensions/Charts/lib/chartStylePresets.ts
// PURPOSE: Predefined chart style presets (Excel-like Chart Styles gallery).
// CONTEXT: Each preset defines a visual combination of palette, theme overrides,
//          and chart element visibility. Applied via updateChartSpec() as a
//          one-click style change.

import type { ChartRenderTheme } from "../rendering/chartTheme";

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
  /** Theme overrides applied to ChartRenderTheme. */
  theme: Partial<ChartRenderTheme>;
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

const colorfulStyles: ChartStylePreset[] = [
  {
    id: "colorful-1",
    name: "Classic",
    category: "colorful",
    palette: "default",
    theme: { background: "#ffffff", plotBackground: "#fafafa", gridLineColor: "#e8e8e8" },
    gridLines: true,
    barBorderRadius: 2,
  },
  {
    id: "colorful-2",
    name: "Vivid",
    category: "colorful",
    palette: "vivid",
    theme: { background: "#ffffff", plotBackground: "#fafafa", gridLineColor: "#e8e8e8" },
    gridLines: true,
    barBorderRadius: 2,
  },
  {
    id: "colorful-3",
    name: "Pastel",
    category: "colorful",
    palette: "pastel",
    theme: { background: "#ffffff", plotBackground: "#fafafa", gridLineColor: "#e0e0e0" },
    gridLines: true,
    barBorderRadius: 3,
  },
  {
    id: "colorful-4",
    name: "Ocean",
    category: "colorful",
    palette: "ocean",
    theme: { background: "#ffffff", plotBackground: "#f8f9fa", gridLineColor: "#e0e0e0" },
    gridLines: true,
    barBorderRadius: 0,
  },
  {
    id: "colorful-5",
    name: "Clean",
    category: "colorful",
    palette: "default",
    theme: { background: "#ffffff", plotBackground: "#ffffff", gridLineColor: "#f0f0f0", gridLineWidth: 1 },
    gridLines: true,
    barBorderRadius: 0,
  },
  {
    id: "colorful-6",
    name: "Minimal",
    category: "colorful",
    palette: "default",
    theme: { background: "#ffffff", plotBackground: "#ffffff", gridLineWidth: 0 },
    gridLines: false,
    barBorderRadius: 4,
  },
  {
    id: "colorful-7",
    name: "Warm",
    category: "colorful",
    palette: "vivid",
    theme: { background: "#fffdf7", plotBackground: "#fffdf7", gridLineColor: "#efe8d8" },
    gridLines: true,
    barBorderRadius: 3,
  },
  {
    id: "colorful-8",
    name: "Cool",
    category: "colorful",
    palette: "pastel",
    theme: { background: "#f7faff", plotBackground: "#f7faff", gridLineColor: "#dde6f0" },
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
    theme: {
      background: "#ffffff", plotBackground: "#f0f5fa",
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
    theme: {
      background: "#ffffff", plotBackground: "#f0faf5",
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
    theme: {
      background: "#ffffff", plotBackground: "#f5f5f5",
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
    theme: {
      background: "#ffffff", plotBackground: "#fff8f0",
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
    theme: {
      background: "#1e1e1e", plotBackground: "#252525",
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
    theme: {
      background: "#0d1b2a", plotBackground: "#1b2838",
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
    theme: {
      background: "#2d2d2d", plotBackground: "#333333",
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
    theme: {
      background: "#1a1a2e", plotBackground: "#16213e",
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
    theme: {
      background: "#ffffff", plotBackground: "#ffffff",
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
    theme: {
      background: "#ffffff", plotBackground: "#ffffff",
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
    theme: {
      background: "#ffffff", plotBackground: "#fafafa",
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
    theme: {
      background: "#f0f0f0", plotBackground: "#e8e8e8",
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
    theme: {
      background: "#ffffff",
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
    theme: {
      background: "#fff8f0",
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
    theme: {
      background: "#1a1a2e",
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
    theme: {
      background: "#f0fff0",
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
 * Apply a chart style preset to a ChartSpec.
 * Returns the partial spec updates to pass to updateChartSpec().
 */
export function applyPreset(preset: ChartStylePreset): Record<string, unknown> {
  return {
    palette: preset.palette,
    config: { theme: preset.theme },
    yAxis: undefined, // Handled separately below
  };
}

/**
 * Build the full set of spec updates for a preset, including gridline changes.
 */
export function buildPresetUpdates(
  preset: ChartStylePreset,
  currentSpec: { yAxis: { gridLines: boolean } & Record<string, unknown>; markOptions?: Record<string, unknown> },
): Record<string, unknown> {
  const updates: Record<string, unknown> = {
    palette: preset.palette,
    config: { theme: preset.theme },
    yAxis: { ...currentSpec.yAxis, gridLines: preset.gridLines },
  };

  // Apply bar border radius via theme override (already in theme)
  const themeWithRadius = { ...preset.theme, barBorderRadius: preset.barBorderRadius };
  updates.config = { theme: themeWithRadius };

  return updates;
}
