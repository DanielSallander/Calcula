//! FILENAME: app/extensions/Charts/index.ts
// PURPOSE: Chart extension entry point.
// CONTEXT: Registers all chart functionality with the extension system.
//          Charts are free-floating overlays that can be moved and resized.
//          Handles mousemove for tooltips and deferred clicks for hierarchical selection.

import {
  ExtensionRegistry,
  DialogExtensions,
  onAppEvent,
  AppEvents,
} from "../../src/api";
import {
  registerGridOverlay,
  removeGridRegionsByType,
  type OverlayRenderContext,
} from "../../src/api/gridOverlays";
import { emitAppEvent } from "../../src/api/events";

import {
  ChartManifest,
  ChartDialogDefinition,
  CHART_DIALOG_ID,
} from "./manifest";

import {
  handleSelectionChange,
  resetSelectionHandlerState,
  selectChart,
  isChartSelected,
  advanceSelection,
  resetSubSelection,
  setPendingClick,
  clearPendingClick,
  consumePendingClick,
} from "./handlers/selectionHandler";
import {
  resetChartStore,
  syncChartRegions,
  getAllCharts,
  moveChart,
  resizeChart,
} from "./lib/chartStore";
import {
  renderChart,
  hitTestChart,
  invalidateChartCache,
  invalidateAllChartCaches,
  handleChartMouseMove,
  handleChartMouseLeave,
  getChartLocalCoords,
  getCachedChartData,
} from "./rendering/chartRenderer";
import { hitTestBarChart } from "./rendering/chartHitTesting";
import { ChartEvents } from "./lib/chartEvents";

// ============================================================================
// Extension Lifecycle
// ============================================================================

let cleanupFunctions: Array<() => void> = [];

/** Cached reference to the grid container element for coordinate conversion. */
let gridContainer: HTMLElement | null = null;

/** Last known mouse position in canvas coordinates. */
let lastCanvasX = 0;
let lastCanvasY = 0;

/** requestAnimationFrame guard for throttling mousemove redraws. */
let rafPending = false;

/**
 * Register the chart extension.
 * Call this during application initialization.
 */
