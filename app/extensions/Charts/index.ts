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
  isKeyClaimed,
  registerTaskPane,
  unregisterTaskPane,
  openTaskPane,
  removeTaskPaneContextKey,
} from "@api";
import { registerSandboxMark } from "./rendering/sandboxMarkShim";

/**
 * Excel's Ctrl+1 on a chart: format whatever is selected. Registered as a
 * command (not just a listener) so the keybinding registry, the command palette
 * and the macro recorder all see the same one door.
 */
const CHART_FORMAT_PANE_COMMAND = "chart.format.selection";

/**
 * Excel's Delete on a selected chart element. A COMMAND, not just a listener,
 * because the keybinding registry's own window-capture listener runs outside
 * (and therefore before) this extension's document-capture door and consumes
 * Delete for `core.edit.clearContents` — so the only way the chart can claim
 * the key is to stand in that registry with a `when` predicate.
 */
const CHART_DELETE_SELECTION_COMMAND = "chart.delete.selection";
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
import { CommandRegistry } from "@api/commands";
import { registerKeybinding, isGridFocused } from "@api/keybindings";
import {
  removeGridRegionsByType,
  requestOverlayRedraw,
  type OverlayRenderContext,
} from "@api/gridOverlays";
import { emitAppEvent } from "@api/events";
import { showToast } from "@api/notifications";
import { originPackageName, scriptOriginForStoredRecord } from "@api/scriptHost/scriptOrigin";
import { showOverlay, hideOverlay } from "@api/ui";

import {
  ChartManifest,
  ChartDialogDefinition,
  CHART_DIALOG_ID,
  ChartFormatPaneDefinition,
  CHART_FORMAT_PANE_ID,
} from "./manifest";

import {
  handleSelectionChange,
  resetSelectionHandlerState,
  selectChart,
  isChartSelected,
  advanceSelection,
  markSubSelectionStale,
  revalidateSubSelection,
  isSubSelectionStale,
  notePressOrigin,
  noteMovePreview,
  setPendingClick,
  clearPendingClick,
  consumePendingClick,
  deselectChart,
  getCurrentChartId,
  getSubSelection,
  setSubSelection,
  buildChartNavGroups,
  navigateChartSelection,
  escapeLevelUp,
  chartOwnsKeystroke,
  arrowsBelongToOverlayStep,
  isChartAreaElement,
  selectionAfterHidingLegendEntry,
} from "./handlers/selectionHandler";
import type { ChartNavDirection } from "./handlers/selectionHandler";
import {
  resetChartStore,
  syncChartRegions,
  getAllCharts,
  createChart as storeCreateChart,
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
  updateChartPlacement as storeUpdateChartPlacement,
  flushPendingChartSaves,
} from "./lib/chartStore";
import { chartsBackend } from "./lib/chartsBackend";
import { registerChartRenderingApi } from "@api/rendering";
import { registerChartParamController } from "@api/chartParams";
import { chartParamController } from "./lib/chartParamController";
import { registerChartDataProvider, setChartRightClickTarget } from "@api/chartData";
import {
  installChartSelectionPublisher,
  publishCurrentChartSelection,
  runResetToMatchStyleCommand,
} from "./components/ChartFormatPane";
import { chartDataProvider } from "./lib/chartDataProvider";
import {
  chartCueSteps,
  clearAllChartCues,
  firstCueOfFact,
  getChartCueStep,
  getChartOverlay,
  onChartCuesChanged,
  registerChartCueHost,
  setChartCueStep,
  setSelectedChartCue,
  stepChartCues,
  visibleChartCues,
} from "@api/chartCues";
import { cueAtDatum } from "./rendering/cuePainter";
import { overlayStepDelta } from "./lib/overlayKeys";
import { onOverlayStyleChanged } from "@api/insightStyle";
import { hitTestCommentBoxes, hitTestCueStepper } from "./rendering/cueChrome";
import { chartOverlayHost } from "./lib/chartOverlayHost";
import { validateChartSpec, validateMergedSpec } from "./lib/chartSpecValidate";
import type { ChartSpec } from "./types";
import { buildSeriesFormula } from "./lib/seriesFormula";
import type { DataRangeRef } from "./types";
import { QuickAccessPopup } from "./components/QuickAccessPopup";
import { DataPointFormatDialog } from "./components/DataPointFormatDialog";
import { AxisContextMenu } from "./components/AxisContextMenu";
import { ChartContextMenu, hideLegendEntryPatch } from "./components/ChartContextMenu";
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
  type QuickAccessButton,
} from "./rendering/quickAccessButtons";
import { listChartQuickActions } from "@api/chartQuickActions";
import {
  chartElementOf,
  hitTestGeometry,
  hitTestRect,
  isDatumHit,
} from "./rendering/chartHitTesting";
import { toAuthoringIndices } from "./lib/dataPointOverrides";
import {
  CHART_FORMAT_ELEMENT_EVENT,
  handleChartDoubleClick,
  handleChartTextDelete,
  isChartTextElement,
  maybeEnterTextEditOnClick,
  resetChartTextEditing,
  setChartDragActive,
  type ChartFormatElementDetail,
} from "./handlers/chartTextEditing";
import { isComposed } from "./rendering/chartDispatch";
import {
  setPointSelection,
  clearPointSelection,
  clearAllPointSelections,
  pointSelectionKey,
  buildPointSelection,
  SELECTION_SUPPORTED_MARKS,
  matchingSharedParams,
  brushKeysFromHits,
} from "./handlers/chartPointSelection";
import { parseParamCellTarget } from "./lib/dataSourceResolver";
import { chartIntersectsChanges } from "./lib/chartInvalidation";
import { clearAllWidgetValues, getWidgetValue, setWidgetValue, nextWidgetValue } from "./handlers/chartWidgetValues";
import { hitTestWidgetControls, isInWidgetArea } from "./rendering/paramWidgets";
import { onAppEvent } from "@api/events";
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
 * The selected chart is about to re-read its numbers.
 *
 * Note the sub-selection as stale against the data cache it was chosen on
 * rather than dropping the reader straight back to chart level: typing in a
 * source cell used to throw away "this one bar" mid-task. Nothing can be
 * decided here — the refreshed geometry does not exist yet — so the decision
 * is deferred to the overlay render callback, which sees the new cache.
 */
function noteChartDataChanging(): void {
  const cid = getCurrentChartId();
  if (cid == null) return;
  markSubSelectionStale(getCachedChartData(cid));
}

/**
 * Emit a CHART_SELECTION_CHANGED event with the current selection state.
 * Called after every selection change (select, advance, deselect) so the
 * Shell (FormulaBar, NameBox) can update accordingly.
 */
/**
 * Generation token for {@link emitChartSelectionEvent}.
 *
 * ONE FACT, TWO CHANNELS, AND ONLY ONE OF THEM CAN WAIT. The `@api`
 * registry is published synchronously; the app event is synchronous for
 * chart/axis/element levels but asynchronous for series/dataPoint (it resolves
 * the sheet name and builds the SERIES formula, which can be a backend
 * round-trip). Every call site is fire-and-forget, so a selection made WHILE an
 * earlier series-level emit is still awaiting used to be announced FIRST and
 * the stale series payload LAST: the formula bar armed series-reference
 * drag/resize for a series that was no longer selected while the Name Box —
 * reading the synchronous registry — correctly said "Chart Area". Two surfaces,
 * one fact, disagreeing. A superseded emit now drops its payload instead of
 * overtaking the one that replaced it.
 */
