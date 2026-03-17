//! FILENAME: app/extensions/Charts/rendering/chartRenderer.ts
// PURPOSE: Grid overlay render function for charts with OffscreenCanvas caching,
//          tooltip rendering, and hierarchical selection highlighting.
// CONTEXT: Registered with registerGridOverlay(). Called synchronously every frame
//          by the core canvas renderer. Uses async data fetching with cache to avoid
//          blocking the render loop.
//          Charts are free-floating overlays positioned by pixel coordinates.

import {
  overlayGetRowHeaderWidth,
  overlayGetColHeaderHeight,
  overlaySheetToCanvas,
  requestOverlayRedraw,
  getGridRegions,
  type OverlayRenderContext,
  type OverlayHitTestContext,
} from "../../../src/api/gridOverlays";

import { getChartById, getAllCharts } from "../lib/chartStore";
import { readChartDataResolved } from "../lib/chartDataReader";
import {
  paintBarChart,
  computeLayout as computeBarLayout,
  computeBarRects,
} from "./barChartPainter";
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
import { DEFAULT_CHART_THEME } from "./chartTheme";
import { getSeriesColor } from "./chartTheme";
import { isChartSelected, getSubSelection } from "../handlers/selectionHandler";
import { hitTestGeometry } from "./chartHitTesting";
import { formatTickValue } from "./chartPainterUtils";
import type {
  ParsedChartData,
  BarRect,
  ChartHitResult,
  ChartLayout,
  HitGeometry,
  ChartType,
} from "../types";

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
  chartDataCache.delete(chartId);
}

// ============================================================================
// Chart Data Cache (persists across canvas invalidation)
// ============================================================================

interface CachedChartData {
  data: ParsedChartData;
  layout: ChartLayout;
  hitGeometry: HitGeometry;
  /** @deprecated Use hitGeometry instead. Kept for selection highlight compat. */
  barRects: BarRect[];
  logicalWidth: number;
  logicalHeight: number;
}

const chartDataCache = new Map<number, CachedChartData>();

/**
 * Get cached chart data for hit-testing. Returns null if not yet rendered.
 */
export function getCachedChartData(chartId: number): CachedChartData | null {
  return chartDataCache.get(chartId) ?? null;
}

// ============================================================================
// Viewport Params Cache (updated during sync render)
// ============================================================================

let cachedScrollX = 0;
let cachedScrollY = 0;
let cachedRowHeaderWidth = 50;
let cachedColHeaderHeight = 24;

/**
 * Convert canvas coordinates to chart-local coordinates.
 * Uses cached viewport params from the most recent render call.
 */
export function getChartLocalCoords(
  chartId: number,
  canvasX: number,
  canvasY: number,
): { localX: number; localY: number } | null {
  const chart = getChartById(chartId);
  if (!chart) return null;

  const chartCanvasX = cachedRowHeaderWidth + chart.x - cachedScrollX;
  const chartCanvasY = cachedColHeaderHeight + chart.y - cachedScrollY;

  return {
    localX: canvasX - chartCanvasX,
    localY: canvasY - chartCanvasY,
  };
}

// ============================================================================
// Hover State
// ============================================================================

let hoverState: {
  chartId: number;
  hitResult: ChartHitResult;
  canvasX: number;
  canvasY: number;
} | null = null;

/**
 * Handle mouse move over the grid area. Performs hit-testing against chart
 * regions and hit geometry to determine if the mouse is hovering over a data element.
 * Requests a redraw if hover state changes.
 */
