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
  registerChartStoreService,
  installChartMarkLibrary,
  uninstallChartMarks,
  uninstallChartMarksQueued,
  loadPersistedMarkLibraryWithProvenance,
  markLibraryConsentSource,
  CHART_MARKS_SCRIPT_ID,
  installChartTransformLibrary,
  uninstallChartTransforms,
  uninstallChartTransformsQueued,
  loadPersistedTransformLibraryWithProvenance,
  transformLibraryConsentSource,
  CHART_TRANSFORMS_SCRIPT_ID,
  registerMenuItem,
  DialogExtensions,
  IconChartMarks,
  IconChartTransforms,
} from "@api";
import { registerSandboxMark } from "./rendering/sandboxMarkShim";
import { ChartMarksDialog } from "./components/ChartMarksDialog";
import { ChartTransformsDialog } from "./components/ChartTransformsDialog";
import { ChartLibraryConsentDialog } from "./components/ChartLibraryConsentDialog";
import {
  isLibraryConsentCurrent,
  mountConsentedLibrary,
  grantLibraryConsent,
  requestedCapabilityDescriptors,
  type LibraryGateDescriptor,
} from "./lib/distributedLibraryGate";
import { getActiveSheet } from "@api/lib";
import {
  removeGridRegionsByType,
  requestOverlayRedraw,
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
  undoDeleteChart,
  canUndoDeleteChart,
  setActiveSheetIndex,
  getActiveSheetIndex,
  loadChartsFromBackend,
  getChartById,
  updateChartSpec,
  replaceChartSpec as storeReplaceChartSpec,
  mergeSpecPreview,
} from "./lib/chartStore";
import { chartsBackend } from "./lib/chartsBackend";
import { registerChartRenderingApi } from "@api/rendering";
import { registerChartParamController } from "@api/chartParams";
import { chartParamController } from "./lib/chartParamController";
import { validateChartSpec, validateMergedSpec } from "./lib/chartSpecValidate";
import type { ChartSpec } from "./types";
import { buildSeriesFormula } from "./lib/seriesFormula";
import type { DataRangeRef } from "./types";
import { QuickAccessPopup } from "./components/QuickAccessPopup";
import { DataPointFormatDialog } from "./components/DataPointFormatDialog";
import { AxisContextMenu } from "./components/AxisContextMenu";
import { ChartContextMenu } from "./components/ChartContextMenu";
import { FormatAxisDialog } from "./components/FormatAxisDialog";
import {
  renderChart,
  hitTestChart,
  invalidateChartCache,
  invalidateAllChartCaches,
  handleChartMouseMove,
  handleChartMouseLeave,
  getChartLocalCoords,
  findChartAtCanvasPos,
  getCachedChartData,
  isHoveringFilterButton,
  isHoveringDataElement,
  isHoveringQuickAccessButton,
  isHoveringAxis,
  getHoverState,
  removeChartFromCache,
  setBrushMarquee,
  getChartFrameBitmap,
  getChartFrameImageData,
  isChartRenderPending,
  isChartRenderCurrent,
  chartsIdle,
} from "./rendering/chartRenderer";
import {
  hitTestQuickAccessButtons,
  togglePopup,
  closePopup,
  getActivePopup,
  type QuickAccessButtonType,
} from "./rendering/quickAccessButtons";
import { hitTestBarChart, hitTestGeometry, hitTestRect } from "./rendering/chartHitTesting";
import { isComposed } from "./rendering/chartDispatch";
import {
  setPointSelection,
  clearPointSelection,
  clearAllPointSelections,
  pointSelectionKey,
  buildPointSelection,
  isDataHit,
  SELECTION_SUPPORTED_MARKS,
  matchingSharedParams,
  brushKeysFromHits,
} from "./handlers/chartPointSelection";
import { parseParamCellTarget } from "./lib/dataSourceResolver";
import { chartIntersectsChanges } from "./lib/chartInvalidation";
import { clearAllWidgetValues, getWidgetValue, setWidgetValue, nextWidgetValue } from "./handlers/chartWidgetValues";
import { hitTestWidgetControls, isInWidgetArea } from "./rendering/paramWidgets";
import { onAppEvent } from "@api/events";
import { listenTauriEvent } from "@api/backend";
import { updateCell } from "@api/lib";
import { ChartEvents } from "./lib/chartEvents";
import { isPivotDataSource, isDesignQueryDataSource } from "./types";
import { registerChartQueryProvider } from "./lib/chartQueryProvider";
import type { PivotChartFieldButton } from "./types";
import { PivotEvents } from "../_shared/lib/pivotEvents";

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
  // Bind the capability-gated backend channel BEFORE any chart loading (A3),
  // so the get_charts call at activate time flows through the scoped door.
  chartsBackend.set(context.invokeBackend);

  // Provide the feature-neutral chart-render capture surface (IoC) so capture/
  // export pipelines (e.g. animation GIF/WebM) can grab a settled chart raster
  // without importing Charts internals.
  registerChartRenderingApi({
    getChartFrameBitmap,
    getChartFrameImageData,
    isChartRenderPending,
    isChartRenderCurrent,
    chartsIdle,
  });

  // Provide the chart-param control surface (IoC) so drivers/UI can enumerate +
  // sweep chart params (e.g. the animation chart-param driver) without importing
  // Charts internals.
  registerChartParamController(chartParamController);

  console.log("[Chart Extension] Registering...");

  // Register chart store service for scriptable objects
  registerChartStoreService({
    getChartById(id: string) {
      const chart = getChartById(id);
      if (!chart) return null;
      return { specJson: JSON.stringify(chart.spec) };
    },
    updateChartSpec(chartId: string, specUpdates: Record<string, unknown>) {
      // Deep-merge the patch onto the live spec WITHOUT committing, validate the
      // merged result against the schema, then replace. A script can no longer
      // blind-merge garbage/typo/wrong-typed keys (the broker audits the throw).
      const merged = mergeSpecPreview(chartId, specUpdates as Partial<ChartSpec>);
      if (!merged) return; // unknown chart — no-op (matches the store)
      const violations = validateMergedSpec(merged);
      if (violations.length > 0) {
        throw new Error(`Invalid chart spec update: ${violations.slice(0, 8).join("; ")}`);
      }
      storeReplaceChartSpec(chartId, merged);
    },
    replaceChartSpec(chartId: string, fullSpec: Record<string, unknown>) {
      // Full re-author: validate the complete spec before overwriting.
      const violations = validateChartSpec(fullSpec);
      if (violations.length > 0) {
        throw new Error(`Invalid chart spec: ${violations.slice(0, 8).join("; ")}`);
      }
      // Validated above, so the cast is sound (TS can't narrow from the schema check).
      storeReplaceChartSpec(chartId, fullSpec as unknown as ChartSpec);
    },
    setStyleProperty(chartId: string, name: string, value: string) {
      // Canvas-style override stored in chart spec as a reserved _style_ key
      // (tolerated by validation). Separate constrained name+value setter.
      updateChartSpec(chartId, { [`_style_${name}`]: value } as Partial<ChartSpec>);
    },
  });

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

  // Chart Marks manager (B8.D.3): author sandboxed custom chart types.
  const CHART_MARKS_DIALOG_ID = "chart:marksManager";
  context.ui.dialogs.register({
    id: CHART_MARKS_DIALOG_ID,
    component: ChartMarksDialog,
    priority: 110,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister(CHART_MARKS_DIALOG_ID));
  registerMenuItem("insert", {
    id: "insert:chartMarks",
    label: "Custom Chart Marks...",
    icon: IconChartMarks,
    action: () => DialogExtensions.openDialog(CHART_MARKS_DIALOG_ID, {}),
  });

  // Chart Transforms manager (Feature 1): author sandboxed custom data transforms.
  const CHART_TRANSFORMS_DIALOG_ID = "chart:transformsManager";
  context.ui.dialogs.register({
    id: CHART_TRANSFORMS_DIALOG_ID,
    component: ChartTransformsDialog,
    priority: 110,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister(CHART_TRANSFORMS_DIALOG_ID));
  registerMenuItem("insert", {
    id: "insert:chartTransforms",
    label: "Custom Chart Transforms...",
    icon: IconChartTransforms,
    action: () => DialogExtensions.openDialog(CHART_TRANSFORMS_DIALOG_ID, {}),
  });

  // Register axis context menu overlay
  const AXIS_CONTEXT_MENU_ID = "chart:axisContextMenu";
  context.ui.overlays.register({
    id: AXIS_CONTEXT_MENU_ID,
    component: AxisContextMenu,
    layer: "dropdown",
  });
  cleanupFunctions.push(() => context.ui.overlays.unregister(AXIS_CONTEXT_MENU_ID));

  // Register general chart context menu overlay (any non-axis right-click)
  const CHART_CONTEXT_MENU_ID = "chart:contextMenu";
  context.ui.overlays.register({
    id: CHART_CONTEXT_MENU_ID,
    component: ChartContextMenu,
    layer: "dropdown",
  });
  cleanupFunctions.push(() => context.ui.overlays.unregister(CHART_CONTEXT_MENU_ID));

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
      const args = ctx as unknown as { chartId: string; hiddenSeries?: number[]; hiddenCategories?: number[] };
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
      const args = ctx as unknown as { chartId: string };
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
      const args = ctx as unknown as { chartId: string; seriesIndex: number };
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
      const args = ctx as unknown as { chartId: string; categoryIndex: number };
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
      const args = ctx as unknown as { chartId: string; seriesIndex: number; categoryIndex: number; color?: string; opacity?: number; exploded?: boolean };
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
      const args = ctx as unknown as { chartId: string };
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
      const args = ctx as unknown as { chartId: string; axisType: "x" | "y"; updates: Record<string, unknown> };
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
        chartId: string;
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
    id: "chart.undoDelete",
    name: "Undo Chart Delete",
    execute: async () => {
      const restored = undoDeleteChart();
      if (restored) {
        syncChartRegions();
        window.dispatchEvent(new CustomEvent(ChartEvents.CHART_CREATED));
        context.events.emit(AppEvents.GRID_REFRESH);
      }
    },
  });

  ExtensionRegistry.registerCommand({
    id: "chart.applyStyle",
    name: "Apply Chart Style Preset",
    execute: async (ctx) => {
      const args = ctx as unknown as { chartId: string; presetId: string };
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
      // S6: claim an in-plot drag as a brush (interval select) instead of a move.
      // Only for a selected, brushable chart, inside the plot area, off any widget.
      claimsBodyDrag: (ctx) => {
        const cid = ctx.region.data?.chartId as string | undefined;
        if (!cid) return false;
        const ch = getChartById(cid);
        if (!ch || !isChartSelected(cid) || !SELECTION_SUPPORTED_MARKS.has(ch.spec.mark)) return false;
        if (!ch.spec.params?.some((p) => p.select === "point" && p.brush)) return false;
        const cached = getCachedChartData(cid);
        const pa = cached?.layout?.plotArea;
        if (!pa) return false;
        // Composed charts (repeat/facet/concat) tile independent sub-scales; a
        // single brush rectangle across panels has no well-defined interval, so
        // the interval brush is OFF for them in v1. A plain click still selects a
        // panel datum (handled in the mouseup hit-test path, not the body-drag).
        if (cached.data && isComposed(ch.spec, cached.data)) return false;
        if (cached?.widgetControls && isInWidgetArea(ctx.canvasX, ctx.canvasY, cached.widgetControls)) return false;
        const loc = getChartLocalCoords(cid, ctx.canvasX, ctx.canvasY);
        if (!loc) return false;
        return loc.localX >= pa.x && loc.localX <= pa.x + pa.width && loc.localY >= pa.y && loc.localY <= pa.y + pa.height;
      },
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

  // Listen for data changes to invalidate chart caches (S7d: scoped). When the
  // event carries the changed cells, invalidate only charts whose read-set
  // intersects them (conservative — unbounded-dependency charts always invalidate);
  // a bare signal (no payload) falls back to the prior invalidate-all behavior.
  cleanupFunctions.push(
    context.events.on(AppEvents.CELLS_UPDATED, (detail) => {
      const charts = getAllCharts();
      if (charts.length === 0) return;
      const changes = (detail as { changes?: Array<{ row: number; col: number; sheetIndex?: number }> } | undefined)?.changes;
      if (!changes || changes.length === 0) {
        invalidateAllChartCaches();
        resetSubSelection();
        context.events.emit(AppEvents.GRID_REFRESH);
        return;
      }
      const activeSheetIndex = getActiveSheetIndex();
      let any = false;
      for (const chart of charts) {
        if (chartIntersectsChanges(chart.spec, changes, activeSheetIndex)) {
          invalidateChartCache(chart.chartId);
          any = true;
        }
      }
      resetSubSelection();
      if (any) context.events.emit(AppEvents.GRID_REFRESH);
    }),
  );

  // Cross-chart param bus (S7b): mirror a point-selection to every chart that
  // shares the same `sharedAs` key. Listeners only update their ephemeral store +
  // invalidate; they never re-broadcast, and the source chart is skipped — so
  // there is no feedback loop.
  cleanupFunctions.push(
    onAppEvent<{ sourceChartId: string; sharedAs: string; on: "category" | "series"; values: string[] }>(
      "chart:param-changed",
      ({ sourceChartId, sharedAs, values }) => {
        const targets = matchingSharedParams(getAllCharts(), sourceChartId, sharedAs);
        if (targets.length === 0) return;
        for (const t of targets) {
          // Key the mirrored selection on the TARGET param's own `on` dimension.
          if (values.length > 0) setPointSelection(t.chartId, buildPointSelection(t.paramName, t.on, values[0]));
          else clearPointSelection(t.chartId);
          invalidateChartCache(t.chartId);
        }
        context.events.emit(AppEvents.GRID_REFRESH);
      },
    ),
  );

  // Listen for pivot table changes to invalidate pivot-sourced chart caches
  const handlePivotChanged = () => {
    const charts = getAllCharts();
    // Guard c.spec?.data: during rapid chart create/delete/undo churn,
    // getAllCharts() can briefly return a transient/post-undo entry whose spec
    // is not yet populated. A spec-less entry is simply not a pivot chart, so
    // skip it rather than crash this event handler (fired on every pivot:refresh
    // / PIVOT_REGIONS_UPDATED).
    // Design-query charts read the same BI model, so refresh them here too.
    const aggregatedCharts = charts.filter(
      (c) => isPivotDataSource(c.spec?.data) || isDesignQueryDataSource(c.spec?.data),
    );
    if (aggregatedCharts.length > 0) {
      for (const chart of aggregatedCharts) {
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

  // Design-query charts bound to a control / ribbon filter via @Name refresh
  // through the SHARED query-object refresh service (one debounce/targeting/
  // coalescing brain for reports + charts) — register this family's provider.
  cleanupFunctions.push(registerChartQueryProvider());

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
    const chartId = detail.data?.chartId as string;
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
    const chartId = detail.data?.chartId as string;
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
    const chartId = detail.data?.chartId as string;
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
    const chartId = detail.data?.chartId as string;
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
    const chartId = detail.data?.chartId as string;
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
  // Interval brush (S6): the Core body-drag hook hands us the in-plot drag via
  // floatingObject:bodyDragStart; we track move/up on our existing window
  // listeners and finalize via hitTestRect. A plain click (zero-size rect)
  // selects the one datum under it; a drag selects the covered set.
  // -----------------------------------------------------------------------
  // start + end in chart-local coords, both sourced from the extension's own
  // canvas basis (lastCanvasX/Y -> getChartLocalCoords) so they never mix bases.
  let brushDrag: { chartId: string; startX: number; startY: number; endX: number; endY: number } | null = null;

  const finalizeBrush = (d: { chartId: string; startX: number; startY: number; endX: number; endY: number }) => {
    const cached = getCachedChartData(d.chartId);
    const param = getChartById(d.chartId)?.spec.params?.find((p) => p.select === "point" && p.brush);
    if (cached?.hitGeometry && param) {
      const rect = {
        x: Math.min(d.startX, d.endX),
        y: Math.min(d.startY, d.endY),
        width: Math.abs(d.endX - d.startX),
        height: Math.abs(d.endY - d.startY),
      };
      const on = param.on ?? "category";
      const keys = brushKeysFromHits(hitTestRect(rect, cached.hitGeometry), on);
      if (keys.length > 0) {
        setPointSelection(d.chartId, { [param.name]: { on, values: keys } });
        // Mirror the click path's side effects: S7c writeback + S7b bus.
        if (param.writeTo) {
          const target = parseParamCellTarget(param.writeTo);
          if (target) void updateCell(target.row, target.col, keys[0]);
        }
      } else {
        clearPointSelection(d.chartId);
      }
      if (param.sharedAs) {
        emitAppEvent("chart:param-changed", { sourceChartId: d.chartId, sharedAs: param.sharedAs, on, values: keys });
      }
    }
    invalidateChartCache(d.chartId);
    context.events.emit(AppEvents.GRID_REFRESH);
  };

  const handleBodyDragStart = (e: Event) => {
    const detail = (e as CustomEvent).detail as { regionType: string; data?: { chartId?: string } };
    if (detail.regionType !== "chart") return;
    const cid = detail.data?.chartId;
    if (!cid) return;
    // Use the extension's own canvas basis (lastCanvasX/Y from the prior
    // mousemove ~ the mousedown position) so start/move/end share one space.
    const loc = getChartLocalCoords(cid, lastCanvasX, lastCanvasY);
    if (!loc) return;
    clearPendingClick(); // the brush mouseup must not also be read as a click
    brushDrag = { chartId: cid, startX: loc.localX, startY: loc.localY, endX: loc.localX, endY: loc.localY };
    setBrushMarquee({ chartId: cid, x: loc.localX, y: loc.localY, width: 0, height: 0 });
  };
  window.addEventListener("floatingObject:bodyDragStart", handleBodyDragStart);
  cleanupFunctions.push(() => window.removeEventListener("floatingObject:bodyDragStart", handleBodyDragStart));

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

    // Interval brush in progress: update the stored end + marquee from current.
    if (brushDrag) {
      const loc = getChartLocalCoords(brushDrag.chartId, canvasX, canvasY);
      if (loc) {
        brushDrag.endX = loc.localX;
        brushDrag.endY = loc.localY;
        setBrushMarquee({
          chartId: brushDrag.chartId,
          x: Math.min(brushDrag.startX, loc.localX),
          y: Math.min(brushDrag.startY, loc.localY),
          width: Math.abs(loc.localX - brushDrag.startX),
          height: Math.abs(loc.localY - brushDrag.startY),
        });
        requestOverlayRedraw();
      }
      return;
    }

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
    // Finish an interval brush (S6) before the normal click handling.
    if (brushDrag) {
      const d = brushDrag;
      brushDrag = null;
      setBrushMarquee(null);
      finalizeBrush(d);
      return;
    }

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

    // On-canvas bound-param widget controls (C5 S5). Drawn (and cached) only when
    // the chart is selected, so a hit here only happens on a follow-up click —
    // route it to the widget value change. Absolute canvas coords (main-canvas).
    if (cachedData.widgetControls && cachedData.widgetControls.length > 0) {
      const wHit = hitTestWidgetControls(click.canvasX, click.canvasY, cachedData.widgetControls);
      if (wHit) {
        // Seed the step base from what the widget displays (widget > resolved
        // cell > literal default) so the first +/- continues from that value.
        const current = getWidgetValue(click.chartId, wHit.paramName)
          ?? cachedData.resolvedParams?.get(wHit.paramName)
          ?? getChartById(click.chartId)?.spec.params?.find((p) => p.name === wHit.paramName)?.value;
        const next = "option" in wHit.action ? wHit.action.option : nextWidgetValue(wHit.bind, current, wHit.action.dir);
        setWidgetValue(click.chartId, wHit.paramName, next);
        invalidateChartCache(click.chartId);
        context.events.emit(AppEvents.GRID_REFRESH);
        return;
      }
    }

    // Interactive point-selection (C5): if this chart declares a select:'point'
    // param AND its mark highlights via data.selection, a click sets/clears the
    // ephemeral selection (highlight via the chart's conditional encoding)
    // instead of advancing the editor sub-selection. Gated so other charts keep
    // the existing behavior byte-identical.
    const clickedChart = getChartById(click.chartId);
    const selectParam = clickedChart?.spec.params?.find((p) => p.select === "point");
    if (selectParam && clickedChart && SELECTION_SUPPORTED_MARKS.has(clickedChart.spec.mark)) {
      const on = selectParam.on ?? "category";
      const hit = hitTestGeometry(local.localX, local.localY, cachedData.hitGeometry, cachedData.layout);
      // hitTestGeometry always returns an object — only a real datum sets a
      // selection; a background/axis click clears it (back to all-highlighted).
      const values: string[] = [];
      if (isDataHit(hit)) {
        const key = pointSelectionKey(hit, on);
        values.push(key);
        setPointSelection(click.chartId, buildPointSelection(selectParam.name, on, key));
        // S7c: write the clicked label/value back to a same-sheet cell so
        // formulas / other charts can react (fire-and-forget; safe — its
        // CELLS_UPDATED only re-renders, the ephemeral selection survives).
        if (selectParam.writeTo) {
          const target = parseParamCellTarget(selectParam.writeTo);
          if (target) void updateCell(target.row, target.col, key);
        }
      } else {
        clearPointSelection(click.chartId);
      }
      // S7b: mirror the selection to cross-linked charts (same sharedAs key).
      if (selectParam.sharedAs) {
        emitAppEvent("chart:param-changed", { sourceChartId: click.chartId, sharedAs: selectParam.sharedAs, on, values });
      }
      invalidateChartCache(click.chartId);
      context.events.emit(AppEvents.GRID_REFRESH);
      return;
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
  // Drop ephemeral point-selection + widget state on deactivation (no leak).
  cleanupFunctions.push(() => { clearAllPointSelections(); clearAllWidgetValues(); });

  // -----------------------------------------------------------------------
  // Right-click context menu for chart elements (axes)
  // -----------------------------------------------------------------------

  const handleContextMenu = (e: MouseEvent) => {
    // Resolve the chart under the cursor by BOUNDS, not hover state — hover
    // only tracks data elements and axes, but a right-click anywhere on a
    // chart (title, legend, plot background, frame) is a click on the OBJECT
    // and must never fall through to the grid's cell context menu.
    if (!gridContainer) {
      gridContainer = document.querySelector("canvas")?.parentElement ?? null;
    }
    let boundsChartId: string | null = null;
    if (gridContainer) {
      const rect = gridContainer.getBoundingClientRect();
      boundsChartId = findChartAtCanvasPos(e.clientX - rect.left, e.clientY - rect.top);
    }

    const hover = getHoverState();

    // Axis-specific context menu
    if (hover && hover.hitResult.type === "axis") {
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
      return;
    }

    const targetId = boundsChartId ?? hover?.chartId ?? null;
    if (targetId == null) return;

    // Right-click selects the chart (like left-click), then shows the object menu.
    e.preventDefault();
    e.stopPropagation();
    if (!isChartSelected(targetId)) {
      selectChart(targetId);
      void emitChartSelectionEvent();
      context.events.emit(AppEvents.GRID_REFRESH);
    }
    showOverlay(CHART_CONTEXT_MENU_ID, {
      data: { chartId: targetId, screenX: e.clientX, screenY: e.clientY },
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
      // Drop ephemeral point-selections + widget values on file open/new so they
      // don't survive into a freshly loaded workbook (kept across plain cell edits).
      clearAllPointSelections();
      clearAllWidgetValues();
      invalidateAllChartCaches();
      syncChartRegions();
      context.events.emit(AppEvents.GRID_REFRESH);
    } catch {
      // Ignore
    }
  };
  // ===== Distributed (.calp) consent gate for sandboxed chart libraries =====
  // A reserved chart-mark / chart-transform library that arrived inside a
  // distributed .calp must NOT auto-mount on open — the project vision requires
  // explicit consent for code from external packages. A LOCALLY-authored library
  // (sourcePackage null) still auto-installs. The library is treated as ONE
  // "script" in the SHARED distributed-consent store (@api/distributedConsent),
  // keyed under a NAMESPACED package id so it never collides with object-script
  // consent. Transforms can carry bi.query; marks are paint-only (no capability).
  //
  // INTENTIONAL BOUNDARY: chart-library consent is a SEPARATE prompt from the
  // ScriptableObjects object-script consent, even for a .calp that ships both. The
  // two are distinct security domains (object scripts get broad object reach; chart
  // code is paint/transform-only or BI-scoped), use distinct store keys + mount
  // semantics, and each prompt is self-accurate. Merging them into one dialog would
  // mean refactoring the mature, security-critical object-script consent flow — not
  // worth the regression risk for an uncommon dual-artifact package. Both surfaces
  // DO share one consent STORE (@api/distributedConsent), which is the unification
  // that matters (one durable record set, consistent re-prompt-on-change rules).
  //
  // pendingLibraryGates holds the descriptor the user is being prompted for, WITH
  // the load-generation (epoch) it was produced under. resetLibraryGateState() bumps
  // the epoch; any async load/grant carrying a stale epoch bails — so a workbook
  // switch (or a re-emit) mid-consent can never mount/record a prior workbook's lib.
  interface PendingGate { d: LibraryGateDescriptor; epoch: number }
  const pendingLibraryGates = new Map<string, PendingGate>();
  const libraryConsentQueue: Array<Record<string, unknown>> = [];
  let activeLibraryConsentKey: string | null = null;
  let gateEpoch = 0;

  const CHART_LIBRARY_CONSENT_DIALOG_ID = "chart:libraryConsent";
  context.ui.dialogs.register({
    id: CHART_LIBRARY_CONSENT_DIALOG_ID,
    title: "Chart Code Security",
    component: ChartLibraryConsentDialog,
    width: 460,
    height: 420,
  });
  cleanupFunctions.push(() => context.ui.dialogs.unregister(CHART_LIBRARY_CONSENT_DIALOG_ID));

  const dialogPayload = (d: LibraryGateDescriptor): Record<string, unknown> => ({
    consentKey: d.consentKey,
    displayPackage: d.displayPackage,
    artifactLabel: d.artifactLabel,
    itemNames: d.itemNames,
    requestedCapabilities: requestedCapabilityDescriptors(d.capabilities),
  });

  // One prompt at a time (dialog state is keyed by dialog id).
  const showNextLibraryConsent = (): void => {
    if (activeLibraryConsentKey !== null) return;
    const next = libraryConsentQueue.shift();
    if (!next) return;
    activeLibraryConsentKey = next.consentKey as string;
    context.ui.dialogs.show(CHART_LIBRARY_CONSENT_DIALOG_ID, next);
  };

  const enqueueLibraryConsent = (d: LibraryGateDescriptor, epoch: number): void => {
    pendingLibraryGates.set(d.consentKey, { d, epoch });
    const payload = dialogPayload(d);
    // The displayed prompt MUST match the descriptor a grant will apply — else a
    // stale dialog (e.g. paint-only) could approve a newer, capability-expanded
    // library. So when this key is already showing/queued, REFRESH its payload
    // rather than silently keeping the old one.
    if (activeLibraryConsentKey === d.consentKey) {
      context.ui.dialogs.show(CHART_LIBRARY_CONSENT_DIALOG_ID, payload);
      return;
    }
    const queued = libraryConsentQueue.find((r) => r.consentKey === d.consentKey);
    if (queued) {
      Object.assign(queued, payload);
      return;
    }
    libraryConsentQueue.push(payload);
    showNextLibraryConsent();
  };

  // Advance the queue when the consent dialog closes (Allow, Block, or Escape). On a
  // close with no decision (Escape/overlay-dismiss bypasses the component handlers),
  // the descriptor is still in the map -> drop it (fail-closed); grant/deny already
  // deleted it synchronously before this fires, so this is a no-op for those.
  cleanupFunctions.push(
    DialogExtensions.onChange(() => {
      if (activeLibraryConsentKey === null) return;
      const stillOpen = DialogExtensions.getVisibleDialogs()
        .some((dd) => dd.definition.id === CHART_LIBRARY_CONSENT_DIALOG_ID);
      if (!stillOpen) {
        pendingLibraryGates.delete(activeLibraryConsentKey);
        activeLibraryConsentKey = null;
        showNextLibraryConsent();
      }
    }),
  );

  const refreshAfterLibraryChange = (): void => {
    invalidateAllChartCaches();
    context.events.emit(AppEvents.GRID_REFRESH);
  };

  // Chart-mark library: local → auto-install; distributed → gate behind consent.
  const loadChartMarks = async () => {
    const epoch = gateEpoch;
    try {
      const res = await loadPersistedMarkLibraryWithProvenance();
      if (gateEpoch !== epoch) return; // superseded by a workbook switch
      if (!res || res.lib.marks.length === 0) { uninstallChartMarks(); return; }
      const { lib, sourcePackage } = res;
      if (!sourcePackage) {
        await installChartMarkLibrary(lib, registerSandboxMark);
        refreshAfterLibraryChange();
        return;
      }
      // Distributed — ensure not mounted (queued, so it can't race an in-flight
      // install) until consent is confirmed, then gate.
      await uninstallChartMarksQueued();
      if (gateEpoch !== epoch) return;
      const d: LibraryGateDescriptor = {
        scriptId: CHART_MARKS_SCRIPT_ID,
        consentKey: `chart-marks:${sourcePackage}`,
        displayPackage: sourcePackage,
        artifactLabel: "chart mark",
        itemNames: lib.marks.map((m) => m.label || m.markId),
        capabilities: [],
        syntheticSource: markLibraryConsentSource(lib),
        install: () => installChartMarkLibrary(lib, registerSandboxMark, { sourcePackage }),
      };
      const current = await isLibraryConsentCurrent(d);
      if (gateEpoch !== epoch) return;
      if (current) { await mountConsentedLibrary(d); refreshAfterLibraryChange(); }
      else enqueueLibraryConsent(d, epoch);
    } catch (e) {
      console.error("[Charts] chart-mark library gate failed", e);
    }
  };

  // Chart-transform library: same gate; carries its declared capabilities (bi.query).
  const loadChartTransforms = async () => {
    const epoch = gateEpoch;
    try {
      const res = await loadPersistedTransformLibraryWithProvenance();
      if (gateEpoch !== epoch) return;
      if (!res || res.lib.transforms.length === 0) { uninstallChartTransforms(); return; }
      const { lib, sourcePackage } = res;
      if (!sourcePackage) {
        await installChartTransformLibrary(lib);
        refreshAfterLibraryChange();
        return;
      }
      await uninstallChartTransformsQueued();
      if (gateEpoch !== epoch) return;
      const d: LibraryGateDescriptor = {
        scriptId: CHART_TRANSFORMS_SCRIPT_ID,
        consentKey: `chart-transforms:${sourcePackage}`,
        displayPackage: sourcePackage,
        artifactLabel: "chart transform",
        itemNames: lib.transforms.map((t) => t.label || t.type),
        capabilities: lib.capabilities ?? [],
        syntheticSource: transformLibraryConsentSource(lib),
        install: () => installChartTransformLibrary(lib, { sourcePackage }),
      };
      const current = await isLibraryConsentCurrent(d);
      if (gateEpoch !== epoch) return;
      if (current) { await mountConsentedLibrary(d); refreshAfterLibraryChange(); }
      else enqueueLibraryConsent(d, epoch);
    } catch (e) {
      console.error("[Charts] chart-transform library gate failed", e);
    }
  };

  const reloadChartLibraries = (): void => { void loadChartMarks(); void loadChartTransforms(); };

  // Apply / decline consent — act ONLY on a gate WE enqueued (keyed by consentKey),
  // so this never reacts to the ScriptableObjects object-script consent flow. The
  // epoch check rejects a grant whose workbook was already replaced.
  cleanupFunctions.push(
    onAppEvent("charts:library-consent-granted", async (detail) => {
      const { consentKey } = detail as { consentKey: string };
      const pending = pendingLibraryGates.get(consentKey);
      if (!pending || pending.epoch !== gateEpoch) { pendingLibraryGates.delete(consentKey); return; }
      pendingLibraryGates.delete(consentKey);
      try {
        await grantLibraryConsent(pending.d);
        refreshAfterLibraryChange();
      } catch (e) {
        console.error("[Charts] failed to grant chart-library consent", e);
      }
    }),
  );
  cleanupFunctions.push(
    onAppEvent("charts:library-consent-denied", (detail) => {
      const { consentKey } = detail as { consentKey: string };
      if (!pendingLibraryGates.delete(consentKey)) return;
      // Library stays unmounted; charts fall back to built-in/identity behavior.
      refreshAfterLibraryChange();
    }),
  );

  // Reset gate state BEFORE re-running on a new/opened workbook, so a prior
  // workbook's package can never leak its consent prompt (or in-flight load/grant)
  // into a different one. Bumping the epoch invalidates any suspended async work;
  // closing a stale dialog stops it being approved against the new workbook.
  const resetLibraryGateState = (): void => {
    gateEpoch++;
    pendingLibraryGates.clear();
    libraryConsentQueue.length = 0;
    if (activeLibraryConsentKey !== null) {
      DialogExtensions.closeDialog(CHART_LIBRARY_CONSENT_DIALOG_ID);
      activeLibraryConsentKey = null;
    }
  };

  void loadChartMarks();
  void loadChartTransforms();
  cleanupFunctions.push(
    context.events.on(AppEvents.AFTER_OPEN, () => { resetLibraryGateState(); reloadChartLibraries(); }),
  );
  cleanupFunctions.push(
    context.events.on(AppEvents.AFTER_NEW, () => { resetLibraryGateState(); reloadChartLibraries(); }),
  );
  // Re-run when a .calp pull materializes new libraries (no reopen needed) — matches
  // the ScriptableObjects object-script consent behavior. (Same workbook → no reset,
  // so an in-flight prompt for the same package is refreshed, not duplicated.)
  cleanupFunctions.push(
    onAppEvent("calp:scripts-pulled", () => { reloadChartLibraries(); }),
  );

  cleanupFunctions.push(
    context.events.on(AppEvents.AFTER_OPEN, reloadCharts),
  );
  cleanupFunctions.push(
    context.events.on(AppEvents.AFTER_NEW, reloadCharts),
  );
  // Undo/redo of chart operations restores backend chart state — re-pull it
  // (dispatched by the core undo handler when UndoResult.objectsChanged).
  const handleChartsRefresh = () => { void reloadCharts(); };
  window.addEventListener("charts:refresh", handleChartsRefresh);
  cleanupFunctions.push(() => {
    window.removeEventListener("charts:refresh", handleChartsRefresh);
  });
  // Bridge the backend "charts:refresh" Tauri event (emitted after an MCP
  // create_chart_from_spec, B8.C) to the window handler above, so an AI-created
  // chart appears live without a file reopen.
  let unlistenBackendCharts: (() => void) | undefined;
  void listenTauriEvent("charts:refresh", () => {
    window.dispatchEvent(new Event("charts:refresh"));
  }).then((un) => { unlistenBackendCharts = un; });
  cleanupFunctions.push(() => { unlistenBackendCharts?.(); });

  // Sandboxed chart marks (B8.D): a worker-rendered bitmap arrived after a cache
  // miss. Chart rasters are version-gated (not re-blit per frame like shapes), so
  // invalidate + re-render so the sandbox shim re-runs and HITS the new bitmap.
  // Fires only on a real bitmap arrival (a resolved miss) -> no repaint loop.
  const handleChartMarkBitmap = () => {
    invalidateAllChartCaches();
    requestOverlayRedraw();
    context.events.emit(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("chartMark:bitmapReady", handleChartMarkBitmap);
  cleanupFunctions.push(() => {
    window.removeEventListener("chartMark:bitmapReady", handleChartMarkBitmap);
  });

  // Dynamic data ranges: re-render charts when table definitions change
  // (e.g., table auto-expands when new rows are added)
  const handleTableDefsUpdated = () => {
    invalidateAllChartCaches();
    context.events.emit(AppEvents.GRID_REFRESH);
  };
  window.addEventListener("app:table-definitions-updated", handleTableDefsUpdated);
  cleanupFunctions.push(() => {
    window.removeEventListener("app:table-definitions-updated", handleTableDefsUpdated);
  });

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
  // Delete: Delete key on selected chart + delete requests from the context menu
  // -----------------------------------------------------------------------

  const performChartDelete = (chartId: string) => {
    deselectChart();
    void emitChartSelectionEvent();
    deleteChart(chartId);
    removeChartFromCache(chartId);
    syncChartRegions();
    window.dispatchEvent(new CustomEvent(ChartEvents.CHART_DELETED));
    context.events.emit(AppEvents.GRID_REFRESH);
  };

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
    performChartDelete(chartId);
  };
  document.addEventListener("keydown", handleDeleteKey, true); // capture phase
  cleanupFunctions.push(() => document.removeEventListener("keydown", handleDeleteKey, true));

  const handleDeleteRequest = (e: Event) => {
    const chartId = (e as CustomEvent).detail?.chartId as string | undefined;
    if (chartId != null && getChartById(chartId)) performChartDelete(chartId);
  };
  window.addEventListener(ChartEvents.CHART_DELETE_REQUEST, handleDeleteRequest);
  cleanupFunctions.push(() =>
    window.removeEventListener(ChartEvents.CHART_DELETE_REQUEST, handleDeleteRequest),
  );

  // Expose lifecycle functions for E2E invariant testing
  (window as any).__CALCULA_CHARTS__ = {
    getAllCharts,
    getChartById,
    deleteChart,
    selectChart,
    deselectChart,
    getCurrentChartId,
    syncChartRegions,
  };

  console.log("[Chart Extension] Registered successfully");
}

// ============================================================================
// Deactivation
// ============================================================================

function deactivate(): void {
  console.log("[Chart Extension] Unregistering...");

  // Withdraw the chart-render capture + param-control surfaces.
  registerChartRenderingApi(null);
  registerChartParamController(null);

  // Tear down authored sandboxed marks (unregister shims + unmount workers).
  uninstallChartMarks();
  // Tear down authored sandboxed transforms (unmount the transform-library worker).
  uninstallChartTransforms();

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
  chartId: string,
  button: PivotChartFieldButton,
  canvasX: number,
  canvasY: number,
): void {
  const chart = getAllCharts().find((c) => c.chartId === chartId);
  if (!chart || !isPivotDataSource(chart.spec?.data)) return;

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
  chartId: string,
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

  emitAppEvent(AppEvents.GRID_REFRESH);
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
