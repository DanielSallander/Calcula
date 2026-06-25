//! FILENAME: app/extensions/Charts/rendering/chartDispatch.ts
// PURPOSE: Centralized dispatch for chart painting, layout computation, and hit geometry.
// CONTEXT: Eliminates the triple duplication of switch statements across chartRenderer.ts,
//          ChartPreview.tsx, and ChartSpecEditorApp.tsx. All three now call through here.
//          Also handles layer composition for the advanced spec editor features.

import type {
  ChartSpec,
  ChartLayout,
  ParsedChartData,
  HitGeometry,
  BarRect,
  PointMarker,
  SliceArc,
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { registerChartMark, getChartMark } from "./markRegistry";

import { paintBarChart, computeLayout as computeBarLayout, computeBarRects } from "./barChartPainter";
import { paintLineChart, computeLineLayout, computeLinePointMarkers } from "./lineChartPainter";
import { paintAreaChart, computeAreaLayout, computeAreaPointMarkers } from "./areaChartPainter";
import { paintHorizontalBarChart, computeHorizontalBarLayout, computeHorizontalBarRects } from "./horizontalBarChartPainter";
import { paintPieChart, computePieLayout, computePieSliceArcs } from "./pieChartPainter";
import { paintScatterChart, computeScatterLayout, computeScatterPointMarkers } from "./scatterChartPainter";
import { paintWaterfallChart, computeWaterfallLayout, computeWaterfallBarRects } from "./waterfallChartPainter";
import { paintComboChart, computeComboLayout, computeComboHitGeometry } from "./comboChartPainter";
import { paintRadarChart, computeRadarLayout, computeRadarPointMarkers } from "./radarChartPainter";
import { paintBubbleChart, computeBubbleLayout, computeBubblePointMarkers } from "./bubbleChartPainter";
import { paintHistogramChart, computeHistogramLayout, computeHistogramBarRects } from "./histogramChartPainter";
import { paintFunnelChart, computeFunnelLayout, computeFunnelBarRects } from "./funnelChartPainter";
import { paintTreemapChart, computeTreemapLayout, computeTreemapBarRects } from "./treemapChartPainter";
import { paintStockChart, computeStockLayout, computeStockBarRects } from "./stockChartPainter";
import { paintBoxPlotChart, computeBoxPlotLayout, computeBoxPlotBarRects } from "./boxPlotChartPainter";
import { paintSunburstChart, computeSunburstLayout, computeSunburstBarRects } from "./sunburstChartPainter";
import { paintParetoChart, computeParetoLayout, computeParetoBarRects, computeParetoHitGeometry } from "./paretoChartPainter";
import { paintRule } from "./rulePainter";
import { paintTextMark } from "./textMarkPainter";
import { paintTrendlines } from "./trendlinePainter";
import { paintDataLabels } from "./dataLabelPainter";
import { paintErrorBars } from "./errorBarPainter";
import { paintDataTable, computeDataTableHeight } from "./dataTablePainter";

// ============================================================================
// Built-in Mark Registration
// ============================================================================
// The 18 built-in marks register through the same registry a third-party would
// use, so the dispatch functions below are data-driven lookups rather than
// hardcoded switch statements.

type GeomFn<T> = (data: ParsedChartData, spec: ChartSpec, layout: ChartLayout, theme: ChartRenderTheme) => T;

/** Wrap a *Rects/*Markers/*Arcs geometry function as a HitGeometry producer. */
const asBars = (fn: GeomFn<BarRect[]>): GeomFn<HitGeometry> => (d, s, l, t) => ({ type: "bars", rects: fn(d, s, l, t) });
const asPoints = (fn: GeomFn<PointMarker[]>): GeomFn<HitGeometry> => (d, s, l, t) => ({ type: "points", markers: fn(d, s, l, t) });
const asSlices = (fn: GeomFn<SliceArc[]>): GeomFn<HitGeometry> => (d, s, l, t) => ({ type: "slices", arcs: fn(d, s, l, t) });

/** Build built-in mark metadata (label + axis family). */
const meta = (label: string, layoutFamily: "cartesian" | "radial" | "other") => ({ label, layoutFamily, builtin: true as const });

registerChartMark("bar", { meta: meta("Bar Chart", "cartesian"), paint: paintBarChart, computeLayout: computeBarLayout, computeGeometry: asBars(computeBarRects) });
registerChartMark("horizontalBar", { meta: meta("Horizontal Bar Chart", "cartesian"), paint: paintHorizontalBarChart, computeLayout: computeHorizontalBarLayout, computeGeometry: asBars(computeHorizontalBarRects) });
registerChartMark("line", { meta: meta("Line Chart", "cartesian"), paint: paintLineChart, computeLayout: computeLineLayout, computeGeometry: asPoints(computeLinePointMarkers) });
registerChartMark("area", { meta: meta("Area Chart", "cartesian"), paint: paintAreaChart, computeLayout: computeAreaLayout, computeGeometry: asPoints(computeAreaPointMarkers) });
registerChartMark("scatter", { meta: meta("Scatter Plot", "cartesian"), paint: paintScatterChart, computeLayout: computeScatterLayout, computeGeometry: asPoints(computeScatterPointMarkers) });
registerChartMark("pie", { meta: meta("Pie Chart", "radial"), paint: paintPieChart, computeLayout: computePieLayout, computeGeometry: asSlices(computePieSliceArcs) });
registerChartMark("donut", { meta: meta("Donut Chart", "radial"), paint: paintPieChart, computeLayout: computePieLayout, computeGeometry: asSlices(computePieSliceArcs) });
registerChartMark("waterfall", { meta: meta("Waterfall Chart", "cartesian"), paint: paintWaterfallChart, computeLayout: computeWaterfallLayout, computeGeometry: asBars(computeWaterfallBarRects) });
registerChartMark("combo", { meta: meta("Combo Chart", "cartesian"), paint: paintComboChart, computeLayout: computeComboLayout, computeGeometry: computeComboHitGeometry });
registerChartMark("radar", { meta: meta("Radar Chart", "radial"), paint: paintRadarChart, computeLayout: computeRadarLayout, computeGeometry: asPoints(computeRadarPointMarkers) });
registerChartMark("bubble", { meta: meta("Bubble Chart", "cartesian"), paint: paintBubbleChart, computeLayout: computeBubbleLayout, computeGeometry: asPoints(computeBubblePointMarkers) });
registerChartMark("histogram", { meta: meta("Histogram", "cartesian"), paint: paintHistogramChart, computeLayout: computeHistogramLayout, computeGeometry: asBars(computeHistogramBarRects) });
registerChartMark("funnel", { meta: meta("Funnel Chart", "other"), paint: paintFunnelChart, computeLayout: computeFunnelLayout, computeGeometry: asBars(computeFunnelBarRects) });
registerChartMark("treemap", { meta: meta("Treemap", "other"), paint: paintTreemapChart, computeLayout: computeTreemapLayout, computeGeometry: asBars(computeTreemapBarRects) });
registerChartMark("stock", { meta: meta("Stock (OHLC)", "cartesian"), paint: paintStockChart, computeLayout: computeStockLayout, computeGeometry: asBars(computeStockBarRects) });
registerChartMark("boxPlot", { meta: meta("Box & Whisker", "cartesian"), paint: paintBoxPlotChart, computeLayout: computeBoxPlotLayout, computeGeometry: asBars(computeBoxPlotBarRects) });
registerChartMark("sunburst", { meta: meta("Sunburst", "radial"), paint: paintSunburstChart, computeLayout: computeSunburstLayout, computeGeometry: asBars(computeSunburstBarRects) });
registerChartMark("pareto", { meta: meta("Pareto", "cartesian"), paint: paintParetoChart, computeLayout: computeParetoLayout, computeGeometry: computeParetoHitGeometry });

// ============================================================================
// Paint Dispatch
// ============================================================================

/** Paint a chart to a canvas context, dispatching to the correct painter by mark type. */
export function dispatchPaint(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  // Paint the primary mark
  paintMark(ctx, data, spec.mark, spec, layout, theme);

  // Paint error bars (after primary mark, before data labels)
  const errorBarMarks = ["bar", "horizontalBar", "line", "scatter"];
  if (errorBarMarks.includes(spec.mark)) {
    const geometry = dispatchComputeGeometry(data, spec, layout, theme);
    if (geometry) {
      paintErrorBars(ctx, data, spec, layout, theme, geometry);
    }
  }

  // Paint data labels (after primary mark)
  if (spec.dataLabels?.enabled) {
    const geometry = dispatchComputeGeometry(data, spec, layout, theme);
    if (geometry) {
      paintDataLabels(ctx, data, spec, layout, theme, geometry);
    }
  }

  // Paint trendlines (after primary mark and data labels, before layers)
  if (spec.trendlines && spec.trendlines.length > 0) {
    paintTrendlines(ctx, data, spec, layout, theme);
  }

  // Paint layers (if any)
  if (spec.layers && spec.layers.length > 0) {
    for (const layer of spec.layers) {
      const layerData = data; // layers share parent data (for now)
      if (layer.mark === "rule") {
        paintRule(ctx, layerData, layer, spec, layout, theme);
      } else if (layer.mark === "text") {
        paintTextMark(ctx, layerData, layer, spec, layout, theme);
      } else {
        // Chart-type layer: build a temporary spec merging layer props with parent
        const layerSpec: ChartSpec = {
          ...spec,
          mark: layer.mark,
          markOptions: layer.markOptions ?? spec.markOptions,
          series: layer.series ?? spec.series,
        };
        paintMark(ctx, layerData, layer.mark, layerSpec, layout, theme);
      }
    }
  }

  // Paint data table (below the plot area, after everything else)
  if (spec.dataTable?.enabled) {
    paintDataTable(ctx, data, spec, layout, theme);
  }
}

/** Paint a single mark type (no layer iteration). No-op for an unregistered mark. */
function paintMark(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  mark: string,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  getChartMark(mark)?.paint(ctx, data, spec, layout, theme);
}

// ============================================================================
// Layout Dispatch
// ============================================================================

/** Compute layout for any chart type. */
export function dispatchComputeLayout(
  width: number,
  height: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  // Unregistered marks fall back to the bar layout (always registered).
  const def = getChartMark(spec.mark) ?? getChartMark("bar")!;
  const layout = def.computeLayout(width, height, spec, data, theme);

  // Reserve space for data table below the plot area
  const dtHeight = computeDataTableHeight(spec, data);
  if (dtHeight > 0) {
    layout.plotArea.height = Math.max(layout.plotArea.height - dtHeight, 40);
    layout.margin.bottom += dtHeight;
  }

  return layout;
}

// ============================================================================
// Hit Geometry Dispatch
// ============================================================================

/** Compute hit geometry for any chart type. Empty geometry for an unregistered mark. */
export function dispatchComputeGeometry(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): HitGeometry {
  const def = getChartMark(spec.mark);
  return def ? def.computeGeometry(data, spec, layout, theme) : { type: "bars", rects: [] };
}

// ============================================================================
// Utility
// ============================================================================

/** Extract BarRect[] from HitGeometry for backwards compat with selection highlights. */
export function extractBarRects(geometry: HitGeometry): BarRect[] {
  if (geometry.type === "bars") return geometry.rects;
  if (geometry.type === "composite") {
    for (const g of geometry.groups) {
      if (g.type === "bars") return g.rects;
    }
  }
  return [];
}