export function handleChartMouseMove(canvasX: number, canvasY: number): void {
  const charts = getAllCharts();
  if (charts.length === 0) {
    if (hoverState !== null) {
      hoverState = null;
      requestOverlayRedraw();
    }
    return;
  }

  // Check if mouse is over any chart region
  const regions = getGridRegions().filter((r) => r.type === "chart");
  let foundHover = false;

  for (const region of regions) {
    if (!region.floating) continue;
    const chartId = region.data?.chartId as number;
    if (chartId == null) continue;

    // Compute canvas bounds for this chart
    const chartCanvasX = cachedRowHeaderWidth + region.floating.x - cachedScrollX;
    const chartCanvasY = cachedColHeaderHeight + region.floating.y - cachedScrollY;
    const chartWidth = region.floating.width;
    const chartHeight = region.floating.height;

    // Check if mouse is within chart bounds
    if (
      canvasX >= chartCanvasX &&
      canvasX <= chartCanvasX + chartWidth &&
      canvasY >= chartCanvasY &&
      canvasY <= chartCanvasY + chartHeight
    ) {
      // Get chart-local coordinates
      const localX = canvasX - chartCanvasX;
      const localY = canvasY - chartCanvasY;

      // Hit-test against geometry
      const cachedData = chartDataCache.get(chartId);
      if (cachedData) {
        const hitResult = hitTestGeometry(localX, localY, cachedData.hitGeometry, cachedData.layout);

        if (hitResult.type === "bar" || hitResult.type === "point" || hitResult.type === "slice") {
          const changed =
            hoverState === null ||
            hoverState.chartId !== chartId ||
            hoverState.hitResult.seriesIndex !== hitResult.seriesIndex ||
            hoverState.hitResult.categoryIndex !== hitResult.categoryIndex;

          hoverState = { chartId, hitResult, canvasX, canvasY };
          if (changed) requestOverlayRedraw();
          foundHover = true;
          break;
        }
      }
    }
  }

  if (!foundHover && hoverState !== null) {
    hoverState = null;
    requestOverlayRedraw();
  } else if (foundHover && hoverState) {
    // Update canvas position even if same element (for tooltip tracking)
    hoverState.canvasX = canvasX;
    hoverState.canvasY = canvasY;
  }
}

/**
 * Clear hover state when mouse leaves the grid area.
 */
export function handleChartMouseLeave(): void {
  if (hoverState !== null) {
    hoverState = null;
    requestOverlayRedraw();
  }
}

// ============================================================================
// Chart Painter Dispatch
// ============================================================================

/** Paint a chart to a canvas context, dispatching to the correct painter. */
function paintChart(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  data: ParsedChartData,
  spec: import("../types").ChartSpec,
  layout: ChartLayout,
  theme: import("./chartTheme").ChartRenderTheme,
): void {
  switch (spec.mark) {
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
  }
}

/** Compute layout for any chart type. */
function computeChartLayout(
  width: number,
  height: number,
  spec: import("../types").ChartSpec,
  data: ParsedChartData,
  theme: import("./chartTheme").ChartRenderTheme,
): ChartLayout {
  switch (spec.mark) {
    case "bar": return computeBarLayout(width, height, spec, data, theme);
    case "horizontalBar": return computeHorizontalBarLayout(width, height, spec, data, theme);
    case "line": return computeLineLayout(width, height, spec, data, theme);
    case "area": return computeAreaLayout(width, height, spec, data, theme);
    case "scatter": return computeScatterLayout(width, height, spec, data, theme);
    case "pie":
    case "donut": return computePieLayout(width, height, spec, data, theme);
    case "waterfall": return computeWaterfallLayout(width, height, spec, data, theme);
    case "combo": return computeComboLayout(width, height, spec, data, theme);
    case "radar": return computeRadarLayout(width, height, spec, data, theme);
    case "bubble": return computeBubbleLayout(width, height, spec, data, theme);
    case "histogram": return computeHistogramLayout(width, height, spec, data, theme);
    case "funnel": return computeFunnelLayout(width, height, spec, data, theme);
  }
}

/** Compute hit geometry for any chart type. */
function computeChartHitGeometry(
  data: ParsedChartData,
  spec: import("../types").ChartSpec,
  layout: ChartLayout,
  theme: import("./chartTheme").ChartRenderTheme,
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
  }
}

