//! FILENAME: app/extensions/Charts/index.ts
// PURPOSE: Chart extension entry point.
// CONTEXT: Registers all chart functionality with the extension system.
//          Charts are free-floating overlays that can be moved and resized.
//          Handles mousemove for tooltips and deferred clicks for hierarchical selection.

import type { ExtensionModule, ExtensionContext } from "@api/contract";
import {
  ExtensionRegistry,
  AppEvents,
  columnToLetter,
} from "@api";
import { getActiveSheet } from "@api/lib";
import {
  removeGridRegionsByType,
  type OverlayRenderContext,
} from "@api/gridOverlays";
import { emitAppEvent } from "@api/events";
import { showOverlay, hideOverlay } from "@api/ui";

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
  getSubSelection,
} from "./handlers/selectionHandler";
import {
  resetChartStore,
  syncChartRegions,
  getAllCharts,
  moveChart,
  resizeChart,
  deleteChart,
  setActiveSheetIndex,
  loadChartsFromBackend,
  getChartById,
  updateChartSpec,
} from "./lib/chartStore";
import { buildSeriesFormula } from "./lib/seriesFormula";
import type { DataRangeRef } from "./types";
import { QuickAccessPopup } from "./components/QuickAccessPopup";
import { DataPointFormatDialog } from "./components/DataPointFormatDialog";
import { AxisContextMenu } from "./components/AxisContextMenu";
import { FormatAxisDialog } from "./components/FormatAxisDialog";
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
  isHoveringQuickAccessButton,
  isHoveringAxis,
  getHoverState,
  removeChartFromCache,
} from "./rendering/chartRenderer";
import {
  hitTestQuickAccessButtons,
  togglePopup,
  closePopup,
  getActivePopup,
  type QuickAccessButtonType,
} from "./rendering/quickAccessButtons";
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
// Chart Selection Event Emission
// ============================================================================

/**
 * Emit a CHART_SELECTION_CHANGED event with the current selection state.
 * Called after every selection change (select, advance, deselect) so the
 * Shell (FormulaBar, NameBox) can update accordingly.
 */
async function emitChartSelectionEvent(): Promise<void> {
  const chartId = getCurrentChartId();
  if (chartId == null) {
    // No chart selected
    emitAppEvent(AppEvents.CHART_SELECTION_CHANGED, {
      chartId: null,
      chartName: null,
      level: "none",
    });
    return;
  }

  const chart = getChartById(chartId);
  if (!chart) return;

  const sub = getSubSelection();
  const payload: Record<string, unknown> = {
    chartId,
    chartName: chart.name,
    level: sub.level,
    seriesIndex: sub.seriesIndex,
    categoryIndex: (sub as { categoryIndex?: number }).categoryIndex,
  };

  // For series-level or dataPoint-level selection, compute the SERIES formula
  if ((sub.level === "series" || sub.level === "dataPoint") && sub.seriesIndex != null) {
    try {
      // Determine the sheet name for the chart's data source
      let sheetName = "";
      const data = chart.spec.data;
      if (typeof data === "string") {
        // A1 reference like "Sheet1!A1:D10" — extract sheet name
        const bang = data.lastIndexOf("!");
        if (bang !== -1) {
          let name = data.substring(0, bang);
          if (name.startsWith("'") && name.endsWith("'")) {
            name = name.substring(1, name.length - 1).replace(/''/g, "'");
          }
          sheetName = name;
        }
      } else if (typeof data === "object" && "startRow" in data) {
        // DataRangeRef — resolve sheet index to name
        const { getSheets } = await import("@api");
        const result = await getSheets();
        const sheet = result.sheets.find((s: { index: number }) => s.index === data.sheetIndex);
        if (sheet) sheetName = sheet.name;
      }

      const formula = await buildSeriesFormula(chart.spec, sub.seriesIndex, sheetName);
      payload.seriesFormula = formula;
    } catch {
      // If formula computation fails, emit without it
    }
  }

  emitAppEvent(AppEvents.CHART_SELECTION_CHANGED, payload);
}

// ============================================================================
// Activation
// ============================================================================

