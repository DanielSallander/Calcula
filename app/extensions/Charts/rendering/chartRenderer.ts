//! FILENAME: app/extensions/Charts/rendering/chartRenderer.ts
// PURPOSE: Grid overlay render function for charts with OffscreenCanvas caching.
// CONTEXT: Registered with registerGridOverlay(). Called synchronously every frame
//          by the core canvas renderer. Uses async data fetching with cache to avoid
//          blocking the render loop.
//          Charts are free-floating overlays positioned by pixel coordinates.

import {
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  overlaySheetToCanvas,
  requestOverlayRedraw,
  type OverlayRenderContext,
  type OverlayHitTestContext,
} from "../../../src/api/gridOverlays";

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
 * Charts use floating pixel-based positioning.
 */
export function renderChart(overlayCtx: OverlayRenderContext): void {
  const { ctx, region } = overlayCtx;
  const chartId = region.data?.chartId as number;
  if (chartId == null) return;

  const chart = getChartById(chartId);
  if (!chart) return;

  // Floating overlays use pixel coordinates
  if (!region.floating) return;

  const rowHeaderWidth = overlayGetRowHeaderWidth(overlayCtx);
  const colHeaderHeight = overlayGetColHeaderHeight(overlayCtx);

  // Convert sheet pixel position to canvas pixel position
  const { canvasX, canvasY } = overlaySheetToCanvas(
    overlayCtx,
    region.floating.x,
    region.floating.y,
  );
  const chartWidth = region.floating.width;
  const chartHeight = region.floating.height;

  const endX = canvasX + chartWidth;
  const endY = canvasY + chartHeight;

  // Skip if not visible
  if (endX < rowHeaderWidth || endY < colHeaderHeight) return;
  if (canvasX > overlayCtx.canvasWidth || canvasY > overlayCtx.canvasHeight) return;

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
  ctx.fillRect(canvasX, canvasY, chartWidth, chartHeight);

  // Check cache
  const dpr = window.devicePixelRatio || 1;
  const pxWidth = Math.round(chartWidth * dpr);
  const pxHeight = Math.round(chartHeight * dpr);
  const currentVersion = chartVersions.get(chartId) ?? 0;
  const cached = chartCanvasCache.get(chartId);

  if (cached && cached.version === currentVersion) {
    // Version matches - draw cached image (stretched if dimensions differ during resize)
    ctx.drawImage(cached.canvas, canvasX, canvasY, chartWidth, chartHeight);
  } else if (pendingRenders.has(chartId)) {
    // Render in progress - stretch old cache if available, otherwise placeholder
    if (cached) {
      ctx.drawImage(cached.canvas, canvasX, canvasY, chartWidth, chartHeight);
    } else {
      drawPlaceholder(ctx, canvasX, canvasY, chartWidth, chartHeight, chart.name);
    }
  } else {
    // Cache miss - show old cache stretched or placeholder, kick off async render
    if (cached) {
      ctx.drawImage(cached.canvas, canvasX, canvasY, chartWidth, chartHeight);
    } else {
      drawPlaceholder(ctx, canvasX, canvasY, chartWidth, chartHeight, chart.name);
    }
    renderChartAsync(chartId, pxWidth, pxHeight, chartWidth, chartHeight, dpr, currentVersion);
  }

  // Draw border
  ctx.strokeStyle = "#d0d0d0";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(
    Math.floor(canvasX) + 0.5,
    Math.floor(canvasY) + 0.5,
    chartWidth - 1,
    chartHeight - 1,
  );

  // Draw selection border if chart is selected
  if (isChartSelected(chartId)) {
    ctx.strokeStyle = "#0e639c";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(canvasX + 1, canvasY + 1, chartWidth - 2, chartHeight - 2);

    // Resize handles at corners
    drawResizeHandles(ctx, canvasX, canvasY, chartWidth, chartHeight);
  }

  ctx.restore();
}

// ============================================================================
// Hit Testing
// ============================================================================

/**
 * Hit-test for chart overlay regions.
 * Uses pixel-based bounds for floating overlays.
 */
export function hitTestChart(hitCtx: OverlayHitTestContext): boolean {
  // Use pre-computed canvas bounds for floating overlays
  if (hitCtx.floatingCanvasBounds) {
    const b = hitCtx.floatingCanvasBounds;
    return (
      hitCtx.canvasX >= b.x &&
      hitCtx.canvasX <= b.x + b.width &&
      hitCtx.canvasY >= b.y &&
      hitCtx.canvasY <= b.y + b.height
    );
  }

  // Fallback for non-floating (should not happen for charts now)
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

    // Trigger a canvas redraw so the cached chart gets composited.
    // Uses requestOverlayRedraw (fires onRegionChange listeners) which is more
    // reliable than emitAppEvent from async code, as event listener closures
    // may hold stale draw references.
    requestOverlayRedraw();
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
