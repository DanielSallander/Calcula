//! FILENAME: app/extensions/Charts/rendering/chartTheme.ts
// PURPOSE: Color palettes, font settings, and spacing for chart rendering.
// CONTEXT: Provides a consistent visual theme for charts that matches the app's
//          dark UI aesthetic while making chart content itself bright and readable.

// ============================================================================
// Chart Render Theme
// ============================================================================

export interface ChartRenderTheme {
  background: string;
  plotBackground: string;
  gridLineColor: string;
  gridLineWidth: number;
  axisColor: string;
  axisLabelColor: string;
  axisTitleColor: string;
  titleColor: string;
  legendTextColor: string;
  fontFamily: string;
  titleFontSize: number;
  axisTitleFontSize: number;
  labelFontSize: number;
  legendFontSize: number;
  barBorderRadius: number;
  barGap: number;
}

export const DEFAULT_CHART_THEME: ChartRenderTheme = {
  background: "#ffffff",
  plotBackground: "#fafafa",
  gridLineColor: "#e8e8e8",
  gridLineWidth: 1,
  axisColor: "#999999",
  axisLabelColor: "#666666",
  axisTitleColor: "#444444",
  titleColor: "#333333",
  legendTextColor: "#555555",
  fontFamily: "'Segoe UI', system-ui, -apple-system, sans-serif",
  titleFontSize: 14,
  axisTitleFontSize: 11,
  labelFontSize: 10,
  legendFontSize: 10,
  barBorderRadius: 2,
  barGap: 2,
};

// ============================================================================
// Color Palettes
// ============================================================================

export const PALETTES: Record<string, string[]> = {
  default: [
    "#4E79A7", "#F28E2B", "#E15759", "#76B7B2",
    "#59A14F", "#EDC948", "#B07AA1", "#FF9DA7",
  ],
  vivid: [
    "#E64B35", "#4DBBD5", "#00A087", "#3C5488",
    "#F39B7F", "#8491B4", "#91D1C2", "#DC0000",
  ],
  pastel: [
    "#A1C9F4", "#FFB482", "#8DE5A1", "#FF9F9B",
    "#D0BBFF", "#DEBB9B", "#FAB0E4", "#CFCFCF",
  ],
  ocean: [
    "#003F5C", "#2F4B7C", "#665191", "#A05195",
    "#D45087", "#F95D6A", "#FF7C43", "#FFA600",
  ],
};

export const PALETTE_NAMES = Object.keys(PALETTES);

/**
 * Get the color for a series, using palette cycling or an override.
 */
export function getSeriesColor(
  palette: string,
  seriesIndex: number,
  override: string | null,
): string {
  if (override) return override;
  const colors = PALETTES[palette] ?? PALETTES.default;
  return colors[seriesIndex % colors.length];
}