/** Extract BarRect[] from HitGeometry for backwards compat with selection highlights. */
function extractBarRects(geometry: HitGeometry): BarRect[] {
  if (geometry.type === "bars") return geometry.rects;
  if (geometry.type === "composite") {
    for (const g of geometry.groups) {
      if (g.type === "bars") return g.rects;
    }
  }
  return [];
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

  // Cache viewport params for mouse coordinate conversion
  cachedScrollX = overlayCtx.viewport.scrollX;
  cachedScrollY = overlayCtx.viewport.scrollY;
  cachedRowHeaderWidth = rowHeaderWidth;
  cachedColHeaderHeight = colHeaderHeight;

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

  // 1. Draw white background
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(canvasX, canvasY, chartWidth, chartHeight);

  // 2. Draw cached chart image
  const dpr = window.devicePixelRatio || 1;
  const pxWidth = Math.round(chartWidth * dpr);
  const pxHeight = Math.round(chartHeight * dpr);
  const currentVersion = chartVersions.get(chartId) ?? 0;
  const cached = chartCanvasCache.get(chartId);

  if (cached && cached.version === currentVersion) {
    ctx.drawImage(cached.canvas, canvasX, canvasY, chartWidth, chartHeight);
  } else if (pendingRenders.has(chartId)) {
    if (cached) {
      ctx.drawImage(cached.canvas, canvasX, canvasY, chartWidth, chartHeight);
    } else {
      drawPlaceholder(ctx, canvasX, canvasY, chartWidth, chartHeight, chart.name);
    }
  } else {
    if (cached) {
      ctx.drawImage(cached.canvas, canvasX, canvasY, chartWidth, chartHeight);
    } else {
      drawPlaceholder(ctx, canvasX, canvasY, chartWidth, chartHeight, chart.name);
    }
    renderChartAsync(chartId, pxWidth, pxHeight, chartWidth, chartHeight, dpr, currentVersion);
  }

  // 3. Draw selection highlights (series/data point dimming + outlines)
  const cachedData = chartDataCache.get(chartId);
  if (isChartSelected(chartId) && cachedData) {
    const subSel = getSubSelection();
    if (subSel.level === "series" || subSel.level === "dataPoint") {
      drawSelectionHighlights(ctx, canvasX, canvasY, cachedData, chart.spec, subSel.level, subSel.seriesIndex, subSel.categoryIndex);
    }
  }

  // 4. Draw border
  ctx.strokeStyle = "#d0d0d0";
  ctx.lineWidth = 1;
  ctx.setLineDash([]);
  ctx.strokeRect(
    Math.floor(canvasX) + 0.5,
    Math.floor(canvasY) + 0.5,
    chartWidth - 1,
    chartHeight - 1,
  );

  // 5. Draw selection border if chart is selected
  if (isChartSelected(chartId)) {
    ctx.strokeStyle = "#0e639c";
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.strokeRect(canvasX + 1, canvasY + 1, chartWidth - 2, chartHeight - 2);

    // Resize handles at corners
    drawResizeHandles(ctx, canvasX, canvasY, chartWidth, chartHeight);
  }

  // 6. Draw tooltip (always on top)
  if (hoverState && hoverState.chartId === chartId &&
    (hoverState.hitResult.type === "bar" || hoverState.hitResult.type === "point" || hoverState.hitResult.type === "slice")) {
    drawTooltip(ctx, canvasX, canvasY, chartWidth, chartHeight, hoverState);
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

    // Fetch data from the grid and resolve cell references
    const resolved = await readChartDataResolved(chart.spec);
    const data = resolved.data;
    const spec = resolved.spec;

    // Check if version is still current (might have changed during async fetch)
    const currentVersion = chartVersions.get(chartId) ?? 0;
    if (currentVersion !== version) return;

    // Create OffscreenCanvas and paint
    const offscreen = new OffscreenCanvas(pxWidth, pxHeight);
    const offCtx = offscreen.getContext("2d");
    if (!offCtx) return;

    offCtx.scale(dpr, dpr);

    const layout = computeChartLayout(
      logicalWidth,
      logicalHeight,
      spec,
      data,
      DEFAULT_CHART_THEME,
    );

    paintChart(offCtx, data, spec, layout, DEFAULT_CHART_THEME);

    // Store in canvas cache
    chartCanvasCache.set(chartId, {
      canvas: offscreen,
      version,
      width: pxWidth,
      height: pxHeight,
    });

    // Store in data cache (separate, persists across canvas invalidation)
    const hitGeometry = computeChartHitGeometry(data, spec, layout, DEFAULT_CHART_THEME);
    chartDataCache.set(chartId, {
      data,
      layout,
      hitGeometry,
      barRects: extractBarRects(hitGeometry),
      logicalWidth,
      logicalHeight,
    });

    // Trigger a canvas redraw so the cached chart gets composited.
    requestOverlayRedraw();
  } catch (err) {
    console.error(`[Charts] Failed to render chart ${chartId}:`, err);
  } finally {
    pendingRenders.delete(chartId);
  }
}

// ============================================================================
// Selection Highlight Drawing
// ============================================================================

/**
 * Draw semi-transparent overlays to dim non-selected elements and highlight selected ones.
 * Called during the sync render pass, drawn on top of the cached chart image.
 */
function drawSelectionHighlights(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  cachedData: CachedChartData,
  spec: import("../types").ChartSpec,
  level: "series" | "dataPoint",
  selSeriesIndex?: number,
  selCategoryIndex?: number,
): void {
  const { hitGeometry } = cachedData;

  if (hitGeometry.type === "bars") {
    drawBarSelectionHighlights(ctx, chartX, chartY, hitGeometry.rects, level, selSeriesIndex, selCategoryIndex);
  } else if (hitGeometry.type === "points") {
    drawPointSelectionHighlights(ctx, chartX, chartY, hitGeometry.markers, level, selSeriesIndex, selCategoryIndex);
  } else if (hitGeometry.type === "slices") {
    drawSliceSelectionHighlights(ctx, chartX, chartY, hitGeometry.arcs, level, selSeriesIndex);
  } else if (hitGeometry.type === "composite") {
    for (const group of hitGeometry.groups) {
      if (group.type === "bars") {
        drawBarSelectionHighlights(ctx, chartX, chartY, group.rects, level, selSeriesIndex, selCategoryIndex);
      } else if (group.type === "points") {
        drawPointSelectionHighlights(ctx, chartX, chartY, group.markers, level, selSeriesIndex, selCategoryIndex);
      }
    }
  }
}

