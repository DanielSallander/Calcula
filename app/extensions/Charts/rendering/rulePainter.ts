//! FILENAME: app/extensions/Charts/rendering/rulePainter.ts
// PURPOSE: Paint rule marks (horizontal/vertical reference lines) as chart layer annotations.
// CONTEXT: Used by chartDispatch.ts when a layer has mark: "rule".

import type { ChartSpec, ChartLayout, ParsedChartData, LayerSpec, RuleMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { createScaleFromSpec } from "./scales";

/**
 * Paint a rule (reference line) layer onto the chart.
 * Rules draw horizontal lines at a Y value and/or vertical lines at an X category index.
 */
export function paintRule(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  _data: ParsedChartData,
  layer: LayerSpec,
  parentSpec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): void {
  const opts = (layer.markOptions ?? {}) as RuleMarkOptions;
  const { plotArea } = layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  const color = opts.color ?? "#999999";
  const strokeWidth = opts.strokeWidth ?? 1;
  const strokeDash = opts.strokeDash ?? [];

  ctx.strokeStyle = color;
  ctx.lineWidth = strokeWidth;
  ctx.setLineDash(strokeDash);

  // Horizontal rule at Y value
  if (opts.y != null) {
    // Build a linear scale from the parent spec's Y axis
    const yAxis = parentSpec.yAxis;
    const yMin = yAxis.min ?? 0;
    const yMax = yAxis.max ?? opts.y * 1.5;

    const scale = createScaleFromSpec(
      yAxis.scale,
      [yMin, yMax],
      [plotArea.y + plotArea.height, plotArea.y],
    );

    const py = scale.scale(opts.y);

    if (py >= plotArea.y && py <= plotArea.y + plotArea.height) {
      ctx.beginPath();
      ctx.moveTo(plotArea.x, py);
      ctx.lineTo(plotArea.x + plotArea.width, py);
      ctx.stroke();

      // Draw label if provided
      if (opts.label) {
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = "10px 'Segoe UI', system-ui, sans-serif";
        ctx.textAlign = "right";
        ctx.textBaseline = "bottom";
        ctx.fillText(opts.label, plotArea.x + plotArea.width - 4, py - 3);
      }
    }
  }

  // Vertical rule at X category index
  if (opts.x != null) {
    // Simple proportional placement within plot area
    const catCount = _data.categories.length || 1;
    const step = plotArea.width / catCount;
    const px = plotArea.x + opts.x * step + step / 2;

    if (px >= plotArea.x && px <= plotArea.x + plotArea.width) {
      ctx.beginPath();
      ctx.moveTo(px, plotArea.y);
      ctx.lineTo(px, plotArea.y + plotArea.height);
      ctx.stroke();

      if (opts.label) {
        ctx.setLineDash([]);
        ctx.fillStyle = color;
        ctx.font = "10px 'Segoe UI', system-ui, sans-serif";
        ctx.textAlign = "left";
        ctx.textBaseline = "top";
        ctx.fillText(opts.label, px + 3, plotArea.y + 3);
      }
    }
  }

  ctx.restore();
}
