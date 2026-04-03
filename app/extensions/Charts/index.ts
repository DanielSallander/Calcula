//! FILENAME: app/extensions/Charts/index.ts
// PURPOSE: Chart extension entry point.
// CONTEXT: Registers all chart functionality with the extension system.
//          Charts are free-floating overlays that can be moved and resized.
//          Handles mousemove for tooltips and deferred clicks for hierarchical selection.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  ExtensionRegistry,
  AppEvents,
} from "@api";
import { getActiveSheet } from "@api/lib";
import {
  removeGridRegionsByType,
  type OverlayRenderContext,
} from "@api/gridOverlays";
import { emitAppEvent } from "@api/events";

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
  deselectChart,
  getCurrentChartId,
} from "./handlers/selectionHandler";
import {
  resetChartStore,
  syncChartRegions,
  getAllCharts,
  moveChart,
  resizeChart,
  deleteChart,
  setActiveSheetIndex,
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
  isHoveringFilterButton,
  isHoveringDataElement,
  removeChartFromCache,
} from "./rendering/chartRenderer";
import { hitTestBarChart } from "./rendering/chartHitTesting";
import { ChartEvents } from "./lib/chartEvents";
import { isPivotDataSource } from "./types";
import type { PivotChartFieldButton } from "./types";
import { PivotEvents } from "../Pivot/lib/pivotEvents";

// ============================================================================
// Module State
// ============================================================================

let cleanupFunctions: Array<() => void> = [];

/** Cached reference to the grid container element for coordinate conversion. */
let gridContainer: HTMLElement | null = null;

/** Last known mouse position in canvas coordinates. */
let lastCanvasX = 0;
let lastCanvasY = 0;