function activate(context: ExtensionContext): void {
  console.log("[Chart Extension] Registering...");

  // Register add-in manifest
  ExtensionRegistry.registerAddIn(ChartManifest);

  // Register dialogs
  context.ui.dialogs.register(ChartDialogDefinition);

  const DATA_POINT_FORMAT_DIALOG_ID = "chart:dataPointFormat";
  context.ui.dialogs.register({
    id: DATA_POINT_FORMAT_DIALOG_ID,
    component: DataPointFormatDialog,
    priority: 50,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister(DATA_POINT_FORMAT_DIALOG_ID));

  // Register axis context menu overlay
  const AXIS_CONTEXT_MENU_ID = "chart:axisContextMenu";
  context.ui.overlays.register({
    id: AXIS_CONTEXT_MENU_ID,
    component: AxisContextMenu,
    layer: "dropdown",
  });
  cleanupFunctions.push(() => context.ui.overlays.unregister(AXIS_CONTEXT_MENU_ID));

  // Register Format Axis dialog
  const FORMAT_AXIS_DIALOG_ID = "chart:formatAxisDialog";
  context.ui.dialogs.register({
    id: FORMAT_AXIS_DIALOG_ID,
    component: FormatAxisDialog,
    priority: 50,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister(FORMAT_AXIS_DIALOG_ID));

  // Register API commands for programmatic chart management
  ExtensionRegistry.registerCommand({
    id: "chart.filter.set",
    name: "Set Chart Filters",
    execute: async (ctx) => {
      const args = ctx as unknown as { chartId: number; hiddenSeries?: number[]; hiddenCategories?: number[] };
      updateChartSpec(args.chartId, {
        filters: { hiddenSeries: args.hiddenSeries ?? [], hiddenCategories: args.hiddenCategories ?? [] },
      });
      invalidateChartCache(args.chartId);
      syncChartRegions();
      context.events.emit(AppEvents.GRID_REFRESH);
    },
  });

  ExtensionRegistry.registerCommand({
    id: "chart.filter.clear",
    name: "Clear Chart Filters",
    execute: async (ctx) => {
      const args = ctx as unknown as { chartId: number };
      updateChartSpec(args.chartId, { filters: undefined });
      invalidateChartCache(args.chartId);
      syncChartRegions();
      context.events.emit(AppEvents.GRID_REFRESH);
    },
  });

  ExtensionRegistry.registerCommand({
    id: "chart.filter.toggleSeries",
    name: "Toggle Chart Series Visibility",
    execute: async (ctx) => {
      const args = ctx as unknown as { chartId: number; seriesIndex: number };
      const chart = getChartById(args.chartId);
      if (!chart) return;
      const current = chart.spec.filters ?? { hiddenSeries: [], hiddenCategories: [] };
      const hidden = new Set(current.hiddenSeries ?? []);
      if (hidden.has(args.seriesIndex)) hidden.delete(args.seriesIndex); else hidden.add(args.seriesIndex);
      updateChartSpec(args.chartId, {
        filters: { hiddenSeries: Array.from(hidden), hiddenCategories: current.hiddenCategories ?? [] },
      });
      invalidateChartCache(args.chartId);
      syncChartRegions();
      context.events.emit(AppEvents.GRID_REFRESH);
    },
  });

  ExtensionRegistry.registerCommand({
    id: "chart.filter.toggleCategory",
    name: "Toggle Chart Category Visibility",
    execute: async (ctx) => {
      const args = ctx as unknown as { chartId: number; categoryIndex: number };
      const chart = getChartById(args.chartId);
      if (!chart) return;
      const current = chart.spec.filters ?? { hiddenSeries: [], hiddenCategories: [] };
      const hidden = new Set(current.hiddenCategories ?? []);
      if (hidden.has(args.categoryIndex)) hidden.delete(args.categoryIndex); else hidden.add(args.categoryIndex);
      updateChartSpec(args.chartId, {
        filters: { hiddenSeries: current.hiddenSeries ?? [], hiddenCategories: Array.from(hidden) },
      });
      invalidateChartCache(args.chartId);
      syncChartRegions();
      context.events.emit(AppEvents.GRID_REFRESH);
    },
  });

  ExtensionRegistry.registerCommand({
    id: "chart.setDataPointOverride",
    name: "Set Data Point Override",
    execute: async (ctx) => {
      const args = ctx as unknown as { chartId: number; seriesIndex: number; categoryIndex: number; color?: string; opacity?: number; exploded?: boolean };
      const chart = getChartById(args.chartId);
      if (!chart) return;
      const overrides = [...(chart.spec.dataPointOverrides ?? [])];
      const existing = overrides.findIndex((o) => o.seriesIndex === args.seriesIndex && o.categoryIndex === args.categoryIndex);
      const override: Record<string, unknown> = { seriesIndex: args.seriesIndex, categoryIndex: args.categoryIndex };
      if (args.color !== undefined) override.color = args.color;
      if (args.opacity !== undefined) override.opacity = args.opacity;
      if (args.exploded !== undefined) override.exploded = args.exploded;
      if (existing >= 0) {
        overrides[existing] = { ...overrides[existing], ...override } as any;
      } else {
        overrides.push(override as any);
      }
      updateChartSpec(args.chartId, { dataPointOverrides: overrides as any });
      invalidateChartCache(args.chartId);
      syncChartRegions();
      context.events.emit(AppEvents.GRID_REFRESH);
    },
  });

  ExtensionRegistry.registerCommand({
    id: "chart.clearDataPointOverrides",
    name: "Clear Data Point Overrides",
    execute: async (ctx) => {
      const args = ctx as unknown as { chartId: number };
      updateChartSpec(args.chartId, { dataPointOverrides: undefined });
      invalidateChartCache(args.chartId);
      syncChartRegions();
      context.events.emit(AppEvents.GRID_REFRESH);
    },
  });

  ExtensionRegistry.registerCommand({
    id: "chart.formatAxis",
    name: "Format Chart Axis",
    execute: async (ctx) => {
      const args = ctx as unknown as { chartId: number; axisType: "x" | "y"; updates: Record<string, unknown> };
      const axisKey = args.axisType === "x" ? "xAxis" : "yAxis";
      const chart = getChartById(args.chartId);
      if (!chart) return;
      const currentAxis = chart.spec[axisKey];
      updateChartSpec(args.chartId, { [axisKey]: { ...currentAxis, ...args.updates } });
      invalidateChartCache(args.chartId);
      syncChartRegions();
      context.events.emit(AppEvents.GRID_REFRESH);
    },
  });

  ExtensionRegistry.registerCommand({
    id: "chart.setGradientFill",
    name: "Set Chart Gradient Fill",
    execute: async (ctx) => {
      const args = ctx as unknown as {
        chartId: number;
        target: "bars" | "plotBackground" | "chartBackground";
        gradient: { type: "linear" | "radial"; direction?: string; stops: Array<{ offset: number; color: string }> };
      };
      const chart = getChartById(args.chartId);
      if (!chart) return;

      if (args.target === "bars") {
        const markOptions = { ...(chart.spec.markOptions ?? {}), fill: args.gradient };
        updateChartSpec(args.chartId, { markOptions: markOptions as any });
      } else if (args.target === "plotBackground") {
        const theme = { ...(chart.spec.config?.theme ?? {}), plotBackgroundGradient: args.gradient };
        updateChartSpec(args.chartId, { config: { ...(chart.spec.config ?? {}), theme } as any });
      } else if (args.target === "chartBackground") {
        const theme = { ...(chart.spec.config?.theme ?? {}), backgroundGradient: args.gradient };
        updateChartSpec(args.chartId, { config: { ...(chart.spec.config ?? {}), theme } as any });
      }

      invalidateChartCache(args.chartId);
      syncChartRegions();
      context.events.emit(AppEvents.GRID_REFRESH);
    },
  });

  ExtensionRegistry.registerCommand({
    id: "chart.applyStyle",
    name: "Apply Chart Style Preset",
    execute: async (ctx) => {
      const args = ctx as unknown as { chartId: number; presetId: string };
      const { getPresetById, buildPresetUpdates } = await import("./lib/chartStylePresets");
      const preset = getPresetById(args.presetId);
      if (!preset) return;
      const chart = getChartById(args.chartId);
      if (!chart) return;
      const updates = buildPresetUpdates(preset, chart.spec);
      updateChartSpec(args.chartId, updates as any);
      invalidateChartCache(args.chartId);
      syncChartRegions();
      context.events.emit(AppEvents.GRID_REFRESH);
    },
  });

  // Register quick access popup overlay
  const QA_OVERLAY_ID = "chart:quickAccessPopup";
  context.ui.overlays.register({
    id: QA_OVERLAY_ID,
    component: QuickAccessPopup,
    layer: "popover",
  });
  cleanupFunctions.push(() => context.ui.overlays.unregister(QA_OVERLAY_ID));

  // Close quick access popup when chart selection changes
  const unsubChartSelection = context.events.on(AppEvents.CHART_SELECTION_CHANGED, (payload: Record<string, unknown>) => {
    if (payload?.chartId == null && getActivePopup()) {
      closePopup();
      hideOverlay(QA_OVERLAY_ID);
    }
  });
  cleanupFunctions.push(unsubChartSelection);

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
      emitChartSelectionEvent();

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
    ExtensionRegistry.onSelectionChange((sel) => {
      const wasSelected = getCurrentChartId() != null;
      handleSelectionChange(sel);
      if (wasSelected) emitChartSelectionEvent();
    }),
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
          if (isHoveringFilterButton() || isHoveringDataElement() || isHoveringQuickAccessButton() || isHoveringAxis()) {
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

    // Check quick access buttons first (they are outside chart bounds)
    if (cachedData.quickAccessButtons && cachedData.quickAccessButtons.length > 0) {
      const qaBtnHit = hitTestQuickAccessButtons(
        click.canvasX,
        click.canvasY,
        cachedData.quickAccessButtons,
      );
      if (qaBtnHit) {
        handleQuickAccessButtonClick(click.chartId, qaBtnHit, click.canvasX, click.canvasY);
        return;
      }
    }

    const local = getChartLocalCoords(click.chartId, click.canvasX, click.canvasY);
    if (!local) return;

    // Check pivot field buttons (they take priority over data elements)
    if (cachedData.pivotFieldButtons && cachedData.pivotFieldButtons.length > 0) {
      const btnHit = findClickedFieldButton(local.localX, local.localY, cachedData.pivotFieldButtons);
      if (btnHit) {
        handlePivotFieldButtonClick(click.chartId, btnHit, click.canvasX, click.canvasY);
        return;
      }
    }

    const hitResult = hitTestBarChart(local.localX, local.localY, cachedData.barRects, cachedData.layout);
    advanceSelection(click.chartId, hitResult);
    emitChartSelectionEvent();
    context.events.emit(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("mouseup", handleMouseUp);
  cleanupFunctions.push(() => {
    window.removeEventListener("mouseup", handleMouseUp);
  });

  // -----------------------------------------------------------------------
  // Right-click context menu for chart elements (axes)
  // -----------------------------------------------------------------------

  const handleContextMenu = (e: MouseEvent) => {
    const hover = getHoverState();
    if (!hover || hover.hitResult.type !== "axis") return;

    e.preventDefault();
    e.stopPropagation();

    showOverlay(AXIS_CONTEXT_MENU_ID, {
      data: {
        chartId: hover.chartId,
        axisType: hover.hitResult.axisType,
        screenX: e.clientX,
        screenY: e.clientY,
      },
    });
  };
  window.addEventListener("contextmenu", handleContextMenu, true);
  cleanupFunctions.push(() => {
    window.removeEventListener("contextmenu", handleContextMenu, true);
  });

  // -----------------------------------------------------------------------
  // Sheet Change: re-sync chart regions for the new active sheet
  // -----------------------------------------------------------------------

  // Load persisted charts from backend, then sync regions for the active sheet
  loadChartsFromBackend().then(async () => {
    try {
      const idx = await getActiveSheet();
      setActiveSheetIndex(idx);
      invalidateAllChartCaches();
      syncChartRegions();
      context.events.emit(AppEvents.GRID_REFRESH);
    } catch {
      // Ignore
    }
  }).catch(() => {});

  cleanupFunctions.push(
    context.events.on(AppEvents.SHEET_CHANGED, async () => {
      try {
        const idx = await getActiveSheet();
        setActiveSheetIndex(idx);
        deselectChart();
        emitChartSelectionEvent();
        invalidateAllChartCaches();
        syncChartRegions();
        context.events.emit(AppEvents.GRID_REFRESH);
      } catch {
        // Ignore
      }
    }),
  );

  // Reload charts from backend after file open or new file
  const reloadCharts = async () => {
    try {
      await loadChartsFromBackend();
      const idx = await getActiveSheet();
      setActiveSheetIndex(idx);
      deselectChart();
      emitChartSelectionEvent();
      invalidateAllChartCaches();
      syncChartRegions();
      context.events.emit(AppEvents.GRID_REFRESH);
    } catch {
      // Ignore
    }
  };
  cleanupFunctions.push(
    context.events.on(AppEvents.AFTER_OPEN, reloadCharts),
  );
  cleanupFunctions.push(
    context.events.on(AppEvents.AFTER_NEW, reloadCharts),
  );

  // -----------------------------------------------------------------------
  // Chart Series Reference Drag/Resize
  // -----------------------------------------------------------------------

  const handleSeriesRefChanged = async (e: Event) => {
    const detail = (e as CustomEvent).detail;
    if (!detail) return;
    const chartId = getCurrentChartId();
    if (chartId == null) return;
    const chart = getChartById(chartId);
    if (!chart) return;
    const sub = getSubSelection();
    if (sub.level !== "series" && sub.level !== "dataPoint") return;
    if (sub.seriesIndex == null) return;

    const { refIndex, newRef } = detail;
    const spec = chart.spec;
    const seriesIndex = sub.seriesIndex;

    // The SERIES formula references are in order: [nameRef, catRef, valRef]
    // But some may be absent. Map refIndex to which field was dragged.
    // We determine this by counting which refs exist.
    type RefField = "name" | "category" | "values";
    const refFields: RefField[] = [];

    if (spec.seriesRefs && spec.seriesRefs[seriesIndex]) {
      const sr = spec.seriesRefs[seriesIndex];
      if (sr.nameRef) refFields.push("name");
      if (sr.catRef) refFields.push("category");
      if (sr.valRef) refFields.push("values");
    } else {
      // Without seriesRefs, compute from spec structure
      if (spec.hasHeaders) refFields.push("name");
      refFields.push("category");
      refFields.push("values");
    }

    const movedField = refFields[refIndex];
    if (!movedField) return;

    // Resolve the current data range to compute relative positions
    const { resolveDataSource } = await import("./lib/dataSourceResolver");
    let dataRef: DataRangeRef;
    try {
      dataRef = await resolveDataSource(spec.data);
    } catch {
      return;
    }

    const specUpdates: Partial<typeof spec> = {};

    if (movedField === "values") {
      // Values column moved — update the series sourceIndex relative to the data range
      // Also expand the data range if needed
      const newDataStartCol = Math.min(dataRef.startCol, newRef.startCol);
      const newDataEndCol = Math.max(dataRef.endCol, newRef.endCol);
      const newDataStartRow = Math.min(dataRef.startRow, newRef.startRow - (spec.hasHeaders ? 1 : 0));
      const newDataEndRow = Math.max(dataRef.endRow, newRef.endRow);

      // Update data range if it expanded
      if (newDataStartCol !== dataRef.startCol || newDataEndCol !== dataRef.endCol ||
          newDataStartRow !== dataRef.startRow || newDataEndRow !== dataRef.endRow) {
        if (typeof spec.data === "string") {
          // Rebuild the A1 reference string
          let sheetPrefix = "";
          const bangIdx = spec.data.lastIndexOf("!");
          if (bangIdx !== -1) sheetPrefix = spec.data.substring(0, bangIdx) + "!";
          specUpdates.data = `${sheetPrefix}$${columnToLetter(newDataStartCol)}$${newDataStartRow + 1}:$${columnToLetter(newDataEndCol)}$${newDataEndRow + 1}`;
        } else if (typeof spec.data === "object" && "startRow" in spec.data) {
          specUpdates.data = { ...spec.data, startRow: newDataStartRow, startCol: newDataStartCol, endRow: newDataEndRow, endCol: newDataEndCol };
        }
        // Recalculate sourceIndex relative to new data range start
        const updatedSeries = [...spec.series];
        updatedSeries[seriesIndex] = { ...updatedSeries[seriesIndex], sourceIndex: newRef.startCol - newDataStartCol };
        specUpdates.series = updatedSeries;
      } else {
        // Data range unchanged — just update sourceIndex
        const updatedSeries = [...spec.series];
        updatedSeries[seriesIndex] = { ...updatedSeries[seriesIndex], sourceIndex: newRef.startCol - dataRef.startCol };
        specUpdates.series = updatedSeries;
      }
    } else if (movedField === "category") {
      // Category column moved — update categoryIndex
      const newDataStartCol = Math.min(dataRef.startCol, newRef.startCol);
      const newDataEndCol = Math.max(dataRef.endCol, newRef.endCol);
      specUpdates.categoryIndex = newRef.startCol - newDataStartCol;
      if (newDataStartCol !== dataRef.startCol || newDataEndCol !== dataRef.endCol) {
        if (typeof spec.data === "string") {
          let sheetPrefix = "";
          const bangIdx = spec.data.lastIndexOf("!");
          if (bangIdx !== -1) sheetPrefix = spec.data.substring(0, bangIdx) + "!";
          specUpdates.data = `${sheetPrefix}$${columnToLetter(newDataStartCol)}$${dataRef.startRow + 1}:$${columnToLetter(newDataEndCol)}$${dataRef.endRow + 1}`;
        } else if (typeof spec.data === "object" && "startRow" in spec.data) {
          specUpdates.data = { ...spec.data, startCol: newDataStartCol, endCol: newDataEndCol };
        }
      }
    } else if (movedField === "name") {
      // Name reference moved — update the series name to point to the new cell
      const updatedSeries = [...spec.series];
      let sheetPrefix = "";
      if (spec.seriesRefs?.[seriesIndex]?.nameRef) {
        const nr = spec.seriesRefs[seriesIndex].nameRef!;
        const bangIdx = nr.lastIndexOf("!");
        if (bangIdx !== -1) sheetPrefix = nr.substring(0, bangIdx) + "!";
      }
      updatedSeries[seriesIndex] = {
        ...updatedSeries[seriesIndex],
        name: `=${sheetPrefix}$${columnToLetter(newRef.startCol)}$${newRef.startRow + 1}`,
      };
      specUpdates.series = updatedSeries;
    }

    // Update seriesRefs metadata for SERIES formula display
    if (spec.seriesRefs && spec.seriesRefs[seriesIndex]) {
      const updatedSeriesRefs = [...(specUpdates.seriesRefs || spec.seriesRefs)];
      const currentSR = { ...updatedSeriesRefs[seriesIndex] };
      let sheetPrefix = "";
      const existingRef = currentSR.valRef || currentSR.catRef || currentSR.nameRef || "";
      const bangIdx = existingRef.lastIndexOf("!");
      if (bangIdx !== -1) sheetPrefix = existingRef.substring(0, bangIdx) + "!";

      const newA1 = `${sheetPrefix}$${columnToLetter(newRef.startCol)}$${newRef.startRow + 1}` +
        (newRef.startRow !== newRef.endRow || newRef.startCol !== newRef.endCol
          ? `:$${columnToLetter(newRef.endCol)}$${newRef.endRow + 1}` : "");

      if (movedField === "name") currentSR.nameRef = newA1;
      else if (movedField === "category") currentSR.catRef = newA1;
      else if (movedField === "values") currentSR.valRef = newA1;
      updatedSeriesRefs[seriesIndex] = currentSR;
      specUpdates.seriesRefs = updatedSeriesRefs;
    }

    // Apply all updates
    updateChartSpec(chartId, specUpdates);

    // Invalidate and refresh (keep selection — don't resetSubSelection)
    invalidateChartCache(chartId);
    window.dispatchEvent(new CustomEvent(ChartEvents.CHART_UPDATED));
    context.events.emit(AppEvents.GRID_REFRESH);

    // Re-emit selection to update formula bar with new references
    emitChartSelectionEvent();
  };

  window.addEventListener("chartSeriesRef:moved", handleSeriesRefChanged);
  window.addEventListener("chartSeriesRef:resized", handleSeriesRefChanged);
  cleanupFunctions.push(() => {
    window.removeEventListener("chartSeriesRef:moved", handleSeriesRefChanged);
    window.removeEventListener("chartSeriesRef:resized", handleSeriesRefChanged);
  });

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
    emitChartSelectionEvent();
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

/**
 * Handle a click on a quick access button (Elements / Styles / Filters).
 * Toggles the popup panel and dispatches a custom event for the overlay component.
 */
function handleQuickAccessButtonClick(
  chartId: number,
  buttonType: QuickAccessButtonType,
  canvasX: number,
  canvasY: number,
): void {
  const QA_OVERLAY_ID = "chart:quickAccessPopup";

  if (!gridContainer) {
    gridContainer = document.querySelector("canvas")?.parentElement ?? null;
  }
  const rect = gridContainer?.getBoundingClientRect();
  const screenX = (rect?.left ?? 0) + canvasX;
  const screenY = (rect?.top ?? 0) + canvasY;

  const popup = togglePopup(chartId, buttonType, screenX, screenY);

  if (popup) {
    showOverlay(QA_OVERLAY_ID, {
      data: { chartId, buttonType, screenX, screenY },
    });
  } else {
    hideOverlay(QA_OVERLAY_ID);
  }

  context.events.emit(AppEvents.GRID_REFRESH);
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
