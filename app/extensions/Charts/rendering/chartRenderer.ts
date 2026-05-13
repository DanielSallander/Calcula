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
} from "@api/gridOverlays";

import { getChartById, getAllCharts, getActiveSheetIndex } from "../lib/chartStore";
import { readChartDataResolved } from "../lib/chartDataReader";
import { dispatchPaint, dispatchComputeLayout, dispatchComputeGeometry, extractBarRects } from "./chartDispatch";
import { DEFAULT_CHART_THEME, resolveChartTheme } from "./chartTheme";
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
  TooltipSpec,
  PivotChartFieldButton,
  PivotChartFieldInfo,
} from "../types";
import { isPivotDataSource } from "../types";
import { fetchPivotChartFields } from "../lib/pivotChartDataReader";
import {
  computeQuickAccessButtons,
  drawQuickAccessButtons,
  hitTestQuickAccessButtons,
  setHoveredButton,
  getHoveredButton,
  isInQuickAccessArea,
  type QuickAccessButton,
  type QuickAccessButtonType,
} from "./quickAccessButtons";

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
  /** Pivot chart field buttons (only present for pivot-sourced charts). */
  pivotFieldButtons?: PivotChartFieldButton[];
  /** Unfiltered data: all series and categories before chart filters applied.
   *  Used by the filter dropdown to show all available options. */
  unfilteredData?: ParsedChartData;
  /** Quick access button positions (computed during render, used for hit-testing). */
  quickAccessButtons?: QuickAccessButton[];
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
 * Returns true if the mouse is currently hovering over a filter button.
 */
export function isHoveringFilterButton(): boolean {
  return hoverState !== null && hoverState.hitResult.type === "filterButton";
}

/**
 * Returns true if the mouse is currently hovering over a quick access button.
 */
export function isHoveringQuickAccessButton(): boolean {
  return getHoveredButton() !== null;
}

/**
 * Returns true if the mouse is currently hovering over an axis region.
 */
export function isHoveringAxis(): boolean {
  return hoverState !== null && hoverState.hitResult.type === "axis";
}

/**
 * Get the current hover state (for context menu).
 */
export function getHoverState(): typeof hoverState {
  return hoverState;
}

/**
 * Returns true if the mouse is currently hovering over a data element (bar, point, slice).
 */
