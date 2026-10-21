//! FILENAME: app/extensions/Charts/rendering/chartTheme.ts
// PURPOSE: Color palettes, font settings, and spacing for chart rendering.
// CONTEXT: Provides a consistent visual theme for charts that matches the app's
//          dark UI aesthetic while making chart content itself bright and readable.

// ============================================================================
// Chart Render Theme
// ============================================================================

import type { GradientFill } from "../types";
import type { ResolvedVisualContainer, VisualLineStyle, VisualTextAlign } from "@api/visualContainer";

/** The style of one line block of chart title text (the colour and size live beside it). */
export interface ChartTitleTextStyle {
  fontFamily: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  /** A band painted behind the text; "" = none. */
  background: string;
  align: VisualTextAlign;
  wrap: boolean;
}

/**
 * How the chart paints its title block (D-FORMAT): the title's style beyond its
 * colour and size (which stay `titleColor` / `titleFontSize`, the chart's one
 * spelling), the subtitle, the divider under them and the spacing. Derived from
 * the RESOLVED visual container (`resolveChartTheme(config, container)`); a
 * theme without it paints the historical title -- 600 weight, centred, one line.
 */
export interface ChartTitleStyle {
  /** The title line(s) are painted (the text is `spec.title`). */
  show: boolean;
  title: ChartTitleTextStyle;
  subtitle: ChartTitleTextStyle & { show: boolean; text: string; color: string; fontSize: number };
  divider: { show: boolean; color: string; style: VisualLineStyle; width: number; ignorePadding: boolean };
  spacing: { belowTitle: number; belowSubtitle: number; belowDivider: number };
}

export interface ChartRenderTheme {
  /**
   * DERIVED: the resolved container background colour (default #ffffff). The
   * chart never paints it -- Core paints the container under the raster -- but
   * contrast logic (data labels, cues) reads what the chart sits on.
   */
  background: string;
  plotBackground: string;
  /** Gradient fill for plot area background (overrides plotBackground when set). */
  plotBackgroundGradient?: GradientFill;
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
  /** The title block's style; absent = the historical title (see ChartTitleStyle). */
  titleStyle?: ChartTitleStyle;
}

export const DEFAULT_CHART_THEME: ChartRenderTheme = {
  background: "#ffffff",
  // Power BI: the plot area paints nothing by default; the visual container's
  // background is what shows. "" = no fill (the same spelling as a container
  // colour ""); every plot fill goes through fillPlotShape (chartPainterUtils).
  plotBackground: "",
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

/**
 * Merge user-supplied theme overrides with the default theme.
 * Only specified fields override defaults.
 */
export function mergeTheme(
  base: ChartRenderTheme,
  overrides: Partial<ChartRenderTheme> | undefined,
): ChartRenderTheme {
  if (!overrides) return base;
  // An override key whose value is `undefined` means "back to the base" --
  // never "this key is now undefined". A chart style preset resets the keys
  // the previous preset set by writing them as explicit `undefined` through
  // `deepMergeSpec` (BUG-0489), and the Format pane's Clear does the same;
  // the in-memory spec carries those keys until its next JSON round trip, so a
  // plain spread would hand painters `axisColor: undefined` until a reload.
  const result: ChartRenderTheme = { ...base };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) (result as unknown as Record<string, unknown>)[key] = value;
  }
  return result;
}

/**
 * The chart's title block style from a RESOLVED container: everything of
 * `container.title` except its text, colour and size (the chart spells those
 * `spec.title` / `theme.titleColor` / `theme.titleFontSize`, already overlaid
 * by WP-D on the spec the painter reads), plus the subtitle, divider and
 * spacing.
 */
export function chartTitleStyleOf(container: ResolvedVisualContainer): ChartTitleStyle {
  const t = container.title;
  const s = container.subtitle;
  return {
    show: t.show,
    title: {
      fontFamily: t.fontFamily,
      bold: t.bold,
      italic: t.italic,
      underline: t.underline,
      background: t.background,
      align: t.align,
      wrap: t.wrap,
    },
    subtitle: {
      show: s.show && s.text.trim() !== "",
      text: s.text,
      color: s.color,
      fontSize: s.fontSize,
      fontFamily: s.fontFamily,
      bold: s.bold,
      italic: s.italic,
      underline: s.underline,
      background: s.background,
      align: s.align,
      wrap: s.wrap,
    },
    divider: {
      show: container.divider.show,
      color: container.divider.color,
      style: container.divider.style,
      width: container.divider.width,
      ignorePadding: container.divider.ignorePadding,
    },
    spacing: { ...container.spacing },
  };
}

/** Theme keys that are no longer theme fields (moved to the container) and never override. */
const NOT_THEME_KEYS = ["background", "backgroundGradient"] as const;

/**
 * Resolve the effective theme for a chart spec.
 * Merges spec.config.theme overrides with DEFAULT_CHART_THEME.
 *
 * `container` (the chart's RESOLVED visual container) supplies the derived
 * `background` (its colour while shown, else #ffffff) and the title block's
 * style. Without one the theme carries the default background and no
 * `titleStyle` (the historical title). A legacy `background` /
 * `backgroundGradient` key in `config.theme` is ignored: the outer background
 * is the container's, one spelling.
 */
export function resolveChartTheme(
  config: { theme?: Partial<ChartRenderTheme> } | undefined,
  container?: ResolvedVisualContainer | null,
): ChartRenderTheme {
  let overrides = config?.theme;
  if (overrides && NOT_THEME_KEYS.some((k) => k in overrides!)) {
    const copy: Record<string, unknown> = { ...overrides };
    for (const k of NOT_THEME_KEYS) delete copy[k];
    overrides = copy as Partial<ChartRenderTheme>;
  }
  const theme = mergeTheme(DEFAULT_CHART_THEME, overrides);
  if (!container) return theme;
  return {
    ...theme,
    background: container.background.show && container.background.color ? container.background.color : DEFAULT_CHART_THEME.background,
    titleStyle: chartTitleStyleOf(container),
  };
}

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
