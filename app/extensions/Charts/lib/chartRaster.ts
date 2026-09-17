//! FILENAME: app/extensions/Charts/lib/chartRaster.ts
// PURPOSE: Render a chart to PNG bytes off-screen — as the document defines it,
//          or with the insight overlay (cues and comments) the reader is
//          looking at.
// CONTEXT: Two commands, two meanings (docs/design/insight-overlays.md §4.8a,
//          D-IO-8): *Export as image* is "the chart", and paints NO transient
//          cue; *Snapshot* is "what I am looking at", and paints the visible
//          cues and every comment through the same painters the screen uses,
//          over the same geometry, at the export layout. One renderer, one
//          switch, so the two can never drift in what the chart itself looks
//          like. The kept annotations are layers in the spec and appear in
//          both, which is what "keep" means.

import { getChartById } from "./chartStore";
import { readChartDataResolved } from "./chartDataReader";
import { dispatchPaint, dispatchComputeLayout, dispatchComputeGeometry } from "../rendering/chartDispatch";
import { resolveChartTheme } from "../rendering/chartTheme";
import { paintChartCues } from "../rendering/cuePainter";
import { paintChartComments } from "../rendering/cueChrome";
import { getChartOverlay, visibleChartCues } from "@api/chartCues";

export const EXPORT_SCALE = 2;

export interface RasterOptions {
  /** Paint the visible cues and the comments over the chart. Default: false. */
  withOverlay?: boolean;
}

/**
 * The chart as a PNG blob at 2x, optionally with its overlay.
 *
 * Throws when the chart does not exist or the canvas cannot be created; the
 * caller decides how to say so.
 */
export async function renderChartPng(chartId: string, options: RasterOptions = {}): Promise<Blob> {
  const chart = getChartById(chartId);
  if (!chart) throw new Error(`Chart ${chartId} not found`);

  const resolved = await readChartDataResolved(chart.spec, 0, chartId);
  const data = resolved.data;
  const spec = resolved.spec;

  const logicalWidth = chart.width;
  const logicalHeight = chart.height;
  const pxWidth = Math.round(logicalWidth * EXPORT_SCALE);
  const pxHeight = Math.round(logicalHeight * EXPORT_SCALE);

  const theme = resolveChartTheme(spec.config);
  const layout = dispatchComputeLayout(logicalWidth, logicalHeight, spec, data, theme);

  const offscreen = new OffscreenCanvas(pxWidth, pxHeight);
  const ctx = offscreen.getContext("2d");
  if (!ctx) throw new Error("Failed to create OffscreenCanvas 2D context");

  ctx.fillStyle = theme.background || "#ffffff";
  ctx.fillRect(0, 0, pxWidth, pxHeight);
  ctx.scale(EXPORT_SCALE, EXPORT_SCALE);

  dispatchPaint(ctx, data, spec, layout, theme);

  if (options.withOverlay) {
    const overlay = getChartOverlay(chartId);
    if (overlay.cues.length > 0 || overlay.comments.length > 0) {
      // The overlay is drawn at the export layout's own geometry, in logical
      // pixels (the context is already scaled), chart origin at (0, 0).
      const geometry = dispatchComputeGeometry(data, spec, layout, theme);
      paintChartCues(ctx, 0, 0, geometry, data, visibleChartCues(chartId), overlay.selectedFactId);
      const byId = new Map(overlay.cues.map((c) => [c.factId, c] as const));
      paintChartComments(ctx, 0, 0, logicalWidth, logicalHeight, geometry, data, overlay.comments, byId);
    }
  }

  return offscreen.convertToBlob({ type: "image/png" });
}
