//! FILENAME: app/extensions/Charts/lib/chartOverlayHost.ts
// PURPOSE: What only Charts can do for the insight overlay: keep a cue or a
//          comment IN the chart's spec, and snapshot the chart with its overlay.
// CONTEXT: The `ChartCueHost` half of `@api/chartCues` (IoC, the chartParams
//          shape). Insights says "keep this cue" or "snapshot"; this module
//          decides how — a datum cue becomes a `marker` layer, a comment a
//          `text` layer, written through `updateChartSpec` so it persists,
//          exports and travels with the file. Both are anchored the way the
//          transient objects are (a series by name, a category index), never
//          to pixels.
//
//          NOT UNDOABLE TODAY, and said so here rather than in the design:
//          `updateChartSpec` mutates the store and schedules a save; no chart
//          spec edit enters the undo stack yet (the Design tab's edits do
//          not either). A kept layer is visible and deletable in the spec
//          editor, which is the transparency the vision asks for; undo for
//          chart spec edits is a Charts-wide item, not an overlay one.

import type { ChartCue, ChartCueComment, ChartCueHost } from "@api/chartCues";
import { emitAppEvent, AppEvents } from "@api/events";
import { showToast } from "@api/notifications";
import type { LayerSpec, MarkerMarkOptions, TextMarkOptions } from "../types";
import { getChartById, updateChartSpec } from "./chartStore";
import { getCachedChartData, invalidateChartCache } from "../rendering/chartRenderer";
import { cueStyleFor } from "../rendering/cuePainter";
import { ChartEvents } from "./chartEvents";
import { renderChartPng } from "./chartRaster";
import { defaultImageName, savePngViaDialog } from "./chartExport";

// ============================================================================
// Pure: the layers a cue or a comment becomes
// ============================================================================

/** The `marker` layer a datum cue becomes, or null for a cue that has no single datum. */
export function layerForCue(cue: ChartCue): LayerSpec | null {
  if (cue.anchor.type !== "datum") return null;
  if (cue.kind === "band" || cue.kind === "rule") return null;
  const markOptions: MarkerMarkOptions = {
    series: cue.anchor.series,
    x: cue.anchor.categoryIndex,
    shape: cue.kind === "emphasis" ? "emphasis" : "ring",
    // The colour at the moment of keeping — the document's style, so a kept
    // mark in a published application carries the publisher's colour.
    color: cueStyleFor(cue.polarity).stroke,
    ...(cue.description ? { label: cue.description } : {}),
  };
  return { mark: "marker", markOptions };
}

/** The `text` layer a comment becomes, given the datum's value; null when unattached. */
export function layerForComment(comment: ChartCueComment, valueAtDatum: number | null): LayerSpec | null {
  if (!comment.anchor || valueAtDatum === null) return null;
  const markOptions: TextMarkOptions = {
    x: comment.anchor.categoryIndex,
    y: valueAtDatum,
    text: comment.text,
    anchor: "start",
    baseline: "bottom",
  };
  return { mark: "text", markOptions };
}

// ============================================================================
// The host
// ============================================================================

function appendLayer(chartId: string, layer: LayerSpec): void {
  const chart = getChartById(chartId);
  if (!chart) throw new Error("Chart not found.");
  updateChartSpec(chartId, { layers: [...(chart.spec.layers ?? []), layer] });
  invalidateChartCache(chartId);
  window.dispatchEvent(new CustomEvent(ChartEvents.CHART_UPDATED, { detail: { chartId } }));
  emitAppEvent(AppEvents.GRID_REFRESH);
}

/** Write PNG bytes to the clipboard. Returns false when the platform refuses. */
async function copyPngToClipboard(blob: Blob): Promise<boolean> {
  try {
    const clip = (navigator as Navigator & { clipboard?: Clipboard }).clipboard;
    if (!clip || typeof clip.write !== "function" || typeof ClipboardItem === "undefined") return false;
    await clip.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}

export const chartOverlayHost: ChartCueHost = {
  async keepCue(chartId, cue) {
    const layer = layerForCue(cue);
    if (!layer) throw new Error("Only a mark on one datum can be kept in the chart.");
    appendLayer(chartId, layer);
  },

  async keepComment(chartId, comment) {
    if (!comment.anchor) throw new Error("This comment is not attached to a point on the chart.");
    const data = getCachedChartData(chartId)?.data;
    const series = data?.series.find((s) => s.name === comment.anchor!.series);
    const value = series?.values[comment.anchor.categoryIndex];
    const layer = layerForComment(comment, typeof value === "number" && Number.isFinite(value) ? value : null);
    if (!layer) throw new Error("The point this comment is attached to is not on the chart right now.");
    appendLayer(chartId, layer);
  },

  async snapshot(chartId, options) {
    const blob = await renderChartPng(chartId, { withOverlay: true });
    const copied = await copyPngToClipboard(blob);
    let path: string | null = null;
    if (options?.saveToFile || !copied) {
      path = await savePngViaDialog(blob, `${defaultImageName(chartId)} - snapshot`, "Save Snapshot");
    }
    if (copied) showToast("Snapshot copied to the clipboard.", { variant: "success" });
    else if (!path) showToast("The clipboard refused the image; nothing was saved.", { variant: "warning" });
    return path;
  },
};