let chartSelectionEmitGeneration = 0;

async function emitChartSelectionEvent(): Promise<void> {
  const generation = ++chartSelectionEmitGeneration;
  // THE REGISTRY IS FED SYNCHRONOUSLY, THE SHELL IS TOLD WHEN THE FORMULA IS
  // READY. `@api/chartSelection` is what the Format pane targets, and this
  // function is async for series-level selections (it resolves the sheet name
  // and builds the SERIES formula, which can be a backend round-trip). A
  // gesture that moves the ladder and opens the pane in the same tick — the
  // double-click, the context menu's Format row — would otherwise show the
  // PREVIOUS subject's fields until that promise settled, and then flip.
  //
  // There is still exactly ONE derive-and-publish function
  // (`publishCurrentChartSelection`, which reads the ladder); this call and
  // the publisher's own CHART_SELECTION_CHANGED subscription are two triggers
  // for it, and the registry drops a publish that changes nothing.
  publishCurrentChartSelection();

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
    elementId: sub.elementId,
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

  // A selection made while the awaits above were in flight has already been
  // announced. Emitting now would announce the OLD subject last and leave every
  // listener holding it. See `chartSelectionEmitGeneration`.
  if (generation !== chartSelectionEmitGeneration) return;

  emitAppEvent(AppEvents.CHART_SELECTION_CHANGED, payload);
}

// ============================================================================
// Chart deletion — ONE recipe
// ============================================================================

/**
 * THE chart delete. Every route that removes a chart goes through here: the
 * Delete key, the context menu, the script/MCP `api.deleteChart` broker call,
 * and the E2E bridge.
 *
 * THERE WERE TWO RECIPES AND THEY HAD DRIFTED. The UI path (the old local
 * `performChartDelete`) deselected first and then cleared the render cache with
 * `removeChartFromCache`; the component-store registry's `deleteChart` — the
 * one reached by object scripts, the MCP tools and `api.deleteChart` — did
 * neither. Three consequences, all live:
 *
 *   1. Deleting the SELECTED chart from a script left the contextual "Chart
 *      Design" ribbon tab on screen with zero charts in the workbook, and
 *      `getCurrentChartId()` still returning the dead id — so every Chart
 *      Design command was then aimed at a chart that no longer existed. Found
 *      by the invariant walker (`contextual-ribbon-tabs`) on 2026-08-12, on
 *      two independent seeds, each minimized to the same confirmed three
 *      actions: chart.create -> chart.select -> chart.delete. It is the first
 *      finding that invariant has ever produced for charts, because until
 *      BUG-0031 and BUG-0035 the walker's chart actions were silent no-ops.
 *   2. Nothing emitted CHART_SELECTION_CHANGED, so the FormulaBar/NameBox kept
 *      showing the deleted chart's name.
 *   3. `invalidateChartCache` only BUMPS A VERSION COUNTER; it was standing in
 *      for `removeChartFromCache`, which is what actually drops the
 *      OffscreenCanvas, the parsed data, the point selection and the widget
 *      values. A script-deleted chart therefore leaked all four for the life of
 *      the session, keyed by an id nothing could ever reach again.
 *
 * This is the Seam Rule's own lesson one object over: a copied recipe is a
 * second source of truth that drifts on the owner's first change. `deleteChart`
 * in `lib/chartStore.ts` is an internal persistence primitive — store + backend
 * and nothing else — and is not a delete anyone outside this module may call.
 *
 * The deselect is CONDITIONAL, which the UI recipe's unconditional version was
 * not: deleting chart A while chart B is selected must leave B selected, as it
 * does in Excel. The old code only ever reached that path with the selected
 * chart via the Delete key, but the context-menu route could already pass
 * another chart's id.
 *
 * @returns false when there is no such chart (the registry's contract).
 */
