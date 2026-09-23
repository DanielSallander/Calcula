//! FILENAME: app/extensions/Sparklines/lib/sparklineColors.ts
// PURPOSE: The sparkline extension's categorical colour DATA: the eight Style
//          presets of the Sparkline tab and the colour list its pickers offer.
// CONTEXT: These are colours a user CHOOSES for their sparklines, not chrome, so
//          they stay literal — and they live here, in a data module, because the
//          components that render them (SparklineDesignSections.tsx,
//          SparklineColorPicker.tsx) sit under the redesigned-chrome hex ban in
//          app/eslint.boundaries.js. Every element that paints one of these
//          carries `data-colour-data` (the @api/layout PaletteStrip bars and
//          ColorPopover swatches do so themselves), which is what
//          findHardcodedColours skips in the tests.

// ============================================================================
// Style presets
// ============================================================================

/** One entry of the Sparkline tab's Style strip. */
export interface SparklineStylePreset {
  /** Stable id: the PaletteStrip radio value and test-id suffix. */
  id: string;
  /** Accessible name and tooltip ("Style 1" ... "Style 8"). */
  name: string;
  /** Line colour, or the positive bar colour for column / win-loss. */
  color: string;
  /** Negative bar colour. */
  negativeColor: string;
  /** Marker colour. */
  markerColor: string;
}

/** Excel's eight single-accent sparkline styles, in gallery order. */
export const SPARKLINE_STYLE_PRESETS: readonly SparklineStylePreset[] = Object.freeze([
  { id: "style-1", name: "Style 1", color: "#4472C4", negativeColor: "#D94735", markerColor: "#4472C4" },
  { id: "style-2", name: "Style 2", color: "#ED7D31", negativeColor: "#D94735", markerColor: "#ED7D31" },
  { id: "style-3", name: "Style 3", color: "#A5A5A5", negativeColor: "#D94735", markerColor: "#A5A5A5" },
  { id: "style-4", name: "Style 4", color: "#FFC000", negativeColor: "#D94735", markerColor: "#FFC000" },
  { id: "style-5", name: "Style 5", color: "#5B9BD5", negativeColor: "#D94735", markerColor: "#5B9BD5" },
  { id: "style-6", name: "Style 6", color: "#70AD47", negativeColor: "#D94735", markerColor: "#70AD47" },
  { id: "style-7", name: "Style 7", color: "#264478", negativeColor: "#D94735", markerColor: "#264478" },
  { id: "style-8", name: "Style 8", color: "#636363", negativeColor: "#D94735", markerColor: "#636363" },
]);

/**
 * A preset's colours in role order (line/bar, marker, negative) — what its
 * PaletteStrip button shows as bars.
 */
export function presetColors(preset: SparklineStylePreset): string[] {
  return [preset.color, preset.markerColor, preset.negativeColor];
}

// ============================================================================
// Picker colours
// ============================================================================

/**
 * The sixty colours the sparkline colour pickers offer (twelve hue families
 * in five shades each, dark to light). The @api ColorPopover lays fixed
 * colours out ten to a row, so the list is ORDERED for a ten-wide grid: rows
 * one to five are the grey, blue, purple, violet, red, orange, amber, lime,
 * green and sky families shade by shade, so each column is one hue; row six
 * holds the two remaining dark-blue families as two five-step ramps. The SET
 * is exactly the one the old hand-rolled twelve-wide picker offered.
 */
export const SPARKLINE_PICKER_COLORS: readonly string[] = Object.freeze([
  // Shade 1 (darkest)
  "#000000", "#0f3460", "#533483", "#7c3aed", "#dc2626",
  "#ea580c", "#d97706", "#65a30d", "#059669", "#0284c7",
  // Shade 2
  "#404040", "#3f6fa0", "#7354a3", "#9d6dfd", "#ef4444",
  "#f97316", "#eab308", "#84cc16", "#10b981", "#38bdf8",
  // Shade 3
  "#808080", "#6f9fd0", "#9374c3", "#bd8dff", "#f87171",
  "#fb923c", "#facc15", "#a3e635", "#34d399", "#7dd3fc",
  // Shade 4
  "#bfbfbf", "#9fcff0", "#b394e3", "#ddbdff", "#fca5a5",
  "#fdba74", "#fde047", "#bef264", "#6ee7b7", "#bae6fd",
  // Shade 5 (lightest)
  "#ffffff", "#d0efff", "#e0d0ff", "#f0e0ff", "#fee2e2",
  "#fed7aa", "#fef08a", "#d9f99d", "#a7f3d0", "#e0f2fe",
  // The two dark-blue families, darkest to lightest
  "#1a1a2e", "#4a4a6a", "#8a8aaa", "#babade", "#e0e0f0",
  "#16213e", "#3a5a8e", "#6a8abe", "#9abaee", "#d0e0ff",
]);
