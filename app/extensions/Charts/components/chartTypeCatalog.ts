//! FILENAME: app/extensions/Charts/components/chartTypeCatalog.ts
// PURPOSE: The one list of built-in chart types the Chart Design band offers:
//          value, name, duotone icon key, and whether it is one of the six
//          "quick" tiles shown in the band itself.
// CONTEXT: Before the Clusters redesign the band kept two lists — MAIN_TYPES
//          with inline SVG icons painted in Office blue/orange/grey, and
//          MORE_TYPES for a native <select> — so a type added to one and not
//          the other was either iconless or unreachable. This file merges them.
//
//          Labels use Excel's vocabulary: our "bar" mark (vertical bars) is a
//          COLUMN chart and "horizontalBar" is a BAR chart. They surface as
//          tooltips and gallery captions, never as stored values, so the rename
//          costs nothing.
//
//          `icon` is a KEY into the RibbonIcon namespace rather than an element,
//          so this module stays data (no JSX, no React) and the caller picks the
//          size: 30px for a band tile, 24px for a gallery tile.

import type { RibbonIconKey } from "@api/ribbonIcons";
import type { ChartType } from "../types";

/** One built-in chart type. `icon` is `keyof typeof RibbonIcon`. */
export interface ChartTypeEntry {
  value: ChartType;
  /** Short name ("Column", "Box & Whisker") — gallery caption. */
  label: string;
  /** The duotone drawing, as a RibbonIcon key. */
  icon: RibbonIconKey;
  /** Shown as a tile in the band's Type cluster (the rest live under More). */
  quick: boolean;
}

/**
 * All 18 built-in chart types, quick tiles first in band order, then the rest
 * in the order the former "More..." list offered them.
 */
export const CHART_TYPES: readonly ChartTypeEntry[] = Object.freeze([
  { value: "bar", label: "Column", icon: "ChartColumn", quick: true },
  { value: "horizontalBar", label: "Bar", icon: "ChartBar", quick: true },
  { value: "line", label: "Line", icon: "ChartLine", quick: true },
  { value: "area", label: "Area", icon: "ChartArea", quick: true },
  { value: "pie", label: "Pie", icon: "ChartPie", quick: true },
  { value: "scatter", label: "Scatter", icon: "ChartScatter", quick: true },
  { value: "donut", label: "Donut", icon: "ChartDonut", quick: false },
  { value: "waterfall", label: "Waterfall", icon: "ChartWaterfall", quick: false },
  { value: "combo", label: "Combo", icon: "ChartCombo", quick: false },
  { value: "radar", label: "Radar", icon: "ChartRadar", quick: false },
  { value: "bubble", label: "Bubble", icon: "ChartBubble", quick: false },
  { value: "histogram", label: "Histogram", icon: "ChartHistogram", quick: false },
  { value: "funnel", label: "Funnel", icon: "ChartFunnel", quick: false },
  { value: "treemap", label: "Treemap", icon: "ChartTreemap", quick: false },
  { value: "stock", label: "Stock", icon: "ChartStock", quick: false },
  { value: "boxPlot", label: "Box & Whisker", icon: "ChartBoxPlot", quick: false },
  { value: "sunburst", label: "Sunburst", icon: "ChartSunburst", quick: false },
  { value: "pareto", label: "Pareto", icon: "ChartPareto", quick: false },
] as ChartTypeEntry[]);

/** The six band tiles, in band order. */
export const QUICK_CHART_TYPES: readonly ChartTypeEntry[] = Object.freeze(
  CHART_TYPES.filter((t) => t.quick),
);

/** The catalog entry for a mark, or undefined for a custom registered mark. */
export function chartTypeEntry(mark: string): ChartTypeEntry | undefined {
  return CHART_TYPES.find((t) => t.value === mark);
}

/** The tile's accessible name and tooltip: "Column chart". */
export function chartTypeName(entry: ChartTypeEntry): string {
  return `${entry.label} chart`;
}