export function registerChartExtension(): void {
  console.log("[Chart Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(ChartManifest);

  // Register dialog
  DialogExtensions.registerDialog(ChartDialogDefinition);

  // Register grid overlay renderer for charts
  cleanupFunctions.push(
    registerGridOverlay({
      type: "chart",
      render: (ctx: OverlayRenderContext) => {
        renderChart(ctx);
      },
      hitTest: hitTestChart,
      priority: 15, // Above table (5) and pivot (10)
    }),
  );

  // Sync chart regions when charts change
  const handleChartChanged = () => {
    syncChartRegions();
  };
  window.addEventListener(ChartEvents.CHART_CREATED, handleChartChanged);
  window.addEventListener(ChartEvents.CHART_UPDATED, handleChartChanged);
  window.addEventListener(ChartEvents.CHART_DELETED, handleChartChanged);
  cleanupFunctions.push(() => {
    window.removeEventListener(ChartEvents.CHART_CREATED, handleChartChanged);
    window.removeEventListener(ChartEvents.CHART_UPDATED, handleChartChanged);
    window.removeEventListener(ChartEvents.CHART_DELETED, handleChartChanged);
  });

  // Listen for data changes to invalidate chart caches
  cleanupFunctions.push(
    onAppEvent(AppEvents.CELLS_UPDATED, () => {
      // For simplicity, invalidate all chart caches when any cell changes.
      // A future optimization could check if changed cells overlap chart data ranges.
      const charts = getAllCharts();
      if (charts.length > 0) {
        invalidateAllChartCaches();
        resetSubSelection();
        emitAppEvent(AppEvents.GRID_REFRESH);
      }
    }),
  );

  // -----------------------------------------------------------------------
  // Floating Object Events (move/resize from Core mouse handlers)
  // -----------------------------------------------------------------------

  // Handle floating object selection (mousedown on chart body)
  const handleFloatingSelected = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "chart") return;
    const chartId = detail.data?.chartId as number;
    if (chartId == null) return;

    if (isChartSelected(chartId)) {
      // Chart is already selected: set pending click for deferred sub-selection.
      // The actual sub-selection advance happens on mouseup (if not a drag).
      setPendingClick(chartId, lastCanvasX, lastCanvasY);
    } else {
      // First click: select the chart (Level 1)
      selectChart(chartId);
    }
    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("floatingObject:selected", handleFloatingSelected);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:selected", handleFloatingSelected);
  });

  // Handle floating object move preview (live position update during drag)
  const handleMovePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "chart") return;
    const chartId = detail.data?.chartId as number;
    if (chartId != null) {
      // Clear pending click - this is a drag, not a click
      clearPendingClick();
      moveChart(chartId, detail.x, detail.y);
      syncChartRegions();
      emitAppEvent(AppEvents.GRID_REFRESH);
    }
  };
  window.addEventListener("floatingObject:movePreview", handleMovePreview);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:movePreview", handleMovePreview);
  });

  // Handle floating object move complete
  const handleMoveComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "chart") return;
    const chartId = detail.data?.chartId as number;
    if (chartId != null) {
      // Clear pending click - move completed, not a click
      clearPendingClick();
      moveChart(chartId, detail.x, detail.y);
      syncChartRegions();
      invalidateChartCache(chartId);
      emitAppEvent(AppEvents.GRID_REFRESH);
    }
  };
  window.addEventListener("floatingObject:moveComplete", handleMoveComplete);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:moveComplete", handleMoveComplete);
  });

  // Handle floating object resize preview (live size update during drag)
  // NOTE: We do NOT invalidate the chart cache here. The renderer will stretch
  // the existing cached image to the new dimensions for instant visual feedback.
  // The cache is only invalidated on resizeComplete to trigger a proper re-render.
  const handleResizePreview = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "chart") return;
    const chartId = detail.data?.chartId as number;
    if (chartId != null) {
      resizeChart(chartId, detail.x, detail.y, detail.width, detail.height);
      syncChartRegions();
      emitAppEvent(AppEvents.GRID_REFRESH);
    }
  };
  window.addEventListener("floatingObject:resizePreview", handleResizePreview);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:resizePreview", handleResizePreview);
  });

  // Handle floating object resize complete
  const handleResizeComplete = (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (detail.regionType !== "chart") return;
    const chartId = detail.data?.chartId as number;
    if (chartId != null) {
      resizeChart(chartId, detail.x, detail.y, detail.width, detail.height);
      syncChartRegions();
      invalidateChartCache(chartId);
      emitAppEvent(AppEvents.GRID_REFRESH);
    }
  };
  window.addEventListener("floatingObject:resizeComplete", handleResizeComplete);
  cleanupFunctions.push(() => {
    window.removeEventListener("floatingObject:resizeComplete", handleResizeComplete);
  });

  // Subscribe to selection changes (deselect chart when user clicks on grid)
  cleanupFunctions.push(
    ExtensionRegistry.onSelectionChange(handleSelectionChange),
  );

  // -----------------------------------------------------------------------
  // Mousemove for Tooltips
  // -----------------------------------------------------------------------

  const handleMouseMove = (e: MouseEvent) => {
    // Find the grid container if not cached yet
    if (!gridContainer) {
      gridContainer = document.querySelector("canvas")?.parentElement ?? null;
    }
    if (!gridContainer) return;

    const rect = gridContainer.getBoundingClientRect();

    // Convert to canvas-relative coordinates
    const canvasX = e.clientX - rect.left;
    const canvasY = e.clientY - rect.top;

    // Store last position for use in click handler
    lastCanvasX = canvasX;
    lastCanvasY = canvasY;

    // Skip if mouse is outside the grid container
    if (canvasX < 0 || canvasY < 0 || canvasX > rect.width || canvasY > rect.height) {
      handleChartMouseLeave();
      return;
    }

    // Throttle: only process one mousemove per animation frame
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => {
        rafPending = false;
        handleChartMouseMove(lastCanvasX, lastCanvasY);
      });
    }
  };
  window.addEventListener("mousemove", handleMouseMove);
  cleanupFunctions.push(() => {
    window.removeEventListener("mousemove", handleMouseMove);
  });

  // -----------------------------------------------------------------------
  // Mouseup for Deferred Click Detection (hierarchical selection)
  // -----------------------------------------------------------------------

  const handleMouseUp = () => {
    const click = consumePendingClick();
    if (!click) return;

    // A click (not a drag) occurred on an already-selected chart.
    // Hit-test to determine what sub-element was clicked.
    const cachedData = getCachedChartData(click.chartId);
    if (!cachedData) return;

    const local = getChartLocalCoords(click.chartId, click.canvasX, click.canvasY);
    if (!local) return;

    const hitResult = hitTestBarChart(local.localX, local.localY, cachedData.barRects, cachedData.layout);
    advanceSelection(click.chartId, hitResult);
    emitAppEvent(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("mouseup", handleMouseUp);
  cleanupFunctions.push(() => {
    window.removeEventListener("mouseup", handleMouseUp);
  });

  console.log("[Chart Extension] Registered successfully");
}

/**
 * Unregister the chart extension.
 * Call this during application shutdown or hot reload.
 */
export function unregisterChartExtension(): void {
  console.log("[Chart Extension] Unregistering...");

  // Cleanup event listeners
  cleanupFunctions.forEach((fn) => fn());
  cleanupFunctions = [];

  // Reset handler state
  resetSelectionHandlerState();
  resetChartStore();
  gridContainer = null;

  // Remove chart overlay regions
  removeGridRegionsByType("chart");

  // Unregister from extension registries
  ExtensionRegistry.unregisterAddIn(ChartManifest.id);
  DialogExtensions.unregisterDialog(CHART_DIALOG_ID);

  console.log("[Chart Extension] Unregistered successfully");
}

// Re-export for convenience
export { CHART_DIALOG_ID };
