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
} from "../types";
import type { ChartRenderTheme } from "./chartTheme";

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

/** Paint a single mark type (no layer iteration). */
function paintMark(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  mark: string,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  switch (mark) {
    case "bar":
      paintBarChart(ctx, data, spec, layout, theme);
      break;
    case "horizontalBar":
      paintHorizontalBarChart(ctx, data, spec, layout, theme);
      break;
    case "line":
      paintLineChart(ctx, data, spec, layout, theme);
      break;
    case "area":
      paintAreaChart(ctx, data, spec, layout, theme);
      break;
    case "scatter":
      paintScatterChart(ctx, data, spec, layout, theme);
      break;
    case "pie":
    case "donut":
      paintPieChart(ctx, data, spec, layout, theme);
      break;
    case "waterfall":
      paintWaterfallChart(ctx, data, spec, layout, theme);
      break;
    case "combo":
      paintComboChart(ctx, data, spec, layout, theme);
      break;
    case "radar":
      paintRadarChart(ctx, data, spec, layout, theme);
      break;
    case "bubble":
      paintBubbleChart(ctx, data, spec, layout, theme);
      break;
    case "histogram":
      paintHistogramChart(ctx, data, spec, layout, theme);
      break;
    case "funnel":
      paintFunnelChart(ctx, data, spec, layout, theme);
      break;
    case "treemap":
      paintTreemapChart(ctx, data, spec, layout, theme);
      break;
    case "stock":
      paintStockChart(ctx, data, spec, layout, theme);
      break;
    case "boxPlot":
      paintBoxPlotChart(ctx, data, spec, layout, theme);
      break;
    case "sunburst":
      paintSunburstChart(ctx, data, spec, layout, theme);
      break;
    case "pareto":
      paintParetoChart(ctx, data, spec, layout, theme);
      break;
  }
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
  let layout: ChartLayout;

  switch (spec.mark) {
    case "bar": layout = computeBarLayout(width, height, spec, data, theme); break;
    case "horizontalBar": layout = computeHorizontalBarLayout(width, height, spec, data, theme); break;
    case "line": layout = computeLineLayout(width, height, spec, data, theme); break;
    case "area": layout = computeAreaLayout(width, height, spec, data, theme); break;
    case "scatter": layout = computeScatterLayout(width, height, spec, data, theme); break;
    case "pie":
    case "donut": layout = computePieLayout(width, height, spec, data, theme); break;
    case "waterfall": layout = computeWaterfallLayout(width, height, spec, data, theme); break;
    case "combo": layout = computeComboLayout(width, height, spec, data, theme); break;
    case "radar": layout = computeRadarLayout(width, height, spec, data, theme); break;
    case "bubble": layout = computeBubbleLayout(width, height, spec, data, theme); break;
    case "histogram": layout = computeHistogramLayout(width, height, spec, data, theme); break;
    case "funnel": layout = computeFunnelLayout(width, height, spec, data, theme); break;
    case "treemap": layout = computeTreemapLayout(width, height, spec, data, theme); break;
    case "stock": layout = computeStockLayout(width, height, spec, data, theme); break;
    case "boxPlot": layout = computeBoxPlotLayout(width, height, spec, data, theme); break;
    case "sunburst": layout = computeSunburstLayout(width, height, spec, data, theme); break;
    case "pareto": layout = computeParetoLayout(width, height, spec, data, theme); break;
    default: layout = computeBarLayout(width, height, spec, data, theme); break;
  }

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

/** Compute hit geometry for any chart type. */
export function dispatchComputeGeometry(
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): HitGeometry {
  switch (spec.mark) {
    case "bar":
      return { type: "bars", rects: computeBarRects(data, spec, layout, theme) };
    case "horizontalBar":
      return { type: "bars", rects: computeHorizontalBarRects(data, spec, layout, theme) };
    case "line":
      return { type: "points", markers: computeLinePointMarkers(data, spec, layout, theme) };
    case "area":
      return { type: "points", markers: computeAreaPointMarkers(data, spec, layout, theme) };
    case "scatter":
      return { type: "points", markers: computeScatterPointMarkers(data, spec, layout, theme) };
    case "pie":
    case "donut":
      return { type: "slices", arcs: computePieSliceArcs(data, spec, layout, theme) };
    case "waterfall":
      return { type: "bars", rects: computeWaterfallBarRects(data, spec, layout, theme) };
    case "combo":
      return computeComboHitGeometry(data, spec, layout, theme);
    case "radar":
      return { type: "points", markers: computeRadarPointMarkers(data, spec, layout, theme) };
    case "bubble":
      return { type: "points", markers: computeBubblePointMarkers(data, spec, layout, theme) };
    case "histogram":
      return { type: "bars", rects: computeHistogramBarRects(data, spec, layout, theme) };
    case "funnel":
      return { type: "bars", rects: computeFunnelBarRects(data, spec, layout, theme) };
    case "treemap":
      return { type: "bars", rects: computeTreemapBarRects(data, spec, layout, theme) };
    case "stock":
      return { type: "bars", rects: computeStockBarRects(data, spec, layout, theme) };
    case "boxPlot":
      return { type: "bars", rects: computeBoxPlotBarRects(data, spec, layout, theme) };
    case "sunburst":
      return { type: "bars", rects: computeSunburstBarRects(data, spec, layout, theme) };
    case "pareto":
      return computeParetoHitGeometry(data, spec, layout, theme);
  }
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