export function isHoveringDataElement(): boolean {
  if (!hoverState) return false;
  const t = hoverState.hitResult.type;
  return t === "bar" || t === "point" || t === "slice";
}

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
        // First check pivot field buttons (they are drawn on top)
        const buttonHit = hitTestPivotFieldButtons(localX, localY, cachedData.pivotFieldButtons);
        if (buttonHit) {
          const changed =
            hoverState === null ||
            hoverState.chartId !== chartId ||
            hoverState.hitResult.type !== "filterButton";
          hoverState = { chartId, hitResult: buttonHit, canvasX, canvasY };
          if (changed) requestOverlayRedraw();
          foundHover = true;
          break;
        }

        const hitResult = hitTestGeometry(localX, localY, cachedData.hitGeometry, cachedData.layout);

        if (hitResult.type === "bar" || hitResult.type === "point" || hitResult.type === "slice" || hitResult.type === "axis") {
          const changed =
            hoverState === null ||
            hoverState.chartId !== chartId ||
            hoverState.hitResult.type !== hitResult.type ||
            hoverState.hitResult.seriesIndex !== hitResult.seriesIndex ||
            hoverState.hitResult.categoryIndex !== hitResult.categoryIndex ||
            hoverState.hitResult.axisType !== hitResult.axisType;

          hoverState = { chartId, hitResult, canvasX, canvasY };
          if (changed) requestOverlayRedraw();
          foundHover = true;
          break;
        }
      }
    }
  }

  // Check quick access buttons (outside chart bounds, for selected charts)
  if (!foundHover) {
    for (const region of regions) {
      if (!region.floating) continue;
      const chartId = region.data?.chartId as number;
      if (chartId == null || !isChartSelected(chartId)) continue;

      const cachedData = chartDataCache.get(chartId);
      if (!cachedData?.quickAccessButtons) continue;

      const btnHit = hitTestQuickAccessButtons(canvasX, canvasY, cachedData.quickAccessButtons);
      if (btnHit) {
        if (getHoveredButton() !== btnHit) {
          setHoveredButton(btnHit);
          requestOverlayRedraw();
        }
        foundHover = true;
        break;
      }
    }
  }

  // Clear quick access hover if not over a button
  if (!foundHover || (foundHover && hoverState)) {
    if (getHoveredButton() !== null) {
      setHoveredButton(null);
      requestOverlayRedraw();
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
// Chart Painter Dispatch (delegated to chartDispatch.ts)
// ============================================================================

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
    } else if (subSel.level === "axis" && subSel.axisType) {
      drawAxisSelectionHighlight(ctx, canvasX, canvasY, cachedData.layout, subSel.axisType);
    }
  }

  // 3b. Draw pivot chart field buttons (filter dropdowns)
  if (cachedData?.pivotFieldButtons && cachedData.pivotFieldButtons.length > 0) {
    drawPivotFieldButtons(ctx, canvasX, canvasY, cachedData.pivotFieldButtons);
  }

  // 3c. Draw filter active indicator (small funnel badge in top-right)
  if (chart.spec.filters) {
    const f = chart.spec.filters;
    const hiddenCount = (f.hiddenSeries?.length ?? 0) + (f.hiddenCategories?.length ?? 0);
    if (hiddenCount > 0) {
      drawFilterIndicator(ctx, canvasX + chartWidth - 28, canvasY + 6, hiddenCount);
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

    // Quick access buttons (to the right of chart)
    const qaButtons = computeQuickAccessButtons(canvasX, canvasY, chartWidth, chartHeight);
    drawQuickAccessButtons(ctx, qaButtons);

    // Store for hit-testing
    if (cachedData) {
      cachedData.quickAccessButtons = qaButtons;
    }
  }

  // 6. Draw tooltip (always on top)
  if (hoverState && hoverState.chartId === chartId &&
    (hoverState.hitResult.type === "bar" || hoverState.hitResult.type === "point" || hoverState.hitResult.type === "slice")) {
    const tooltipChart = getChartById(chartId);
    if (!tooltipChart?.spec.tooltip || tooltipChart.spec.tooltip.enabled !== false) {
      drawTooltip(ctx, canvasX, canvasY, chartWidth, chartHeight, hoverState, tooltipChart?.spec.tooltip);
    }
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

    // Standard chart bounds check
    const inChart =
      hitCtx.canvasX >= b.x &&
      hitCtx.canvasX <= b.x + b.width &&
      hitCtx.canvasY >= b.y &&
      hitCtx.canvasY <= b.y + b.height;

    if (inChart) return true;

    // Extended bounds: check quick access buttons area to the right
    // (only when this chart is selected)
    const chartId = hitCtx.region.data?.chartId as number;
    if (chartId != null && isChartSelected(chartId)) {
      return isInQuickAccessArea(
        hitCtx.canvasX,
        hitCtx.canvasY,
        b.x,
        b.y,
        b.width,
        b.height,
      );
    }

    return false;
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

    // Skip rendering if the chart's sheet isn't the active sheet.
    // getViewportCells only reads from the active sheet, so rendering
    // a chart for an inactive sheet would produce wrong data.
    if (chart.sheetIndex !== getActiveSheetIndex()) return;

    // Fetch data from the grid and resolve cell references
    const resolved = await readChartDataResolved(chart.spec);
    const data = resolved.data;
    const spec = resolved.spec;
    const unfilteredData = resolved.unfilteredData;

    // Check if version is still current (might have changed during async fetch)
    const currentVersion = chartVersions.get(chartId) ?? 0;
    if (currentVersion !== version) return;

    // Create OffscreenCanvas and paint
    const offscreen = new OffscreenCanvas(pxWidth, pxHeight);
    const offCtx = offscreen.getContext("2d");
    if (!offCtx) return;

    offCtx.scale(dpr, dpr);

    const theme = resolveChartTheme(spec.config);

    // Fetch pivot field metadata BEFORE layout so we can reserve margin space
    let pivotFields: PivotChartFieldInfo[] | undefined;
    if (isPivotDataSource(spec.data)) {
      pivotFields = await fetchPivotChartFields(spec.data.pivotId);
      if (pivotFields.length === 0) pivotFields = undefined;
    }

    const layout = dispatchComputeLayout(
      logicalWidth,
      logicalHeight,
      spec,
      data,
      theme,
    );

    // Inflate margins to make room for pivot field buttons
    if (pivotFields && pivotFields.length > 0) {
      adjustLayoutForPivotButtons(layout, pivotFields);
    }

    dispatchPaint(offCtx, data, spec, layout, theme);

    // Store in canvas cache
    chartCanvasCache.set(chartId, {
      canvas: offscreen,
      version,
      width: pxWidth,
      height: pxHeight,
    });

    // Store in data cache (separate, persists across canvas invalidation)
    const hitGeometry = dispatchComputeGeometry(data, spec, layout, theme);

    // Compute button positions using the adjusted layout
    let pivotFieldButtons: PivotChartFieldButton[] | undefined;
    if (pivotFields) {
      pivotFieldButtons = computePivotFieldButtons(pivotFields, layout, spec);
    }

    chartDataCache.set(chartId, {
      data,
      layout,
      hitGeometry,
      barRects: extractBarRects(hitGeometry),
      logicalWidth,
      logicalHeight,
      pivotFieldButtons,
      unfilteredData,
    });

    // Trigger a canvas redraw so the cached chart gets composited.
    requestOverlayRedraw();
    // Also emit grid refresh to ensure main canvas repaints
    window.dispatchEvent(new Event("app:grid-refresh"));
  } catch (err) {
    console.error(`[Charts] Failed to render chart ${chartId}:`, err, (err as Error)?.stack);
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
  tooltipConfig?: TooltipSpec,
): void {
  const { hitResult, canvasX, canvasY } = hover;

  const seriesName = hitResult.seriesName ?? "";
  const categoryName = hitResult.categoryName ?? "";
  const value = hitResult.value ?? 0;

  // Determine which fields to show
  const fields = tooltipConfig?.fields ?? ["series", "category", "value"];
  const showSeries = fields.includes("series");
  const showCategory = fields.includes("category");
  const showValue = fields.includes("value");

  // Format value using custom format if provided, otherwise default
  const valueFormat = tooltipConfig?.format?.["value"];
  const valueStr = valueFormat ? formatTooltipNumber(value, valueFormat) : formatTickValue(value);

  const font = "11px 'Segoe UI', system-ui, sans-serif";
  const boldFont = "600 11px 'Segoe UI', system-ui, sans-serif";
  const lineHeight = 16;
  const paddingX = 10;
  const paddingY = 8;
  const offsetX = 12;
  const offsetY = -20;

  // Build tooltip lines
  const lines: Array<{ text: string; bold: boolean }> = [];
  if (showSeries && seriesName) {
    lines.push({ text: seriesName, bold: true });
  }
  // Detail line: category and/or value
  const detailParts: string[] = [];
  if (showCategory && categoryName) detailParts.push(categoryName);
  if (showValue) detailParts.push(valueStr);
  if (detailParts.length > 0) {
    lines.push({ text: detailParts.join(": "), bold: false });
  }

  if (lines.length === 0) return;

  // Measure text widths
  let maxLineWidth = 0;
  for (const line of lines) {
    ctx.font = line.bold ? boldFont : font;
    const w = ctx.measureText(line.text).width;
    if (w > maxLineWidth) maxLineWidth = w;
  }

  const tooltipWidth = maxLineWidth + paddingX * 2 + (showSeries ? 13 : 0); // 13 = swatch + gap
  const tooltipHeight = lineHeight * lines.length + paddingY * 2;

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

  // Draw color swatch (next to first line if series is shown)
  const swatchSize = 8;
  const swatchX = tx + paddingX;
  let textStartX = tx + paddingX;
  const chart = getChartById(hover.chartId);
  if (showSeries && chart && hitResult.seriesIndex != null) {
    const swatchY = ty + paddingY + (lineHeight - swatchSize) / 2;
    const color = getSeriesColor(
      chart.spec.palette,
      hitResult.seriesIndex,
      chart.spec.series[hitResult.seriesIndex]?.color ?? null,
    );
    ctx.fillStyle = color;
    ctx.fillRect(swatchX, swatchY, swatchSize, swatchSize);
    textStartX = swatchX + swatchSize + 5;
  }

  // Draw tooltip lines
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    ctx.font = line.bold ? boldFont : font;
    ctx.fillStyle = line.bold ? "#333333" : "#666666";
    const lx = (i === 0 && showSeries) ? textStartX : tx + paddingX;
    ctx.fillText(line.text, lx, ty + paddingY + i * lineHeight);
  }
}

