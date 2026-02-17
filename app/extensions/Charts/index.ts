//! FILENAME: app/extensions/Charts/index.ts
// PURPOSE: Chart extension entry point.
// CONTEXT: Registers all chart functionality with the extension system.

import {
  ExtensionRegistry,
  DialogExtensions,
  onAppEvent,
  AppEvents,
  registerEditGuard,
  registerCellClickInterceptor,
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
} from "./handlers/selectionHandler";
import {
  resetChartStore,
  syncChartRegions,
  getChartAtCell,
  getAllCharts,
  shiftChartsForRowInsert,
  shiftChartsForColInsert,
  shiftChartsForRowDelete,
  shiftChartsForColDelete,
} from "./lib/chartStore";
import { renderChart, hitTestChart, invalidateChartCache, invalidateAllChartCaches } from "./rendering/chartRenderer";
import { ChartEvents } from "./lib/chartEvents";

// ============================================================================
// Extension Lifecycle
// ============================================================================

let cleanupFunctions: Array<() => void> = [];

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

  // Register edit guard to block editing in chart regions
  cleanupFunctions.push(
    registerEditGuard(async (row: number, col: number) => {
      const chart = getChartAtCell(row, col);
      if (chart) {
        return { blocked: true, message: "Cannot edit cells occupied by a chart." };
      }
      return null;
    }),
  );

  // Register click interceptor for chart selection
  cleanupFunctions.push(
    registerCellClickInterceptor(async (row: number, col: number) => {
      const chart = getChartAtCell(row, col);
      if (chart) {
        // Selection handler will pick up the change via onSelectionChange
        return false; // Let normal selection happen so selectionHandler fires
      }
      return false;
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
        emitAppEvent(AppEvents.GRID_REFRESH);
      }
    }),
  );

  // Listen for structural changes to update chart boundaries
  cleanupFunctions.push(
    onAppEvent<{ row: number; count: number }>(AppEvents.ROWS_INSERTED, ({ row, count }) => {
      shiftChartsForRowInsert(row, count);
      syncChartRegions();
      invalidateAllChartCaches();
    }),
  );
  cleanupFunctions.push(
    onAppEvent<{ col: number; count: number }>(AppEvents.COLUMNS_INSERTED, ({ col, count }) => {
      shiftChartsForColInsert(col, count);
      syncChartRegions();
      invalidateAllChartCaches();
    }),
  );
  cleanupFunctions.push(
    onAppEvent<{ row: number; count: number }>(AppEvents.ROWS_DELETED, ({ row, count }) => {
      shiftChartsForRowDelete(row, count);
      syncChartRegions();
      invalidateAllChartCaches();
    }),
  );
  cleanupFunctions.push(
    onAppEvent<{ col: number; count: number }>(AppEvents.COLUMNS_DELETED, ({ col, count }) => {
      shiftChartsForColDelete(col, count);
      syncChartRegions();
      invalidateAllChartCaches();
    }),
  );

  // Subscribe to selection changes
  cleanupFunctions.push(
    ExtensionRegistry.onSelectionChange(handleSelectionChange),
  );

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

  // Remove chart overlay regions
  removeGridRegionsByType("chart");

  // Unregister from extension registries
  ExtensionRegistry.unregisterAddIn(ChartManifest.id);
  DialogExtensions.unregisterDialog(CHART_DIALOG_ID);

  console.log("[Chart Extension] Unregistered successfully");
}

// Re-export for convenience
export { CHART_DIALOG_ID };