/** requestAnimationFrame guard for throttling mousemove redraws. */
let rafPending = false;

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[Chart Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(ChartManifest);

  // Register dialog
  context.ui.dialogs.register(ChartDialogDefinition);

  // Register grid overlay renderer for charts
  cleanupFunctions.push(
    context.grid.overlays.register({
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
    context.events.on(AppEvents.CELLS_UPDATED, () => {
      // For simplicity, invalidate all chart caches when any cell changes.
      // A future optimization could check if changed cells overlap chart data ranges.
      const charts = getAllCharts();
      if (charts.length > 0) {
        invalidateAllChartCaches();
        resetSubSelection();
        context.events.emit(AppEvents.GRID_REFRESH);
      }
    }),
  );

  // Listen for pivot table changes to invalidate pivot-sourced chart caches
  const handlePivotChanged = () => {
    const charts = getAllCharts();
    const pivotCharts = charts.filter((c) => isPivotDataSource(c.spec.data));
    if (pivotCharts.length > 0) {
      for (const chart of pivotCharts) {
        invalidateChartCache(chart.chartId);
      }
      resetSubSelection();
      context.events.emit(AppEvents.GRID_REFRESH);
    }
  };
  window.addEventListener("pivot:refresh", handlePivotChanged);
  cleanupFunctions.push(() => {
    window.removeEventListener("pivot:refresh", handlePivotChanged);
  });

  cleanupFunctions.push(
    context.events.on(PivotEvents.PIVOT_REGIONS_UPDATED, handlePivotChanged),
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

      // Also check if the click landed on a pivot field button -
      // these should be clickable even on the first click (chart select + button click)
      const cachedData = getCachedChartData(chartId);
      if (cachedData?.pivotFieldButtons && cachedData.pivotFieldButtons.length > 0) {
        const local = getChartLocalCoords(chartId, lastCanvasX, lastCanvasY);
        if (local) {
          const btnHit = findClickedFieldButton(local.localX, local.localY, cachedData.pivotFieldButtons);
          if (btnHit) {
            setPendingClick(chartId, lastCanvasX, lastCanvasY);
          }
        }
      }
    }
    context.events.emit(AppEvents.GRID_REFRESH);
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
      context.events.emit(AppEvents.GRID_REFRESH);
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
      context.events.emit(AppEvents.GRID_REFRESH);
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
      context.events.emit(AppEvents.GRID_REFRESH);
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
      context.events.emit(AppEvents.GRID_REFRESH);
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

        // Set pointer cursor when hovering over interactive chart elements
        const canvas = gridContainer?.querySelector("canvas");
        if (canvas) {
          if (isHoveringFilterButton() || isHoveringDataElement()) {
            canvas.style.cursor = "pointer";
          } else {
            canvas.style.cursor = "";
          }
        }
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

    // Check pivot field buttons first (they take priority)
    if (cachedData.pivotFieldButtons && cachedData.pivotFieldButtons.length > 0) {
      const btnHit = findClickedFieldButton(local.localX, local.localY, cachedData.pivotFieldButtons);
      if (btnHit) {
        handlePivotFieldButtonClick(click.chartId, btnHit, click.canvasX, click.canvasY);
        return;
      }
    }

    const hitResult = hitTestBarChart(local.localX, local.localY, cachedData.barRects, cachedData.layout);
    advanceSelection(click.chartId, hitResult);
    context.events.emit(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("mouseup", handleMouseUp);
  cleanupFunctions.push(() => {
    window.removeEventListener("mouseup", handleMouseUp);
  });

  // -----------------------------------------------------------------------
  // Sheet Change: re-sync chart regions for the new active sheet
  // -----------------------------------------------------------------------

  // Set initial active sheet
  getActiveSheet().then((idx) => {
    setActiveSheetIndex(idx);
    syncChartRegions();
    context.events.emit(AppEvents.GRID_REFRESH);
  }).catch(() => {});

  cleanupFunctions.push(
    context.events.on(AppEvents.SHEET_CHANGED, async () => {
      try {
        const idx = await getActiveSheet();
        setActiveSheetIndex(idx);
        deselectChart();
        syncChartRegions();
        context.events.emit(AppEvents.GRID_REFRESH);
      } catch {
        // Ignore
      }
    }),
  );

  // -----------------------------------------------------------------------
  // Delete Key: delete selected chart
  // -----------------------------------------------------------------------

  const handleDeleteKey = (e: KeyboardEvent) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;

    // Don't intercept when editing a cell or input field
    const target = e.target as HTMLElement;
    if (
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.isContentEditable
    ) return;

    const chartId = getCurrentChartId();
    if (chartId == null) return;

    e.preventDefault();
    e.stopPropagation();

    // Delete the chart
    deselectChart();
    deleteChart(chartId);
    removeChartFromCache(chartId);
    syncChartRegions();
    window.dispatchEvent(new CustomEvent(ChartEvents.CHART_DELETED));
    context.events.emit(AppEvents.GRID_REFRESH);
  };
  document.addEventListener("keydown", handleDeleteKey, true); // capture phase
  cleanupFunctions.push(() => document.removeEventListener("keydown", handleDeleteKey, true));

  console.log("[Chart Extension] Registered successfully");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
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

  console.log("[Chart Extension] Unregistered successfully");
}

// ============================================================================
// PivotChart Field Button Click Handling
// ============================================================================

/**
 * Find which pivot field button was clicked at the given chart-local coordinates.
 */
function findClickedFieldButton(
  localX: number,
  localY: number,
  buttons: PivotChartFieldButton[],
): PivotChartFieldButton | null {
  for (const btn of buttons) {
    if (
      localX >= btn.x &&
      localX <= btn.x + btn.width &&
      localY >= btn.y &&
      localY <= btn.y + btn.height
    ) {
      return btn;
    }
  }
  return null;
}

/**
 * Handle a click on a pivot chart field button.
 * Opens the appropriate pivot filter dropdown depending on the field area.
 */
function handlePivotFieldButtonClick(
  chartId: number,
  button: PivotChartFieldButton,
  canvasX: number,
  canvasY: number,
): void {
  const chart = getAllCharts().find((c) => c.chartId === chartId);
  if (!chart || !isPivotDataSource(chart.spec.data)) return;

  const pivotId = chart.spec.data.pivotId;

  // Convert canvas coordinates to screen coordinates for the dropdown anchor
  if (!gridContainer) {
    gridContainer = document.querySelector("canvas")?.parentElement ?? null;
  }
  const rect = gridContainer?.getBoundingClientRect();
  const screenX = (rect?.left ?? 0) + canvasX;
  const screenY = (rect?.top ?? 0) + canvasY;

  if (button.field.area === "filter") {
    // Filter fields use the value filter dropdown (shows unique values with checkboxes).
    // We pass pivotId directly so the handler doesn't need cell coordinates.
    emitAppEvent(PivotEvents.PIVOT_OPEN_FILTER_MENU, {
      pivotId,
      fieldIndex: button.field.fieldIndex,
      fieldName: button.field.name,
      row: 0,
      col: 0,
      anchorX: screenX,
      anchorY: screenY + 2,
    });
  } else {
    // Row and column fields use the header filter dropdown
    const zone = button.field.area === "column" ? "column" : "row";
    emitAppEvent(PivotEvents.PIVOT_OPEN_HEADER_FILTER_MENU, {
      pivotId,
      zone,
      fieldIndex: button.field.fieldIndex,
      anchorX: screenX,
      anchorY: screenY + 2,
    });
  }
}

// ============================================================================
// Extension Module Export
// ============================================================================

const extension: ExtensionModule = {
  manifest: {
    id: "calcula.charts",
    name: "Charts",
    version: "1.0.0",
    description: "Free-floating chart overlays with interactive selection and tooltips.",
  },
  activate,
  deactivate,
};

export default extension;

// Re-export for convenience
export { CHART_DIALOG_ID };