/**
 * Format a number using a simple format string for tooltips.
 * Supports patterns like "$,.2f", ",.0f", "%".
 */
function formatTooltipNumber(value: number, fmt: string): string {
  const trimmed = fmt.trim();

  // Percentage
  if (trimmed === "%") {
    return (value * 100).toFixed(1) + "%";
  }

  // Extract prefix, comma flag, and decimal spec
  let prefix = "";
  let rest = trimmed;

  // Leading non-numeric characters are prefix (e.g., "$")
  const prefixMatch = rest.match(/^([^,.\d]*)/);
  if (prefixMatch && prefixMatch[1]) {
    prefix = prefixMatch[1];
    rest = rest.slice(prefix.length);
  }

  const useComma = rest.includes(",");
  rest = rest.replace(",", "");

  // Extract decimal places from ".Nf" pattern
  const decMatch = rest.match(/\.(\d+)f?/);
  const decimals = decMatch ? parseInt(decMatch[1], 10) : 2;

  let result = value.toFixed(decimals);

  // Add comma grouping
  if (useComma) {
    const parts = result.split(".");
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    result = parts.join(".");
  }

  return prefix + result;
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

/**
 * Draw a selection highlight around an axis region.
 * Draws a blue semi-transparent overlay + border around the selected axis area.
 */
function drawAxisSelectionHighlight(
  ctx: CanvasRenderingContext2D,
  chartCanvasX: number,
  chartCanvasY: number,
  layout: ChartLayout,
  axisType: "x" | "y",
): void {
  const pa = layout.plotArea;
  ctx.save();

  let x: number, y: number, w: number, h: number;

  if (axisType === "x") {
    // X axis region: below the plot area
    x = chartCanvasX + pa.x;
    y = chartCanvasY + pa.y + pa.height;
    w = pa.width;
    h = layout.margin.bottom;
  } else {
    // Y axis region: to the left of the plot area
    x = chartCanvasX;
    y = chartCanvasY + pa.y;
    w = pa.x;
    h = pa.height;
  }

  // Blue semi-transparent fill
  ctx.fillStyle = "rgba(14, 99, 156, 0.08)";
  ctx.fillRect(x, y, w, h);

  // Blue dashed border
  ctx.strokeStyle = "#0e639c";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
  ctx.setLineDash([]);

  ctx.restore();
}

/**
 * Draw a small filter indicator badge (funnel icon + count).
 * Shown in the top-right corner of charts that have active filters.
 */
function drawFilterIndicator(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  hiddenCount: number,
): void {
  const w = 20;
  const h = 16;
  const r = 3;

  ctx.save();

  // Background pill
  ctx.fillStyle = "rgba(0, 95, 184, 0.85)";
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
  ctx.fill();

  // Funnel icon (simple V shape)
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(x + 3, y + 4);
  ctx.lineTo(x + 8, y + 9);
  ctx.lineTo(x + 8, y + 12);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(x + 13, y + 4);
  ctx.lineTo(x + 8, y + 9);
  ctx.stroke();

  // Count text
  if (hiddenCount > 0) {
    ctx.fillStyle = "#fff";
    ctx.font = "bold 8px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(String(hiddenCount), x + 14, y + h / 2);
  }

  ctx.restore();
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

// ============================================================================
// PivotChart Field Buttons
// ============================================================================

const FIELD_BTN_HEIGHT = 20;
const FIELD_BTN_PADDING_X = 6;
const FIELD_BTN_FONT = "11px 'Segoe UI', system-ui, sans-serif";
const FIELD_BTN_ARROW_WIDTH = 12;
const FIELD_BTN_GAP = 4;
/** Extra margin added around the plot area for pivot field buttons. */
const FIELD_BTN_MARGIN = FIELD_BTN_HEIGHT + 10;

/**
 * Adjust the chart layout margins and plot area to reserve space for
 * pivot field buttons so they don't overlap chart content.
 */
function adjustLayoutForPivotButtons(
  layout: ChartLayout,
  fields: PivotChartFieldInfo[],
): void {
  const hasFilter = fields.some((f) => f.area === "filter");
  const hasRow = fields.some((f) => f.area === "row");
  const hasCol = fields.some((f) => f.area === "column");

  // Reserve space at the top for filter/column buttons
  if (hasFilter || hasCol) {
    layout.margin.top += FIELD_BTN_MARGIN;
    layout.plotArea.y += FIELD_BTN_MARGIN;
    layout.plotArea.height -= FIELD_BTN_MARGIN;
  }

  // Reserve space at the bottom for row (axis) buttons
  if (hasRow) {
    layout.margin.bottom += FIELD_BTN_MARGIN;
    layout.plotArea.height -= FIELD_BTN_MARGIN;
  }

  // Clamp plot area height to a minimum
  if (layout.plotArea.height < 40) {
    layout.plotArea.height = 40;
  }
}

/**
 * Compute field button positions based on their area and chart layout.
 * Buttons are placed in the reserved margin space created by adjustLayoutForPivotButtons.
 * - Filter fields: top-left, above the plot area
 * - Row fields: bottom-left, below the plot area (below X axis labels)
 * - Column fields: top-right, above the plot area
 */
function computePivotFieldButtons(
  fields: PivotChartFieldInfo[],
  layout: ChartLayout,
  spec: import("../types").ChartSpec,
): PivotChartFieldButton[] {
  const buttons: PivotChartFieldButton[] = [];

  // We need a temporary canvas to measure text
  const measureCanvas = new OffscreenCanvas(1, 1);
  const measureCtx = measureCanvas.getContext("2d");
  if (!measureCtx) return buttons;
  measureCtx.font = FIELD_BTN_FONT;

  const filterFields = fields.filter((f) => f.area === "filter");
  const rowFields = fields.filter((f) => f.area === "row");
  const colFields = fields.filter((f) => f.area === "column");

  // Filter fields: positioned at top-left, in the reserved margin above the plot area.
  // Place them well above the plot area so they don't overlap Y-axis labels.
  // The top of the reserved margin is at (plotArea.y - FIELD_BTN_MARGIN).
  const filterBaseY = layout.plotArea.y - FIELD_BTN_MARGIN;
  let filterY = filterBaseY;
  for (const field of filterFields) {
    const textWidth = measureCtx.measureText(field.name).width;
    const btnWidth = FIELD_BTN_PADDING_X * 2 + textWidth + FIELD_BTN_ARROW_WIDTH;
    buttons.push({
      field,
      x: 8,
      y: filterY,
      width: btnWidth,
      height: FIELD_BTN_HEIGHT,
    });
    filterY += FIELD_BTN_HEIGHT + FIELD_BTN_GAP;
  }

  // Row fields (Axis): positioned at bottom of chart, in the reserved margin
  let rowX = layout.plotArea.x;
  const rowY = layout.height - FIELD_BTN_HEIGHT - 4;
  for (const field of rowFields) {
    const textWidth = measureCtx.measureText(field.name).width;
    const btnWidth = FIELD_BTN_PADDING_X * 2 + textWidth + FIELD_BTN_ARROW_WIDTH;
    buttons.push({
      field,
      x: rowX,
      y: rowY,
      width: btnWidth,
      height: FIELD_BTN_HEIGHT,
    });
    rowX += btnWidth + FIELD_BTN_GAP;
  }

  // Column fields (Legend): positioned at top-right, in the reserved margin above plot area
  let colX = layout.plotArea.x + layout.plotArea.width;
  const colY = filterBaseY;
  // Position from right to left
  for (let i = colFields.length - 1; i >= 0; i--) {
    const field = colFields[i];
    const textWidth = measureCtx.measureText(field.name).width;
    const btnWidth = FIELD_BTN_PADDING_X * 2 + textWidth + FIELD_BTN_ARROW_WIDTH;
    colX -= btnWidth;
    buttons.push({
      field,
      x: colX,
      y: colY,
      width: btnWidth,
      height: FIELD_BTN_HEIGHT,
    });
    colX -= FIELD_BTN_GAP;
  }

  return buttons;
}

/**
 * Draw pivot chart field buttons on the chart canvas.
 * Each button shows the field name with a dropdown arrow.
 */
function drawPivotFieldButtons(
  ctx: CanvasRenderingContext2D,
  chartX: number,
  chartY: number,
  buttons: PivotChartFieldButton[],
): void {
  for (const btn of buttons) {
    const bx = chartX + btn.x;
    const by = chartY + btn.y;
    const filtered = btn.field.isFiltered;

    // Button background — light blue when filtered, gray when inactive
    ctx.fillStyle = filtered ? "#e8f0fe" : "#f0f0f0";
    ctx.strokeStyle = filtered ? "#1a73e8" : "#c0c0c0";
    ctx.lineWidth = 1;

    // Rounded rect
    const r = 3;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + btn.width - r, by);
    ctx.quadraticCurveTo(bx + btn.width, by, bx + btn.width, by + r);
    ctx.lineTo(bx + btn.width, by + btn.height - r);
    ctx.quadraticCurveTo(bx + btn.width, by + btn.height, bx + btn.width - r, by + btn.height);
    ctx.lineTo(bx + r, by + btn.height);
    ctx.quadraticCurveTo(bx, by + btn.height, bx, by + btn.height - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();

    // Field name text — blue when filtered
    ctx.font = FIELD_BTN_FONT;
    ctx.fillStyle = filtered ? "#1a73e8" : "#333333";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(btn.field.name, bx + FIELD_BTN_PADDING_X, by + btn.height / 2);

    // Icon area: funnel when filtered, dropdown chevron when inactive
    const iconColor = filtered ? "#1a73e8" : "#666666";
    const iconCx = bx + btn.width - FIELD_BTN_ARROW_WIDTH + 4;
    const iconCy = by + btn.height / 2;

    if (filtered) {
      // Funnel icon (matching AutoFilter active style)
      ctx.fillStyle = iconColor;
      ctx.beginPath();
      ctx.moveTo(iconCx - 5, iconCy - 4);  // Top-left
      ctx.lineTo(iconCx + 5, iconCy - 4);  // Top-right
      ctx.lineTo(iconCx + 1, iconCy);       // Narrow right
      ctx.lineTo(iconCx + 1, iconCy + 4);   // Stem right
      ctx.lineTo(iconCx - 1, iconCy + 4);   // Stem left
      ctx.lineTo(iconCx - 1, iconCy);       // Narrow left
      ctx.closePath();
      ctx.fill();
    } else {
      // Dropdown chevron arrow
      ctx.strokeStyle = iconColor;
      ctx.lineWidth = 1.5;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(iconCx - 4, iconCy - 2);
      ctx.lineTo(iconCx, iconCy + 2);
      ctx.lineTo(iconCx + 4, iconCy - 2);
      ctx.stroke();
    }
  }
}

/**
 * Hit-test a point against pivot field buttons.
 * Returns a ChartHitResult with type "filterButton" if a button is hit.
 */
function hitTestPivotFieldButtons(
  localX: number,
  localY: number,
  buttons?: PivotChartFieldButton[],
): ChartHitResult | null {
  if (!buttons || buttons.length === 0) return null;

  for (const btn of buttons) {
    if (
      localX >= btn.x &&
      localX <= btn.x + btn.width &&
      localY >= btn.y &&
      localY <= btn.y + btn.height
    ) {
      return {
        type: "filterButton",
        fieldButton: btn,
      };
    }
  }

  return null;
}
