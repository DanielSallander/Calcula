//! FILENAME: app/extensions/Charts/lib/chartExport.ts
// PURPOSE: Export a chart as a PNG image file — the chart as the document
//          defines it, never with a transient insight overlay.
// CONTEXT: The rendering lives in `chartRaster.ts`, shared with the overlay
//          snapshot (`chartSnapshot.ts`). This file only asks for the plain
//          picture and saves it: D-IO-8 keeps *Export as image* clean of
//          transient cues, so a reader who exports "the chart" gets the chart.

import { save } from "@tauri-apps/plugin-dialog";
import { writeBinaryFile } from "@api/lib";
import { getChartById } from "./chartStore";
import { renderChartPng } from "./chartRaster";

// ============================================================================
// Public API
// ============================================================================

/** Write PNG bytes to a path the user picks. Returns the path, or null when cancelled. */
export async function savePngViaDialog(blob: Blob, defaultName: string, title: string): Promise<string | null> {
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = Array.from(new Uint8Array(arrayBuffer));
  const filePath = await save({
    title,
    defaultPath: `${defaultName}.png`,
    filters: [{ name: "PNG Image", extensions: ["png"] }],
  });
  if (!filePath) return null;
  await writeBinaryFile(filePath, bytes);
  return filePath;
}

/** A file-safe default name for a chart. */
export function defaultImageName(chartId: string, filename?: string): string {
  const chart = getChartById(chartId);
  return filename ?? (chart?.name ?? chartId).replace(/[^a-zA-Z0-9_\- ]/g, "_");
}

/**
 * Export a chart as a PNG image.
 *
 * Re-renders the chart at 2x, then opens a Tauri save dialog for the user to
 * pick a file path, and writes the PNG bytes.
 *
 * @param chartId - The chart ID to export
 * @param filename - Optional default filename (without extension). Defaults to chart name.
 * @returns The file path where the image was saved, or null if cancelled.
 */
export async function exportChartAsImage(
  chartId: string,
  filename?: string,
): Promise<string | null> {
  const blob = await renderChartPng(chartId, { withOverlay: false });
  const filePath = await savePngViaDialog(blob, defaultImageName(chartId, filename), "Save Chart as Image");
  if (filePath) console.log(`[Charts] Exported chart ${chartId} to:`, filePath);
  return filePath;
}