function drawBarSelectionHighlights(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  barRects: BarRect[],
  level: "series" | "dataPoint",
  selSeriesIndex?: number,
  selCategoryIndex?: number,
): void {
  if (barRects.length === 0) return;

  for (const bar of barRects) {
    const bx = chartX + bar.x;
    const by = chartY + bar.y;

    const isSelected =
      level === "series"
        ? bar.seriesIndex === selSeriesIndex
        : bar.seriesIndex === selSeriesIndex && bar.categoryIndex === selCategoryIndex;

    if (isSelected) {
      ctx.strokeStyle = "#0e639c";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.strokeRect(bx, by, bar.width, bar.height);
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
      ctx.fillRect(bx, by, bar.width, bar.height);
    }
  }

  // Draw selection handles on selected bars (small squares at corners)
  if (level === "dataPoint" && selSeriesIndex != null && selCategoryIndex != null) {
    const selectedBar = barRects.find(
      (b) => b.seriesIndex === selSeriesIndex && b.categoryIndex === selCategoryIndex,
    );
    if (selectedBar) {
      drawElementSelectionHandles(ctx, chartX + selectedBar.x, chartY + selectedBar.y, selectedBar.width, selectedBar.height);
    }
  }
}

function drawPointSelectionHighlights(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  markers: import("../types").PointMarker[],
  level: "series" | "dataPoint",
  selSeriesIndex?: number,
  selCategoryIndex?: number,
): void {
  if (markers.length === 0) return;

  for (const marker of markers) {
    const mx = chartX + marker.cx;
    const my = chartY + marker.cy;

    const isSelected =
      level === "series"
        ? marker.seriesIndex === selSeriesIndex
        : marker.seriesIndex === selSeriesIndex && marker.categoryIndex === selCategoryIndex;

    if (isSelected) {
      ctx.strokeStyle = "#0e639c";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(mx, my, marker.radius + 3, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
      ctx.beginPath();
      ctx.arc(mx, my, marker.radius + 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawSliceSelectionHighlights(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  arcs: import("../types").SliceArc[],
  level: "series" | "dataPoint",
  selSeriesIndex?: number,
): void {
  if (arcs.length === 0) return;

  for (const arc of arcs) {
    const isSelected = arc.seriesIndex === selSeriesIndex;

    if (!isSelected) {
      // Dim non-selected slices
      ctx.fillStyle = "rgba(255, 255, 255, 0.55)";
      ctx.beginPath();
      ctx.moveTo(chartX + arc.centerX, chartY + arc.centerY);
      ctx.arc(
        chartX + arc.centerX,
        chartY + arc.centerY,
        arc.outerRadius,
        arc.startAngle,
        arc.endAngle,
      );
      ctx.closePath();
      ctx.fill();
    } else {
      // Highlight selected slice
      ctx.strokeStyle = "#0e639c";
      ctx.lineWidth = 2;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(
        chartX + arc.centerX,
        chartY + arc.centerY,
        arc.outerRadius + 2,
        arc.startAngle,
        arc.endAngle,
      );
      ctx.stroke();
    }
  }
}

/**
 * Draw small selection handles at corners and midpoints.
 */
function drawElementSelectionHandles(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const size = 5;
  const half = size / 2;
  ctx.fillStyle = "#0e639c";

  // Four corners
  ctx.fillRect(x - half, y - half, size, size);
  ctx.fillRect(x + w - half, y - half, size, size);
  ctx.fillRect(x - half, y + h - half, size, size);
  ctx.fillRect(x + w - half, y + h - half, size, size);

  // Midpoints of top and bottom edges
  ctx.fillRect(x + w / 2 - half, y - half, size, size);
  ctx.fillRect(x + w / 2 - half, y + h - half, size, size);
}

// ============================================================================
// Tooltip Drawing
// ============================================================================

/**
 * Draw a tooltip near the hovered element showing series name, category, and value.
 * Drawn on the main canvas during the sync render pass.
 */
function drawTooltip(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  chartWidth: number,
  chartHeight: number,
  hover: NonNullable<typeof hoverState>,
): void {
  const { hitResult, canvasX, canvasY } = hover;

  const seriesName = hitResult.seriesName ?? "";
  const categoryName = hitResult.categoryName ?? "";
  const value = hitResult.value ?? 0;
  const valueStr = formatTickValue(value);

  const font = "11px 'Segoe UI', system-ui, sans-serif";
  const boldFont = "600 11px 'Segoe UI', system-ui, sans-serif";
  const lineHeight = 16;
  const paddingX = 10;
  const paddingY = 8;
  const offsetX = 12;
  const offsetY = -20;

  // Measure text widths
  ctx.font = boldFont;
  const nameWidth = ctx.measureText(seriesName).width;
  ctx.font = font;
  const detailText = `${categoryName}: ${valueStr}`;
  const detailWidth = ctx.measureText(detailText).width;

  const tooltipWidth = Math.max(nameWidth, detailWidth) + paddingX * 2;
  const tooltipHeight = lineHeight * 2 + paddingY * 2;

  // Position: offset from cursor, clamped within chart bounds
  let tx = canvasX + offsetX;
  let ty = canvasY + offsetY - tooltipHeight;

  // Clamp to chart bounds
  const chartRight = chartX + chartWidth;
  const chartBottom = chartY + chartHeight;

  if (tx + tooltipWidth > chartRight) {
    tx = canvasX - offsetX - tooltipWidth;
  }
  if (tx < chartX) {
    tx = chartX + 4;
  }
  if (ty < chartY) {
    ty = canvasY + 20;
  }
  if (ty + tooltipHeight > chartBottom) {
    ty = chartBottom - tooltipHeight - 4;
  }

  // Draw shadow
  ctx.save();
  ctx.shadowColor = "rgba(0, 0, 0, 0.15)";
  ctx.shadowBlur = 8;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 2;

  // Draw rounded rect background
  const radius = 4;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.moveTo(tx + radius, ty);
  ctx.lineTo(tx + tooltipWidth - radius, ty);
  ctx.quadraticCurveTo(tx + tooltipWidth, ty, tx + tooltipWidth, ty + radius);
  ctx.lineTo(tx + tooltipWidth, ty + tooltipHeight - radius);
  ctx.quadraticCurveTo(tx + tooltipWidth, ty + tooltipHeight, tx + tooltipWidth - radius, ty + tooltipHeight);
  ctx.lineTo(tx + radius, ty + tooltipHeight);
  ctx.quadraticCurveTo(tx, ty + tooltipHeight, tx, ty + tooltipHeight - radius);
  ctx.lineTo(tx, ty + radius);
  ctx.quadraticCurveTo(tx, ty, tx + radius, ty);
  ctx.closePath();
  ctx.fill();

  ctx.restore(); // remove shadow for text and border

  // Draw border
  ctx.strokeStyle = "#e0e0e0";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(tx + radius, ty);
  ctx.lineTo(tx + tooltipWidth - radius, ty);
  ctx.quadraticCurveTo(tx + tooltipWidth, ty, tx + tooltipWidth, ty + radius);
  ctx.lineTo(tx + tooltipWidth, ty + tooltipHeight - radius);
  ctx.quadraticCurveTo(tx + tooltipWidth, ty + tooltipHeight, tx + tooltipWidth - radius, ty + tooltipHeight);
  ctx.lineTo(tx + radius, ty + tooltipHeight);
  ctx.quadraticCurveTo(tx, ty + tooltipHeight, tx, ty + tooltipHeight - radius);
  ctx.lineTo(tx, ty + radius);
  ctx.quadraticCurveTo(tx, ty, tx + radius, ty);
  ctx.closePath();
  ctx.stroke();

  // Draw color swatch
  const swatchSize = 8;
  const swatchX = tx + paddingX;
  const swatchY = ty + paddingY + (lineHeight - swatchSize) / 2;
  const chart = getChartById(hover.chartId);
  if (chart && hitResult.seriesIndex != null) {
    const color = getSeriesColor(
      chart.spec.palette,
      hitResult.seriesIndex,
      chart.spec.series[hitResult.seriesIndex]?.color ?? null,
    );
    ctx.fillStyle = color;
    ctx.fillRect(swatchX, swatchY, swatchSize, swatchSize);
  }

  // Draw series name (bold)
  ctx.fillStyle = "#333333";
  ctx.font = boldFont;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(seriesName, swatchX + swatchSize + 5, ty + paddingY);

  // Draw category: value
  ctx.font = font;
  ctx.fillStyle = "#666666";
  ctx.fillText(detailText, tx + paddingX, ty + paddingY + lineHeight);
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
