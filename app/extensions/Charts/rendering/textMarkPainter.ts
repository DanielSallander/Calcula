//! FILENAME: app/extensions/Charts/rendering/textMarkPainter.ts
// PURPOSE: Paint text mark layers (annotations/labels) on charts.
// CONTEXT: Used by chartDispatch.ts when a layer has mark: "text".

import type { ChartSpec, ChartLayout, ParsedChartData, LayerSpec, TextMarkOptions } from "../types";
import type { ChartRenderTheme } from "./chartTheme";
import { createScaleFromSpec } from "./scales";

/**
 * Paint a text annotation layer onto the chart.
 * Text marks place arbitrary text at a given (x category index, y value) position.
 */
export function paintTextMark(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  layer: LayerSpec,
  parentSpec: ChartSpec,
  layout: ChartLayout,
  _theme: ChartRenderTheme,
): void {
  const opts = (layer.markOptions ?? {}) as TextMarkOptions;
  if (!opts.text) return;

  const { plotArea } = layout;

  ctx.save();
  ctx.beginPath();
  ctx.rect(plotArea.x, plotArea.y, plotArea.width, plotArea.height);
  ctx.clip();

  // Compute X position from category index
  const catCount = data.categories.length || 1;
  const step = plotArea.width / catCount;
  const px = plotArea.x + (opts.x ?? 0) * step + step / 2;

  // Compute Y position from data value using parent Y scale
  const yAxis = parentSpec.yAxis;
  const yMin = yAxis.min ?? 0;
  const yMax = yAxis.max ?? (opts.y ?? 0) * 1.5;

  const scale = createScaleFromSpec(
    yAxis.scale,
    [yMin, yMax],
    [plotArea.y + plotArea.height, plotArea.y],
  );

  const py = scale.scale(opts.y ?? 0);

  // Style
  const fontSize = opts.fontSize ?? 11;
  const color = opts.color ?? "#333333";
  const anchor = opts.anchor ?? "middle";
  const baseline = opts.baseline ?? "middle";

  ctx.fillStyle = color;
  ctx.font = `${fontSize}px 'Segoe UI', system-ui, sans-serif`;
  ctx.textAlign = anchor === "start" ? "left" : anchor === "end" ? "right" : "center";
  ctx.textBaseline = baseline;
  ctx.fillText(opts.text, px, py);

  ctx.restore();
}
