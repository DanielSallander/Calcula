//! FILENAME: app/extensions/Charts/components/ChartPreview.tsx
// PURPOSE: Live chart preview canvas inside the dialog.
// CONTEXT: Renders any chart type using the same painters used for grid overlays,
//          giving WYSIWYG feedback as the user configures their chart.

import React, { useRef, useEffect } from "react";
import type { ChartSpec, ParsedChartData, ChartLayout } from "../types";
import { DEFAULT_CHART_THEME } from "../rendering/chartTheme";
import type { ChartRenderTheme } from "../rendering/chartTheme";
import { paintBarChart, computeLayout as computeBarLayout } from "../rendering/barChartPainter";
import { paintLineChart, computeLineLayout } from "../rendering/lineChartPainter";
import { paintAreaChart, computeAreaLayout } from "../rendering/areaChartPainter";
import { paintHorizontalBarChart, computeHorizontalBarLayout } from "../rendering/horizontalBarChartPainter";
import { paintPieChart, computePieLayout } from "../rendering/pieChartPainter";
import { paintScatterChart, computeScatterLayout } from "../rendering/scatterChartPainter";
import { paintWaterfallChart, computeWaterfallLayout } from "../rendering/waterfallChartPainter";
import { paintComboChart, computeComboLayout } from "../rendering/comboChartPainter";
import { paintRadarChart, computeRadarLayout } from "../rendering/radarChartPainter";
import { paintBubbleChart, computeBubbleLayout } from "../rendering/bubbleChartPainter";
import { paintHistogramChart, computeHistogramLayout } from "../rendering/histogramChartPainter";
import { paintFunnelChart, computeFunnelLayout } from "../rendering/funnelChartPainter";
import { PreviewContainer, PreviewCanvas } from "./CreateChartDialog.styles";

interface ChartPreviewProps {
  spec: ChartSpec;
  data: ParsedChartData | null;
}

/** Compute layout for any chart type. */
function computeLayout(
  w: number,
  h: number,
  spec: ChartSpec,
  data: ParsedChartData,
  theme: ChartRenderTheme,
): ChartLayout {
  switch (spec.mark) {
    case "bar": return computeBarLayout(w, h, spec, data, theme);
    case "horizontalBar": return computeHorizontalBarLayout(w, h, spec, data, theme);
    case "line": return computeLineLayout(w, h, spec, data, theme);
    case "area": return computeAreaLayout(w, h, spec, data, theme);
    case "scatter": return computeScatterLayout(w, h, spec, data, theme);
    case "pie":
    case "donut": return computePieLayout(w, h, spec, data, theme);
    case "waterfall": return computeWaterfallLayout(w, h, spec, data, theme);
    case "combo": return computeComboLayout(w, h, spec, data, theme);
    case "radar": return computeRadarLayout(w, h, spec, data, theme);
    case "bubble": return computeBubbleLayout(w, h, spec, data, theme);
    case "histogram": return computeHistogramLayout(w, h, spec, data, theme);
    case "funnel": return computeFunnelLayout(w, h, spec, data, theme);
  }
}

/** Paint any chart type to a canvas context. */
function paintChart(
  ctx: CanvasRenderingContext2D,
  data: ParsedChartData,
  spec: ChartSpec,
  layout: ChartLayout,
  theme: ChartRenderTheme,
): void {
  switch (spec.mark) {
    case "bar": paintBarChart(ctx, data, spec, layout, theme); break;
    case "horizontalBar": paintHorizontalBarChart(ctx, data, spec, layout, theme); break;
    case "line": paintLineChart(ctx, data, spec, layout, theme); break;
    case "area": paintAreaChart(ctx, data, spec, layout, theme); break;
    case "scatter": paintScatterChart(ctx, data, spec, layout, theme); break;
    case "pie":
    case "donut": paintPieChart(ctx, data, spec, layout, theme); break;
    case "waterfall": paintWaterfallChart(ctx, data, spec, layout, theme); break;
    case "combo": paintComboChart(ctx, data, spec, layout, theme); break;
    case "radar": paintRadarChart(ctx, data, spec, layout, theme); break;
    case "bubble": paintBubbleChart(ctx, data, spec, layout, theme); break;
    case "histogram": paintHistogramChart(ctx, data, spec, layout, theme); break;
    case "funnel": paintFunnelChart(ctx, data, spec, layout, theme); break;
  }
}

export function ChartPreview({ spec, data }: ChartPreviewProps): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !data || data.series.length === 0) {
      // Draw empty state
      if (canvas) {
        const ctx = canvas.getContext("2d");
        if (ctx) {
          const dpr = window.devicePixelRatio || 1;
          canvas.width = canvas.clientWidth * dpr;
          canvas.height = canvas.clientHeight * dpr;
          ctx.scale(dpr, dpr);
          ctx.fillStyle = "#ffffff";
          ctx.fillRect(0, 0, canvas.clientWidth, canvas.clientHeight);
          ctx.fillStyle = "#999999";
          ctx.font = "12px 'Segoe UI', system-ui, sans-serif";
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(
            data ? "No numeric data to chart" : "Select a data range to preview",
            canvas.clientWidth / 2,
            canvas.clientHeight / 2,
          );
        }
      }
      return;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    const layout = computeLayout(w, h, spec, data, DEFAULT_CHART_THEME);
    ctx.clearRect(0, 0, w, h);
    paintChart(ctx, data, spec, layout, DEFAULT_CHART_THEME);
  }, [spec, data]);

  return (
    <PreviewContainer>
      <PreviewCanvas ref={canvasRef} />
    </PreviewContainer>
  );
}
