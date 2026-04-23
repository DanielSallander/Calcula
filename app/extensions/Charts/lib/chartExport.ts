//! FILENAME: app/extensions/Charts/lib/chartExport.ts
// PURPOSE: Export a chart as a PNG image file.
// CONTEXT: Re-renders the chart to a temporary OffscreenCanvas at full resolution,
//          converts to PNG blob, and writes to disk via Tauri save dialog.

import { save } from "@tauri-apps/plugin-dialog";
import { writeBinaryFile } from "@api/lib";
import { getChartById } from "./chartStore";
import { readChartDataResolved } from "./chartDataReader";
import { dispatchPaint, dispatchComputeLayout } from "../rendering/chartDispatch";
import { resolveChartTheme } from "../rendering/chartTheme";
import { isPivotDataSource } from "../types";
import { fetchPivotChartFields } from "./pivotChartDataReader";

// ============================================================================
// Public API
// ============================================================================

/**
 * Export a chart as a PNG image.
 *
 * Re-renders the chart to a temporary OffscreenCanvas at the chart's native
 * resolution (scaled by device pixel ratio for crisp output), then opens a
 * Tauri save dialog for the user to pick a file path, and writes the PNG bytes.
 *
 * @param chartId - The chart ID to export
 * @param filename - Optional default filename (without extension). Defaults to chart name.
 * @returns The file path where the image was saved, or null if cancelled.
 */
export async function exportChartAsImage(
  chartId: number,
  filename?: string,
): Promise<string | null> {
  const chart = getChartById(chartId);
  if (!chart) {
    throw new Error(`Chart ${chartId} not found`);
  }

  // 1. Re-read data and resolve spec references
  const resolved = await readChartDataResolved(chart.spec);
  const data = resolved.data;
  const spec = resolved.spec;

  // 2. Determine export dimensions
  // Use 2x resolution for crisp output (similar to Retina/HiDPI displays)
  const exportScale = 2;
  const logicalWidth = chart.width;
  const logicalHeight = chart.height;
  const pxWidth = Math.round(logicalWidth * exportScale);
  const pxHeight = Math.round(logicalHeight * exportScale);

  // 3. Compute layout and theme
  const theme = resolveChartTheme(spec.config);
  const layout = dispatchComputeLayout(logicalWidth, logicalHeight, spec, data, theme);

  // Adjust layout for pivot field buttons if needed
  if (isPivotDataSource(spec.data)) {
    const pivotFields = await fetchPivotChartFields(spec.data.pivotId);
    if (pivotFields && pivotFields.length > 0) {
      // Pivot field buttons are interactive UI elements, not useful in a static export.
      // We skip adjusting layout for them so the chart fills the image.
    }
  }

  // 4. Create OffscreenCanvas and paint the chart
  const offscreen = new OffscreenCanvas(pxWidth, pxHeight);
  const ctx = offscreen.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to create OffscreenCanvas 2D context");
  }

  // Fill background with white (charts are drawn on white background)
  ctx.fillStyle = theme.background || "#ffffff";
  ctx.fillRect(0, 0, pxWidth, pxHeight);

  // Scale for HiDPI
  ctx.scale(exportScale, exportScale);

  // Paint the chart
  dispatchPaint(ctx, data, spec, layout, theme);

  // 5. Convert to PNG blob
  const blob = await offscreen.convertToBlob({ type: "image/png" });
  const arrayBuffer = await blob.arrayBuffer();
  const bytes = Array.from(new Uint8Array(arrayBuffer));

  // 6. Show save dialog
  const defaultName = filename ?? chart.name.replace(/[^a-zA-Z0-9_\- ]/g, "_");
  const filePath = await save({
    title: "Save Chart as Image",
    defaultPath: `${defaultName}.png`,
    filters: [{ name: "PNG Image", extensions: ["png"] }],
  });

  if (!filePath) return null; // User cancelled

  // 7. Write PNG to disk
  await writeBinaryFile(filePath, bytes);

  console.log(`[Charts] Exported chart ${chartId} to:`, filePath);
  return filePath;
}
