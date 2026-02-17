//! FILENAME: app/extensions/Charts/rendering/chartRenderer.ts
// PURPOSE: Grid overlay render function for charts with OffscreenCanvas caching.
// CONTEXT: Registered with registerGridOverlay(). Called synchronously every frame
//          by the core canvas renderer. Uses async data fetching with cache to avoid
//          blocking the render loop.

import {
  overlayGetColumnX,
  overlayGetRowY,
  overlayGetColumnsWidth,
  overlayGetRowsHeight,
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  type OverlayRenderContext,
} from "../../../src/api/gridOverlays";
import { emitAppEvent, AppEvents } from "../../../src/api/events";

import { getChartById } from "../lib/chartStore";
import { readChartData } from "../lib/chartDataReader";
import { paintBarChart, computeLayout } from "./barChartPainter";
import { DEFAULT_CHART_THEME } from "./chartTheme";
import { isChartSelected } from "../handlers/selectionHandler";

// ============================================================================
// OffscreenCanvas Cache
// ============================================================================

interface CachedChart {
  canvas: OffscreenCanvas;
  version: number;
  width: number;
  height: number;
}

const chartCanvasCache = new Map<number, CachedChart>();
const chartVersions = new Map<number, number>();
const pendingRenders = new Set<number>();

/**
 * Invalidate a specific chart's cache so it re-renders on the next frame.
 */
export function invalidateChartCache(chartId: number): void {
  chartVersions.set(chartId, (chartVersions.get(chartId) ?? 0) + 1);
}

/**
 * Invalidate all chart caches.
 */
export function invalidateAllChartCaches(): void {
  chartVersions.clear();
  chartCanvasCache.clear();
  pendingRenders.clear();
}

/**
 * Remove a chart from the cache entirely.
 */
export function removeChartFromCache(chartId: number): void {
  chartCanvasCache.delete(chartId);
  chartVersions.delete(chartId);
  pendingRenders.delete(chartId);
}

// ============================================================================
// Grid Overlay Render Function
// ============================================================================

/**
 * Render function registered with registerGridOverlay().
 * Called synchronously for each chart region visible in the viewport.
 */
export function renderChart(overlayCtx: OverlayRenderContext): void {
  const { ctx, region } = overlayCtx;
  const chartId = region.data?.chartId as number;
  if (chartId == null) return;

  const chart = getChartById(chartId);
  if (!chart) return;

  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  // Calculate pixel position and dimensions
  const startX = overlayGetColumnX(overlayCtx, region.startCol);
  const startY = overlayGetRowY(overlayCtx, region.startRow);
  const chartWidth = overlayGetColumnsWidth(overlayCtx, region.startCol, region.endCol);
  const chartHeight = overlayGetRowsHeight(overlayCtx, region.startRow, region.endRow);

  const endX = startX + chartWidth;
  const endY = startY + chartHeight;

  // Skip if not visible
  if (endX < rowHeaderWidth || endY < colHeaderHeight) return;
  if (startX > overlayCtx.canvasWidth || startY > overlayCtx.canvasHeight) return;

  // Clip to cell area (not over headers)
  ctx.save();
  ctx.beginPath();
  ctx.rect(
    rowHeaderWidth,
    colHeaderHeight,
    overlayCtx.canvasWidth - rowHeaderWidth,
    overlayCtx.canvasHeight - colHeaderHeight,
  );
  ctx.clip();

  // Draw white background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(startX, startY, chartWidth, chartHeight);

  // Check cache
  const dpr = window.devicePixelRatio || 1;
  const pxWidth = Math.round(chartWidth * dpr);
  const pxHeight = Math.round(chartHeight * dpr);
  const currentVersion = chartVersions.get(chartId) ?? 0;
  const cached = chartCanvasCache.get(chartId);

  if (
    cached &&
    cached.version === currentVersion &&
    cached.width === pxWidth &&
    cached.height === pxHeight
  ) {
    // Cache hit - draw instantly
    ctx.drawImage(cached.canvas, startX, startY, chartWidth, chartHeight);
  } else if (pendingRenders.has(chartId)) {
    // Render in progress - draw placeholder
    drawPlaceholder(ctx, startX, startY, chartWidth, chartHeight, chart.name);
  } else {
    // Cache miss - draw placeholder and kick off async render
    drawPlaceholder(ctx, startX, startY, chartWidth, chartHeight, chart.name);
    renderChartAsync(chartId, pxWidth, pxHeight, chartWidth, chartHeight, dpr, currentVersion);
  }

  // Draw border
  ctx.strokeStyle = "#d0d0d0";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(
    Math.floor(startX) + 0.5,
    Math.floor(startY) + 0.5,
    chartWidth - 1,
    chartHeight - 1,
  );

  // Draw selection border if chart is selected
  if (isChartSelected(chartId)) {
    ctx.strokeStyle = "#0e639c";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(startX + 1, startY + 1, chartWidth - 2, chartHeight - 2);

    // Resize handles at corners
    drawResizeHandles(ctx, startX, startY, chartWidth, chartHeight);
  }

  ctx.restore();
}