function performChartDelete(chartId: string): boolean {
  if (!getChartById(chartId)) return false;

  if (getCurrentChartId() === chartId) {
    deselectChart();
    void emitChartSelectionEvent();
  }

  deleteChart(chartId);
  removeChartFromCache(chartId);
  syncChartRegions();
  emitAppEvent(ChartEvents.CHART_DELETED, { chartId });
  emitAppEvent(AppEvents.GRID_REFRESH);
  return true;
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

  // Provide the resolved-series surface (IoC) so an analysis outside Charts can
  // read a chart's ACTUAL numbers. It runs the same reader the painters use and
  // then re-reads a plain source range TYPED, so a blank cell arrives as `null`
  // rather than as the zero the display-string parse would substitute.
  registerChartDataProvider(chartDataProvider);

  // Insight cues (@api/chartCues) are painted at composite time from the
  // cached geometry, so a change needs a redraw, not a re-render. Charts is
  // also the host for what only it can do: keep a cue in the spec, snapshot.
  cleanupFunctions.push(onChartCuesChanged(() => requestOverlayRedraw()));
  cleanupFunctions.push(onOverlayStyleChanged(() => requestOverlayRedraw()));
  registerChartCueHost(chartOverlayHost);

  console.log("[Chart Extension] Registering...");

  // Register chart store service for scriptable objects
  registerChartStoreService({
    getChartById(id: string) {
      const chart = getChartById(id);
      if (!chart) return null;
      return { specJson: JSON.stringify(chart.spec) };
    },
    listCharts() {
      // Identity + the STORED definition JSON (the same shape the backend
      // persists), so the script host can render an inventory line without the
      // API facade ever learning the ChartSpec schema.
      return getAllCharts().map((c) => ({
        chartId: c.chartId,
        name: c.name,
        sheetIndex: c.sheetIndex,
        specJson: JSON.stringify({
          chartId: c.chartId,
          name: c.name,
          sheetIndex: c.sheetIndex,
          spec: c.spec,
        }),
      }));
    },
    createChart(fullSpec: Record<string, unknown>, placement) {
      // Same order as the Insert Chart dialog: validate FIRST (an invalid spec
      // must not reach the store), then create, sync the grid regions and
      // announce — otherwise the new chart exists but never paints.
      const violations = validateChartSpec(fullSpec);
      if (violations.length > 0) {
        throw new Error(`Invalid chart spec: ${violations.slice(0, 8).join("; ")}`);
      }
      const chart = storeCreateChart(fullSpec as unknown as ChartSpec, {
        sheetIndex: placement?.sheetIndex ?? getActiveSheetIndex(),
        x: placement?.x ?? 100,
        y: placement?.y ?? 100,
        width: placement?.width ?? 600,
        height: placement?.height ?? 400,
        name: placement?.name,
      });
      syncChartRegions();
      emitAppEvent(ChartEvents.CHART_CREATED, { chartId: chart.chartId });
      emitAppEvent(AppEvents.GRID_REFRESH);
      return chart.chartId;
    },
    deleteChart(chartId: string) {
      // THE one delete (see performChartDelete). This method used to inline its
      // own copy of the recipe, which had drifted from the UI's in three ways:
      // no deselect, no selection announcement, and a cache INVALIDATE where a
      // cache REMOVE was needed.
      return performChartDelete(chartId);
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
    updateChartPlacement(chartId: string, placement) {
      // Same store fields the drag-move/resize handles mutate, same debounced
      // persist — then the same repaint choreography createChart runs, so a
      // script move lands exactly like a hand move.
      const updated = storeUpdateChartPlacement(chartId, placement);
      if (!updated) {
        throw new Error(`No chart with id "${chartId}"`);
      }
      invalidateChartCache(chartId);
      syncChartRegions();
      emitAppEvent(AppEvents.GRID_REFRESH);
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

  // -----------------------------------------------------------------------
  // The Format task pane — Excel's "Format <element>"
  // -----------------------------------------------------------------------
  //
  // ONE FORMAT SURFACE, NOT TWO. The two dialog ids registered just above no
  // longer format anything: `chart:dataPointFormat` and
  // `chart:formatAxisDialog` are one-effect redirectors into this pane, kept
  // registered only because ChartContextMenu, ChartDesignSections and
  // AxisContextMenu still name those ids. They are doorways; the pane is the
  // room. Nothing is registered twice for the same job.
  registerTaskPane(ChartFormatPaneDefinition);
  cleanupFunctions.push(() => {
    unregisterTaskPane(CHART_FORMAT_PANE_ID);
    // `selectChart` adds the "chart" context key and `deselectChart` removes
    // it, but deactivation goes through `resetSelectionHandlerState`, which
    // resets the ladder WITHOUT deselecting — so the key would outlive the
    // only pane that declares it. Inert before this pane existed; a leak now.
    removeTaskPaneContextKey("chart");
  });

  // The pane's SUBJECT. Without this nothing ever publishes into
  // `@api/chartSelection` and the pane shows its "select a chart" invitation
  // forever. It is an event listener on CHART_SELECTION_CHANGED rather than a
  // call site, so the half-dozen places that move the ladder cannot forget it.
  cleanupFunctions.push(installChartSelectionPublisher());

  // A double-click on a non-text chart element asks for the Format surface
  // (the two title elements open for typing instead and emit nothing). The
  // event describes the selection the gesture just made, so the pane needs no
  // payload — it reads the published selection, which is the same fact rather
  // than a second description of it.
  //
  // The publish is forced FIRST because the pane mounts inside this very
  // dispatch, while the announcement in the double-click seam above runs
  // after `handleChartDoubleClick` returns — i.e. after this listener.
  cleanupFunctions.push(
    onAppEvent<ChartFormatElementDetail>(CHART_FORMAT_ELEMENT_EVENT, () => {
      publishCurrentChartSelection();
      openTaskPane(CHART_FORMAT_PANE_ID);
    }),
  );

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

  // CI-11 — Excel's "Reset to Match Style". The body lives beside the Format
  // pane's own button (components/ChartFormatPane.tsx) so the command and the
  // button cannot drift: ONE resolver decides the scope from the current
  // selection, and the whole reset is ONE applySpecPatch, hence one undo entry.
  ExtensionRegistry.registerCommand({
    id: "chart.resetToMatchStyle",
    name: "Reset to Match Style",
    execute: async (ctx) => {
      const args = (ctx ?? {}) as { chartId?: string };
      runResetToMatchStyleCommand(args.chartId);
    },
  });

  // NARROWER ON PURPOSE, and not a leg of the command above. This one clears
  // exactly what its id says and nothing else. `runResetToMatchStyleCommand`
  // scopes itself to the CURRENT SELECTION, so routing this id through it
  // would make "clear the data point overrides" mean "reset whichever rung
  // happens to be selected" -- a silent change of meaning for a command id
  // the scripting surface can name. The wider clear is `chart.resetToMatchStyle`.
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
        // A sub-selection marked stale by a data change is checked HERE, not
        // where the change landed: the re-read is async, so at the moment of
        // the edit the data cache still holds the pre-edit geometry and any
        // check against it would pass and clear the flag. revalidateSubSelection
        // compares the cache entry by identity and decides nothing until it is
        // a different object.
        const renderedId = ctx.region.data?.chartId as string | undefined;
        if (renderedId != null && isSubSelectionStale() && isChartSelected(renderedId)) {
          const fresh = getCachedChartData(renderedId);
          if (revalidateSubSelection(renderedId, fresh, fresh ? fresh.hitGeometry : null)) {
            void emitChartSelectionEvent();
          }
        }
      },
      hitTest: hitTestChart,
      // Wave A's double-click seam. Excel's rule is that a double-click is a
      // uniform "open Format <element>" gesture; the two text elements it can
      // reach instead open for typing, because that is the same state Excel
      // arrives at and it is what the reader asked for. See
      // handlers/chartTextEditing.ts for why the answer is computed from the
      // pixel alone and never from what was selected before the gesture.
      onDoubleClick: (ctx) => {
        const taken = handleChartDoubleClick(ctx);
        if (!taken) return false;
        // THE GESTURE MOVES THE LADDER ITSELF and announces nothing. It has
        // to move it itself: by the time `dblclick` arrives both mouseups
        // have already advanced the ladder, so the gesture STATES its answer
        // (`setSubSelection`) instead of nudging one. Nothing inside it emits
        // CHART_SELECTION_CHANGED, and that event is what feeds the Name Box
        // and the Format pane's registry — so the announcement is made here,
        // by the one module that owns it, for BOTH outcomes: the element that
        // opened for typing and the element that asked to be formatted.
        void emitChartSelectionEvent();
        context.events.emit(AppEvents.GRID_REFRESH);
        return true;
      },
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
        noteChartDataChanging();
        context.events.emit(AppEvents.GRID_REFRESH);
        return;
      }
      const activeSheetIndex = getActiveSheetIndex();
      const selectedId = getCurrentChartId();
      let any = false;
      for (const chart of charts) {
        if (chartIntersectsChanges(chart.spec, changes, activeSheetIndex)) {
          invalidateChartCache(chart.chartId);
          if (chart.chartId === selectedId) noteChartDataChanging();
          any = true;
        }
      }
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
      const selectedId = getCurrentChartId();
      for (const chart of aggregatedCharts) {
        invalidateChartCache(chart.chartId);
        if (chart.chartId === selectedId) noteChartDataChanging();
      }
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

    // Where the object sits NOW, so a live move preview can be measured
    // against the press instead of against the object's own already-moved
    // position (handleMovePreview writes straight through to the store).
    const pressed = getChartById(chartId);
    if (pressed) notePressOrigin(chartId, pressed.x, pressed.y);

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
      // Core dispatches this on EVERY mousemove once the drag is live; its own
      // 3px hasMoved threshold gates only moveComplete. Charts never sets
      // movable:false, so every left press starts a move drag and clearing the
      // pending click here unconditionally meant one pixel of hand jitter
      // between press and release silently cancelled the ladder advance.
      // Below the threshold Core considers the object not to have moved at
      // all, so neither the pending click nor the object itself is touched.
      if (!noteMovePreview(chartId, detail.x, detail.y)) return;
      // An open text editor hides for the duration of a real drag: its rect is
      // recomputed per frame from the chart's canvas origin, so without this it
      // would skate across the grid a frame behind the object.
      setChartDragActive(chartId);
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
      setChartDragActive(null);
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
      setChartDragActive(chartId);
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
      setChartDragActive(null);
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

    // The insight overlay's chrome: the stepper pill and the comment boxes
    // (absolute canvas coords, drawn during the sync render). A cue itself is
    // hit-tested below, after the buttons, where a datum click lands.
    const stepperHit = hitTestCueStepper(click.canvasX, click.canvasY, cachedData.cueStepper);
    if (stepperHit) {
      if (stepperHit === "prev") stepChartCues(click.chartId, -1);
      else if (stepperHit === "next") stepChartCues(click.chartId, 1);
      else if (stepperHit === "all") setChartCueStep(click.chartId, getChartCueStep(click.chartId) === "all" ? 0 : "all");
      // "step": the label itself; a click there selects the shown fact's first
      // cue (the stepper steps by fact, but a selection names ONE cue).
      else {
        const shownFact = chartCueSteps(click.chartId)[Number(getChartCueStep(click.chartId)) || 0];
        const first = shownFact === undefined ? null : firstCueOfFact(click.chartId, shownFact);
        setSelectedChartCue(click.chartId, first ? first.cueId : null);
      }
      requestOverlayRedraw();
      return;
    }
    const commentHit = hitTestCommentBoxes(click.canvasX, click.canvasY, cachedData.commentBoxes);
    if (commentHit) {
      const comment = getChartOverlay(click.chartId).comments.find((c) => c.id === commentHit);
      if (comment) setSelectedChartCue(click.chartId, comment.cueId);
      requestOverlayRedraw();
      return;
    }

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

    // THE LADDER OWNS THE CLICK. A ring is a PROPERTY of the datum it marks,
    // not a thing the reader selects INSTEAD of it, so this branch records
    // which cue (if any) sits on the datum just clicked and FALLS THROUGH to
    // the selection ladder below. Clicking a bar therefore does the same thing
    // whether the lens is on or off — chart, then series, then that bar — and
    // the overlay stops being a mode.
    //
    // It used to `return` here, which is why a ringed bar could never be
    // selected individually (the owner's finding). And it only assigned when a
    // cue was FOUND, so a click on a bar with no ring left the previous ring
    // selected — and "Add comment on this point…" then wrote the reader's
    // words onto a bar they had already clicked away from. The assignment is
    // unconditional now: a click that lands on no cue CLEARS the selection,
    // exactly as a click on the plot background drops the ladder to chart level.
    if (getChartOverlay(click.chartId).cues.length > 0) {
      const datumHit = hitTestGeometry(local.localX, local.localY, cachedData.hitGeometry, cachedData.layout);
      const cue = isDatumHit(datumHit) ? cueAtDatum(visibleChartCues(click.chartId), datumHit) : null;
      setSelectedChartCue(click.chartId, cue ? cue.cueId : null);
      requestOverlayRedraw();
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
      if (isDatumHit(hit)) {
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

    // The unified geometry — the same call the cue branch and the point-param
    // branch above already make, and the same one HOVER makes. It used to be a
    // bars-only hit test against a bars-only cache field, so hover and click
    // disagreed about the same pixel and a pie, donut, line, area, scatter,
    // radar or bubble chart had no selectable data points at all.
    const hitResult = hitTestGeometry(local.localX, local.localY, cachedData.hitGeometry, cachedData.layout);
    // Excel's second route into the title editor: two SLOW single clicks. The
    // first selects the title (the ladder below does that); the second opens it
    // for typing. Asked BEFORE the ladder advances, because the ladder would
    // just select the same title again and the reader would never get past
    // selecting it.
    if (maybeEnterTextEditOnClick(click.chartId, hitResult)) {
      emitChartSelectionEvent();
      context.events.emit(AppEvents.GRID_REFRESH);
      return;
    }
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
  // An in-place text edit is state too: a session still mounted at deactivation
  // is DISCARDED, never committed -- unloading the extension must not write the
  // half-typed title the reader never finished.
  cleanupFunctions.push(resetChartTextEditing);

  // -----------------------------------------------------------------------
  // Right-click context menu for chart elements (axes)
  // -----------------------------------------------------------------------

  /**
   * A right-click on a chart: move the selection to what is UNDER THE CURSOR,
   * record that subject for the menu, then open the menu.
   *
   * THE DEFECT THIS SHAPE EXISTS FOR (open-items line 409): the menu used to
   * act on whatever the last LEFT click had selected, so right-clicking bar B
   * while bar A was selected formatted A. Excel moves the selection on a
   * right-click, and the menu's subject is then the selection's subject — one
   * fact, not two.
   *
   * THE ELEMENT IS RESOLVED FROM THE CURSOR, not from hover state. Hover is
   * rAF-throttled and only tracks what the renderer chose to track, which is
   * why the axis branch used to key off hover while everything else resolved by
   * bounds — the same pixel could answer two different questions depending on
   * how fast the mouse got there.
   */
  const handleContextMenu = (e: MouseEvent) => {
    // A TEXT SURFACE OWNS ITS OWN RIGHT-CLICK.
    //
    // `isPointerClaimed` deliberately never claims the SECONDARY button (see
    // pointerClaims.ts — a claimant that could take it would trap the reader
    // inside its own rectangle), so the claim cannot answer this and the census
    // verdict stays `right-press-exempt`. But the claim was never the whole
    // question: the overlay text editor mounts a real <textarea> over a chart
    // title, and this handler resolves the chart by GEOMETRY alone, so the
    // editor's own paste menu was suppressed and the Chart menu opened on top
    // of the field the reader was typing in. Core's sibling door for the same
    // editor (`handleOverlayDoubleClick`) refuses on exactly this target class.
    // Refusing here leaves the event alone — no preventDefault — so the field
    // keeps its native menu.
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.tagName === "SELECT" ||
        target.isContentEditable)
    ) {
      setChartRightClickTarget(null);
      return;
    }

    // Resolve the chart under the cursor by BOUNDS, not hover state — hover
    // only tracks data elements and axes, but a right-click anywhere on a
    // chart (title, legend, plot background, frame) is a click on the OBJECT
    // and must never fall through to the grid's cell context menu.
    if (!gridContainer) {
      gridContainer = document.querySelector("canvas")?.parentElement ?? null;
    }
    let boundsChartId: string | null = null;
    let canvasX = 0;
    let canvasY = 0;
    if (gridContainer) {
      const rect = gridContainer.getBoundingClientRect();
      canvasX = e.clientX - rect.left;
      canvasY = e.clientY - rect.top;
      // CLIPPED TO THE GRID. `findChartAtCanvasPos` tests the chart's REGION,
      // which is not clipped to the visible canvas: a chart wider than the grid
      // — routinely, once the Chart Format task pane narrows it — still matches
      // a point to the right of the canvas, and the pane sits exactly there. A
      // right-click inside the pane was swallowed and the chart menu opened
      // over it. A press outside the grid's own box is not a press on a chart.
      if (
        e.clientX < rect.left ||
        e.clientX > rect.right ||
        e.clientY < rect.top ||
        e.clientY > rect.bottom
      ) {
        // Outside the grid box entirely — and the hover fallback below must not
        // rescue it either, because hover is rAF-throttled and keeps whatever
        // the pointer was last over INSIDE the grid.
        setChartRightClickTarget(null);
        return;
      }
      boundsChartId = findChartAtCanvasPos(canvasX, canvasY);
    }

    const hover = getHoverState();
    const targetId = boundsChartId ?? hover?.chartId ?? null;
    if (targetId == null) {
      // A right-click that opens no chart menu must not leave the previous
      // subject standing: a contribution reading the record inside the GRID's
      // menu would otherwise be handed the chart the reader right-clicked
      // before this one.
      setChartRightClickTarget(null);
      return;
    }

    const cached = getCachedChartData(targetId);
    const local = getChartLocalCoords(targetId, canvasX, canvasY);
    const hit =
      cached && local
        ? hitTestGeometry(local.localX, local.localY, cached.hitGeometry, cached.layout)
        : null;
    // No cache yet (a chart that has never painted) is the only way to get here
    // with nothing to hit-test; the click is still on the OBJECT, so the
    // whole-chart menu is the honest answer.
    const element = hit ? chartElementOf(hit) : "chartArea";

    e.preventDefault();
    e.stopPropagation();

    // 1. MOVE THE SELECTION, exactly as a left-click on the same pixel would.
    if (!isChartSelected(targetId)) selectChart(targetId);
    if (element === "datum" && hit) {
      // The datum ladder, not a stated rung: a first right-click on a bar
      // selects its SERIES and a second selects the bar, which is what the
      // left-click ladder does and what decides singular vs plural in the menu.
      advanceSelection(targetId, hit);
    } else if (element === "xAxis" || element === "yAxis") {
      setSubSelection(targetId, {
        level: "axis",
        axisType: hit?.axisType ?? (element === "yAxis" ? "y" : "x"),
      });
    } else if (
      element === "title" ||
      element === "xAxisTitle" ||
      element === "yAxisTitle" ||
      element === "legend" ||
      element === "legendEntry" ||
      // The PLOT AREA is a rung of its own, exactly as a left-click on the
      // same pixel now makes it (see `advanceSelection`). It has to be listed
      // here too, because this handler STATES the rung outright rather than
      // nudging the ladder: a route missing from this list is a right-click
      // that lands somewhere the left-click would not, which is the two-
      // spellings defect the recorded subject exists to remove.
      element === "plotArea"
    ) {
      setSubSelection(targetId, {
        level: "element",
        elementId: element,
        ...(hit?.seriesIndex !== undefined ? { seriesIndex: hit.seriesIndex } : {}),
      });
    } else {
      // The chart area (the outer margin), a filter button, or a stale-cache
      // miss -> the chart object.
      setSubSelection(targetId, { level: "chart" });
    }
    void emitChartSelectionEvent();
    context.events.emit(AppEvents.GRID_REFRESH);

    // 2. The axis keeps its own menu (gridlines, scale, label angle). It reads
    // its subject from the payload, not from the record, so the record is
    // CLEARED rather than left pointing at a menu nobody is looking at.
    if (element === "xAxis" || element === "yAxis") {
      setChartRightClickTarget(null);
      showOverlay(AXIS_CONTEXT_MENU_ID, {
        data: {
          chartId: targetId,
          axisType: hit?.axisType ?? (element === "yAxis" ? "y" : "x"),
          screenX: e.clientX,
          screenY: e.clientY,
        },
      });
      return;
    }

    // 3. RECORD THE SUBJECT, after the selection has moved so the menu's rung
    // and the selection's rung are the same rung.
    const sub = getSubSelection();
    const painterSeries = hit?.seriesIndex;
    // ABSENT pointIndex is Excel's PointIndex = -1 — the whole series — and it
    // is the single thing that makes the menu say "Format Data Series..."
    // instead of "Format Data Point...". It is therefore taken from the LADDER,
    // not from the hit: the hit names a point on every datum click.
    const painterPoint =
      sub.level === "dataPoint" ? (hit?.pointIndex ?? sub.categoryIndex) : undefined;
    // dataPointOverrides are keyed in AUTHORING space while the hit test
    // answers in PAINTER space. Skipping this translation is wrong only on a
    // FILTERED chart, which is exactly how it would pass review.
    let authoring: { seriesIndex: number; pointIndex: number } | undefined;
    if (cached?.data && painterSeries !== undefined && painterPoint !== undefined) {
      const a = toAuthoringIndices(cached.data, painterSeries, painterPoint);
      authoring = { seriesIndex: a.seriesIndex, pointIndex: a.categoryIndex };
    }
    setChartRightClickTarget({
      chartId: targetId,
      element,
      ...(painterSeries !== undefined ? { seriesIndex: painterSeries } : {}),
      ...(painterPoint !== undefined ? { pointIndex: painterPoint } : {}),
      ...(authoring ? { authoring } : {}),
      seriesName: hit?.seriesName,
      categoryName: hit?.categoryName,
      value: hit?.value,
      axisType: hit?.axisType,
    });

    showOverlay(CHART_CONTEXT_MENU_ID, {
      data: { chartId: targetId, screenX: e.clientX, screenY: e.clientY },
    });
  };
  window.addEventListener("contextmenu", handleContextMenu, true);
  cleanupFunctions.push(() => {
    window.removeEventListener("contextmenu", handleContextMenu, true);
  });
  // The recorded right-click subject is module state in @api; an unloaded
  // extension must not leave one standing for a chart that no longer exists.
  cleanupFunctions.push(() => setChartRightClickTarget(null));

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
      // Insight cues are a lens on THIS document's charts; they never survive
      // into the next one (the document-scoped-store lesson).
      clearAllChartCues();
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
      // THE SHARED RULE, not truthiness: an exactly-empty stamp is a distributed
      // record with no usable name, and `!""` read it as the user's own library
      // and installed it with no consent gate at all.
      const origin = scriptOriginForStoredRecord({ sourcePackage });
      if (origin.kind === "local") {
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
        // Never null here: the local case returned above. The placeholder for a
        // blank stamp, verbatim otherwise — the same name the mount gate is asked.
        displayPackage: originPackageName(origin) ?? "",
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
      // Same rule as the mark loader above: decide by ORIGIN, not truthiness.
      const origin = scriptOriginForStoredRecord({ sourcePackage });
      if (origin.kind === "local") {
        await installChartTransformLibrary(lib);
        refreshAfterLibraryChange();
        return;
      }
      await uninstallChartTransformsQueued();
      if (gateEpoch !== epoch) return;
      const d: LibraryGateDescriptor = {
        scriptId: CHART_TRANSFORMS_SCRIPT_ID,
        consentKey: `chart-transforms:${sourcePackage}`,
        // Never null here: the local case returned above. The placeholder for a
        // blank stamp, verbatim otherwise — the same name the mount gate is asked.
        displayPackage: originPackageName(origin) ?? "",
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
        // The approval IS persisted by now (grantLibraryConsent records before it
        // mounts), so this is a mount that failed, not a lost consent. Say so:
        // a console line is invisible, and the user just clicked Allow and would
        // otherwise see charts silently keep their built-in behaviour.
        console.error("[Charts] failed to grant chart-library consent", e);
        showToast(
          `Approved, but the chart library did not start: ${e instanceof Error ? e.message : String(e)}`,
          { type: "error" },
        );
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
    onAppEvent(AppEvents.PACKAGE_UPDATED, () => { reloadChartLibraries(); }),
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
  // (§3cd) The backend no longer emits a bespoke "charts:refresh" Tauri event
  // for an AI-created or AI-deleted chart. `object_deps::announce_cascade`
  // announces the `objects` DOMAIN instead, and the Shell translator fans that
  // out to this very handler -- one mapping from domains to feature events,
  // reached from both the frontend and the backend direction.

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
  cleanupFunctions.push(
    onAppEvent(AppEvents.TABLE_DEFINITIONS_UPDATED, handleTableDefsUpdated),
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
  // Delete: Delete key on selected chart + delete requests from the context menu
  // -----------------------------------------------------------------------

  // The recipe itself is `performChartDelete` at module scope — the SAME one the
  // component-store registry (scripts/MCP) and the E2E bridge now call. It used
  // to be a second copy here, and the two copies had drifted.

  /**
   * WHAT DELETE DOES TO THE SELECTED CHART, with the rung deciding the subject.
   *
   * No KeyboardEvent: the act is reached from TWO doors now (see
   * `CHART_DELETE_SELECTION_COMMAND` below) and only one of them has an event
   * to consume. Every branch below used to call preventDefault()+
   * stopPropagation() itself, unconditionally and identically — they are
   * hoisted to the listener, which is the only place an event exists.
   */
  const runChartDeleteAction = (): void => {
    const chartId = getCurrentChartId();
    if (chartId == null) return;

    // A selected TITLE is a smaller subject than the chart, and Delete acts on
    // the smallest thing selected -- as it does for a selected data point's
    // formatting, and as Excel does. This is also how `spec.title === null`
    // becomes reachable from the keyboard. Putting a removed title back is the
    // Chart Elements checkbox, which is a separate item.
    //
    // THE SUBJECT DECIDES WHO OWNS THE KEYSTROKE, NOT WHETHER A WRITE
    // HAPPENED. `handleChartTextDelete` answers "did I clear something", and
    // that is false for a title that is ALREADY empty -- which the reader
    // reaches with one Delete, because nothing moves the selection off a
    // cleared title (`revalidateSubSelection` only ever re-checks series and
    // dataPoint rungs). Branching on the write therefore made the second
    // Delete -- the "did that work?" reflex -- destroy the whole chart.
    const sub = getSubSelection();
    if (sub.level === "element" && isChartTextElement(sub.elementId)) {
      if (handleChartTextDelete(chartId)) {
        emitChartSelectionEvent();
        context.events.emit(AppEvents.GRID_REFRESH);
      }
      return;
    }

    // A LEGEND ENTRY IS THE ROW, NOT THE LEGEND.
    //
    // This used to hide the WHOLE legend for a selected entry, reasoning that
    // Excel deletes the SERIES there (a data edit, and a separate item) and
    // that doing nothing at all would leave Delete meaning "destroy the chart"
    // one rung deeper. Both halves were true and the conclusion was still
    // wrong: `LegendSpec.hiddenEntries` has been declared, schema-validated,
    // written into the generated spec reference and HONOURED end to end —
    // `visibleLegendEntries` filters both the layout estimate and the painter
    // — and NOTHING ever wrote an index into it. So the finest act available
    // on one row was exactly the coarser act the field was added to avoid.
    //
    // The series stays PLOTTED; only its row leaves the legend. It is ONE
    // `updateChartSpec` call, therefore one debounced save and one undo entry
    // — our recorded divergence from Excel, which makes you remove the whole
    // legend and recreate it.
    //
    // The keystroke is consumed for the whole rung, not just for the write.
    // Branching on whether the spec changed is what made the second Delete —
    // the "did that work?" reflex — destroy the chart on an already-cleared
    // title, and the same trap sits here for a row that is already hidden.
    if (sub.level === "element" && sub.elementId === "legendEntry") {
      const chart = getChartById(chartId);
      const seriesIndex = sub.seriesIndex;
      // ONE resolver, shared with the context menu's "Hide Legend Entry" row
      // — the same two-derivations-one-answer split
      // `resetToMatchStyleScopePatch` uses, so the keyboard and the menu
      // cannot drift apart about what hiding a row means.
      const patch =
        chart && seriesIndex !== undefined ? hideLegendEntryPatch(chart.spec, seriesIndex) : null;
      if (patch && seriesIndex !== undefined) {
        // The rows AS MEASURED, read BEFORE the cache is dropped: the
        // selection has to land on a row that still exists, and the
        // post-write layout has not been computed yet.
        const entries =
          getCachedChartData(chartId)?.layout?.elements?.legendItems?.map((it) => it.seriesIndex) ??
          [];
        updateChartSpec(chartId, patch);
        invalidateChartCache(chartId);
        setSubSelection(chartId, selectionAfterHidingLegendEntry(entries, seriesIndex));
        requestOverlayRedraw();
        emitChartSelectionEvent();
        context.events.emit(AppEvents.GRID_REFRESH);
      }
      return;
    }

    // The legend is furniture too, and it is the one piece the reader can
    // select that is NOT text. Same shape as the branch above: the SUBJECT
    // decides who owns the keystroke, so the chart is never at risk once a
    // legend is selected, whether or not the spec actually changed.
    if (sub.level === "element" && sub.elementId === "legend") {
      const chart = getChartById(chartId);
      if (chart && chart.spec.legend?.visible !== false) {
        updateChartSpec(chartId, {
          legend: { ...chart.spec.legend, visible: false },
        });
        invalidateChartCache(chartId);
        // The selected rung has just stopped existing; leaving it selected is
        // the stale-subject defect the cue rings already taught us.
        setSubSelection(chartId, { level: "chart" });
        requestOverlayRedraw();
        emitChartSelectionEvent();
        context.events.emit(AppEvents.GRID_REFRESH);
      }
      return;
    }

    // THE TWO AREAS ARE NOT THE CHART OBJECT.
    //
    // `plotArea` became clickable in this wave and was already walkable by
    // keyboard, and both areas fell through every branch above into the
    // destroy arm below — so Down, Down, Down, Delete destroyed the chart
    // from a plot area the reader had selected in order to FORMAT it.
    // Excel's Delete on a selected plot area does nothing destructive, and
    // there is nothing smaller than a region to remove, so the keystroke is
    // consumed and nothing happens. CONSUMED rather than ignored: letting it
    // through would reach the grid and clear the CELLS under the chart.
    //
    // "Delete the whole chart" stays with the chart OBJECT — `level: "chart"`,
    // the rung with the border and the resize handles, the one a reader gets
    // by clicking the chart itself. Exactly one destructive route, and it is
    // the one the reader asked for.
    if (sub.level === "element" && isChartAreaElement(sub.elementId)) {
      return;
    }

    performChartDelete(chartId);
  };

  const handleDeleteKey = (e: KeyboardEvent) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    // WHO OWNS THIS KEYSTROKE, IN TWO LINES THAT BOTH HAVE TO SAY YES.
    //
    // `chartOwnsKeystroke` (handlers/selectionHandler.ts) is the one predicate
    // all three of this file's capture-phase key listeners read: pointer claim,
    // then GRID FOCUS, then text field. Its own header carries the data-loss
    // defect the middle gate closes — Delete pressed while a <button> in the
    // chart's own Format pane held focus DESTROYED THE CHART, three clicks from
    // a fresh selection.
    //
    // The claim is ALSO asked here, at the door. That is deliberate, not a
    // leftover: the census in core/lib/globalInputListeners.ts requires a
    // claim-guarded FILE to consult a claim predicate where its listener lives,
    // on the stated ground that a guard behind an indirection is a guard a
    // reviewer cannot see — and `globalInputListeners.test.ts` enforces it. The
    // question is idempotent, so the cost is one attribute walk and the benefit
    // is that deleting EITHER line still refuses.
    if (isKeyClaimed(e)) return;
    if (!chartOwnsKeystroke(e)) return;
    if (getCurrentChartId() == null) return;

    // Consumed for the whole rung, not per branch: every arm of
    // `runChartDeleteAction` used to call these two itself, and branching on
    // whether a write happened is what once made the second Delete — the "did
    // that work?" reflex — destroy the chart on an already-cleared title.
    e.preventDefault();
    e.stopPropagation();
    runChartDeleteAction();
  };
  // THIS LISTENER CANNOT SEE THE DELETE KEY ON ITS OWN, AND THAT IS WHY THE
  // COMMAND BELOW EXISTS. `@api/keybindings` installs a CAPTURE-phase listener
  // on `window` — strictly outside this one — and binds Delete to
  // `core.edit.clearContents`, calling preventDefault()+stopPropagation() the
  // moment it matches. With a chart title selected and the grid focused,
  // Delete therefore cleared the user's CELLS and left the title standing:
  // every branch above sat behind a door the key never reached. Backspace is
  // still this listener's (nothing else binds it), so the listener stays.
  document.addEventListener("keydown", handleDeleteKey, true); // capture phase
  cleanupFunctions.push(() => document.removeEventListener("keydown", handleDeleteKey, true));

  // Delete, through the registry — the SAME shape as Ctrl+1 below and for the
  // same reason: the registry's window-capture listener runs first, so the only
  // honest way to say "the chart owns this key WHILE a chart is selected" is a
  // `when` predicate, which beats the unguarded built-in. The other two gates
  // come free: `context: "not-editing"` is refused whenever a text field is
  // focused OR anything inside the grid holds a pointer claim (the dispatcher's
  // `ownsItsOwnKeys`), which is `chartOwnsKeystroke`'s first and third gates,
  // and `isGridFocused` is its second.
  CommandRegistry.register(CHART_DELETE_SELECTION_COMMAND, () => {
    runChartDeleteAction();
  });
  cleanupFunctions.push(() => CommandRegistry.unregister(CHART_DELETE_SELECTION_COMMAND));
  cleanupFunctions.push(
    registerKeybinding(
      {
        id: "ext.charts.deleteSelection",
        combo: "Delete",
        commandId: CHART_DELETE_SELECTION_COMMAND,
        label: "Delete Chart Selection",
        category: "Editing",
        context: "not-editing",
        source: "extension",
        extensionId: ChartManifest.id,
      },
      () => getCurrentChartId() !== null && isGridFocused(),
    ),
  );

  // ARROW-KEY PRECEDENCE. Two features want Left/Right on a selected chart and
  // both listen on this same capture-phase document door: the insight overlay's
  // STEP through the points of interest, and the chart-element WALK below.
  // Whichever were written second would silently dead-key the other, so the
  // rule is ONE pure predicate that both listeners read —
  // `arrowsBelongToOverlayStep` in handlers/selectionHandler.ts, where its
  // reasoning and both of its branches live. In one line: plain Left/Right are
  // the overlay's only at CHART level on a chart that carries cues; every
  // deeper rung, every cueless chart and every modified arrow are the walk's.
  const overlayStepOwnsArrows = (chartId: string, e: KeyboardEvent): boolean =>
    arrowsBelongToOverlayStep(getSubSelection(), getChartOverlay(chartId).cues.length, e);

  // The keyboard's way through the points of interest (insight-overlays §4.8a):
  // plain Left/Right step the overlay on the selected chart, and ONLY while it
  // shows cues — otherwise the grid keeps its arrows. The rule is
  // `overlayStepDelta` (lib/overlayKeys.ts), pure and tested; this is the
  // listener that applies it, on the same capture-phase footing as Delete.
  const handleOverlayStepKey = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    // Both lines, for the reason spelled out on the Delete listener above.
    if (isKeyClaimed(e)) return;
    if (!chartOwnsKeystroke(e)) return;
    const chartId = getCurrentChartId();
    if (chartId == null) return;
    if (!overlayStepOwnsArrows(chartId, e)) return;
    const delta = overlayStepDelta(e, getChartOverlay(chartId).cues.length);
    if (delta === null) return;
    e.preventDefault();
    e.stopPropagation();
    stepChartCues(chartId, delta);
    requestOverlayRedraw();
  };
  document.addEventListener("keydown", handleOverlayStepKey, true);
  cleanupFunctions.push(() => document.removeEventListener("keydown", handleOverlayStepKey, true));

  // =======================================================================
  // CI-10 — Excel's keyboard navigation of a chart's elements
  // =======================================================================
  // ACCESSIBILITY, not a nicety: a datum that another mark covers, or that is
  // two pixels wide, cannot be clicked at all. Arrow-walking is the only way to
  // reach it.
  //
  //   Up / Down     walk element GROUPS (chart area, title, legend, plot area,
  //                 each axis, each axis title, each series)
  //   Left / Right  walk MEMBERS inside the current group (the points inside a
  //                 series, the entries inside a legend)
  //   Ctrl+arrows   the same two walks. Reputable sources disagree about which
  //                 binding current Excel requires; neither can be wrong for a
  //                 user, so both are bound and the modified pair additionally
  //                 keeps working where the overlay owns the plain pair.
  //   Escape        one level UP (point -> series -> chart -> sheet). It was
  //                 not a chart keystroke at all before: the only way out of a
  //                 rung was a click elsewhere, which drops the whole chart.
  //
  // The walk itself is pure and lives in handlers/selectionHandler.ts; this is
  // only the listener that applies it. It is built from the MEASURED layout and
  // the hit geometry — the same two things a click is resolved against — so the
  // keyboard can never address a rung the mouse cannot.
  // Typed with `| undefined` on purpose: an index into a Record is only
  // honestly optional when it is SPELLED optional, and the lookup below is a
  // raw `e.key`. Without it the compiler thinks every keystroke maps to a
  // direction and the guards that follow read as dead code.
  const CHART_NAV_ARROWS: Record<string, ChartNavDirection | undefined> = {
    ArrowDown: "nextGroup",
    ArrowUp: "prevGroup",
    ArrowRight: "nextMember",
    ArrowLeft: "prevMember",
  };

  const handleChartNavKey = (e: KeyboardEvent) => {
    const direction = CHART_NAV_ARROWS[e.key];
    if (direction === undefined && e.key !== "Escape") return;
    // Shift+arrow is the grid's range extension and Alt+arrow is its own thing;
    // only the bare and Ctrl/Cmd forms are the chart's.
    if (direction !== undefined && (e.shiftKey || e.altKey)) return;
    // Inside an open chart-title editor the arrows move the CARET. The editor
    // holds a pointer claim (the overlay-text-editor seam takes one), so this
    // is the same pair the other two listeners use, not a special case.
    if (isKeyClaimed(e)) return;
    if (!chartOwnsKeystroke(e)) return;

    const chartId = getCurrentChartId();
    if (chartId == null) return;

    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const up = escapeLevelUp(getSubSelection());
      if (up === null) {
        deselectChart();
      } else {
        setSubSelection(chartId, up);
      }
      invalidateChartCache(chartId);
      requestOverlayRedraw();
      void emitChartSelectionEvent();
      context.events.emit(AppEvents.GRID_REFRESH);
      return;
    }

    if ((e.key === "ArrowLeft" || e.key === "ArrowRight") && overlayStepOwnsArrows(chartId, e)) {
      // The overlay step owns this keystroke — see the precedence note above.
      return;
    }

    if (direction === undefined) return;

    // The keystroke is ours from here on, so it is consumed even when the walk
    // has nowhere to go (a one-member group). Letting it fall through would
    // move the CELL cursor, which deselects the chart the reader is navigating.
    e.preventDefault();
    e.stopPropagation();

    const cached = getCachedChartData(chartId);
    const groups = buildChartNavGroups(cached?.layout ?? null, cached?.hitGeometry ?? null);
    const next = navigateChartSelection(groups, getSubSelection(), direction);
    if (next === null) return;

    setSubSelection(chartId, next);
    invalidateChartCache(chartId);
    requestOverlayRedraw();
    void emitChartSelectionEvent();
    context.events.emit(AppEvents.GRID_REFRESH);
  };
  document.addEventListener("keydown", handleChartNavKey, true);
  cleanupFunctions.push(() => document.removeEventListener("keydown", handleChartNavKey, true));

  // Ctrl+1 — Excel's universal "format this". It goes through the keybinding
  // registry rather than the listener above, because the registry's own
  // capture-phase listener sits on `window` and is installed by the shell long
  // before any extension activates: it would consume Ctrl+1 for Format Cells
  // and stopPropagation() before this file's document-level door ever ran.
  // The `when` predicate is how the two claims are told apart honestly — the
  // chart owns Ctrl+1 only while a chart is selected, and the cells own it the
  // rest of the time.
  CommandRegistry.register(CHART_FORMAT_PANE_COMMAND, () => {
    publishCurrentChartSelection();
    openTaskPane(CHART_FORMAT_PANE_ID);
  });
  cleanupFunctions.push(() => CommandRegistry.unregister(CHART_FORMAT_PANE_COMMAND));
  cleanupFunctions.push(
    registerKeybinding(
      {
        id: "ext.charts.formatSelection",
        combo: "Ctrl+1",
        commandId: CHART_FORMAT_PANE_COMMAND,
        label: "Format Chart Selection",
        category: "Formatting",
        context: "not-editing",
        source: "extension",
        extensionId: ChartManifest.id,
      },
      () => getCurrentChartId() !== null,
    ),
  );

  // A CHART EDIT MADE INSIDE THE DEBOUNCE WINDOW IS NOT IN THE FILE.
  //
  // `chartStore` batches persistence 300 ms deep, so a title commit, a drag or
  // a resize finished just before Ctrl+S was still a pending `setTimeout` when
  // `save_file` serialised AppState — the file got the OLD chart. Worse on
  // close: the dirty flag is set by `DocumentEffect::mutates` INSIDE
  // `update_chart`, so a never-flushed edit left `is_modified` false and the
  // close-without-saving prompt never appeared. `flushPendingChartSaves`
  // documented itself as "call this before file save or app close" and had no
  // caller in the product at all — only an E2E test. FloatingRange, the sibling
  // feature with the identical debounce, hooks exactly this event.
  //
  // BEFORE_CLOSE is hooked as well as BEFORE_SAVE, and it is worth saying what
  // it does and does not buy. The shell emits BEFORE_CLOSE and then awaits
  // `isFileModified()`, and `emitAppEvent` does not await its listeners — so
  // the flush and the dirty-flag read are two IPC calls in flight at once and
  // the prompt is not GUARANTEED. What it does guarantee is that the edit
  // reaches AppState at all, which is the difference between "the prompt might
  // not appear" and "the work is gone". (CellBookmarks hit the same dispatcher
  // limit and answered it with a write-through instead of a debounce; that is
  // the shape this store would need for a guarantee.)
  for (const evt of [AppEvents.BEFORE_SAVE, AppEvents.BEFORE_CLOSE]) {
    cleanupFunctions.push(
      context.events.on(evt, () => {
        void flushPendingChartSaves();
      }),
    );
  }

  const handleDeleteRequest = (e: Event) => {
    const chartId = (e as CustomEvent).detail?.chartId as string | undefined;
    if (chartId != null && getChartById(chartId)) performChartDelete(chartId);
  };
  window.addEventListener(ChartEvents.CHART_DELETE_REQUEST, handleDeleteRequest);
  cleanupFunctions.push(() =>
    window.removeEventListener(ChartEvents.CHART_DELETE_REQUEST, handleDeleteRequest),
  );

  // Expose lifecycle functions for E2E invariant testing.
  //
  // `deleteChart` here is THE PRODUCT'S DELETE (`performChartDelete`), not the
  // store primitive of the same name. The bridge used to hand out the raw store
  // function, so a walk that "deleted a chart" skipped the deselect, the cache
  // removal and the announcements — it exercised a path no user can take, which
  // is the same mistake `chart.create` had made by invoking `save_chart`
  // directly (BUG-0031). A harness that drives a private primitive tests the
  // primitive, not the product.
  (window as any).__CALCULA_CHARTS__ = {
    getAllCharts,
    getChartById,
    deleteChart: performChartDelete,
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
  // Withdraw the resolved-series surface too: the store is reset below, so a
  // provider left registered would answer for charts that no longer exist.
  registerChartDataProvider(null);
  // And the cues on charts that are about to stop existing, and the host.
  clearAllChartCues();
  registerChartCueHost(null);

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
  button: QuickAccessButton,
  canvasX: number,
  canvasY: number,
): void {
  const QA_OVERLAY_ID = "chart:quickAccessPopup";

  // A CONTRIBUTED button runs its action and opens no popup: the contributor
  // owns what happens next, and Charts owns only the button.
  if (button.type === "action") {
    const action = listChartQuickActions().find((a) => a.id === button.actionId);
    if (!action) return;
    try {
      action.onSelect(chartId);
    } catch (err) {
      console.error("[Charts] a quick-access action threw", err);
    }
    emitAppEvent(AppEvents.GRID_REFRESH);
    return;
  }
  const buttonType = button.type;

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