// ============================================================================
// Hit Testing
// ============================================================================

/**
 * Hit-test for chart overlay regions.
 */
export function hitTestChart(hitCtx: {
  region: { startRow: number; startCol: number; endRow: number; endCol: number };
  row: number;
  col: number;
}): boolean {
  return (
    hitCtx.row >= hitCtx.region.startRow &&
    hitCtx.row <= hitCtx.region.endRow &&
    hitCtx.col >= hitCtx.region.startCol &&
    hitCtx.col <= hitCtx.region.endCol
  );
}

// ============================================================================
// Async Render
// ============================================================================

async function renderChartAsync(
  chartId: number,
  pxWidth: number,
  pxHeight: number,
  logicalWidth: number,
  logicalHeight: number,
  dpr: number,
  version: number,
): Promise<void> {
  pendingRenders.add(chartId);

  try {
    const chart = getChartById(chartId);
    if (!chart) return;

    // Fetch data from the grid
    const data = await readChartData(chart.spec);

    // Check if version is still current (might have changed during async fetch)
    const currentVersion = chartVersions.get(chartId) ?? 0;
    if (currentVersion !== version) return;

    // Create OffscreenCanvas and paint
    const offscreen = new OffscreenCanvas(pxWidth, pxHeight);
    const offCtx = offscreen.getContext("2d");
    if (!offCtx) return;

    offCtx.scale(dpr, dpr);

    const layout = computeLayout(
      logicalWidth,
      logicalHeight,
      chart.spec,
      data,
      DEFAULT_CHART_THEME,
    );

    paintBarChart(offCtx, data, chart.spec, layout, DEFAULT_CHART_THEME);

    // Store in cache
    chartCanvasCache.set(chartId, {
      canvas: offscreen,
      version,
      width: pxWidth,
      height: pxHeight,
    });

    // Trigger a re-render so the cached chart gets composited
    emitAppEvent(AppEvents.GRID_REFRESH);
  } catch (err) {
    console.error(`[Charts] Failed to render chart ${chartId}:`, err);
  } finally {
    pendingRenders.delete(chartId);
  }
}

// ============================================================================
// Drawing Helpers
// ============================================================================

function drawPlaceholder(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  name: string,
): void {
  // Light background
  ctx.fillStyle = "#f5f5f5";
  ctx.fillRect(x, y, w, h);

  // Centered text
  ctx.fillStyle = "#999999";
  ctx.font = "12px 'Segoe UI', system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(`Loading ${name}...`, x + w / 2, y + h / 2);
}

function drawResizeHandles(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const handleSize = 6;
  ctx.fillStyle = "#0e639c";

  // Bottom-right handle
  const brX = x + w - handleSize;
  const brY = y + h - handleSize;
  ctx.fillRect(brX, brY, handleSize, handleSize);

  // Bottom-left handle
  ctx.fillRect(x, brY, handleSize, handleSize);

  // Top-right handle
  ctx.fillRect(brX, y, handleSize, handleSize);

  // Top-left handle
  ctx.fillRect(x, y, handleSize, handleSize);
}
