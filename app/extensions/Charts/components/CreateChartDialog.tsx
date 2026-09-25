//! FILENAME: app/extensions/Charts/components/CreateChartDialog.tsx
// PURPOSE: Insert Chart dialog component.
// CONTEXT: Tabbed dialog for creating a chart. Data tab for range/series mapping,
//          Design tab for visual options, with a live preview canvas.

import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import {
  detectDataRegion,
  useGridState,
  indexToCol,
  getSheets,
} from "@api";
import type { DialogProps, ConnectionInfo } from "@api";
import type { SheetInfo } from "@api/lib";
import { emitAppEvent, AppEvents } from "@api/events";
import { useDialogWindow } from "@api/dialogWindow";
import {
  DialogBody,
  DialogPane,
  DialogSidePane,
  useDialogSplit,
} from "@api/dialogLayout";

import type {
  ChartSpec,
  ChartMark,
  ChartSeries,
  DataRangeRef,
  ParsedChartData,
  SeriesOrientation,
  MarkOptions,
  PivotDataSource,
  DesignQueryDataSource,
  TransformDiagnostic,
} from "../types";
import { isPivotDataSource, isDesignQueryDataSource } from "../types";
import { chartsBackend } from "../lib/chartsBackend";
import { createChart, getChartById, replaceChartSpec, syncChartRegions } from "../lib/chartStore";
import { invalidateChartCache } from "../rendering/chartRenderer";
import { autoDetectSeries } from "../lib/chartDataReader";
import { readChartDataResolved } from "../lib/chartDataReader";
import { autoDetectPivotSeries } from "../lib/pivotChartDataReader";
import { buildDefaultSpec } from "../lib/chartSpecDefaults";
import { ChartEvents } from "../lib/chartEvents";
import {
  onSpecChanged,
  emitSpecUpdated,
  emitPreviewDataUpdated,
  onChartSpecEditorClosed,
} from "../lib/crossWindowEvents";
import { isSpecEditorWindowOpen, closeSpecEditorWindow } from "../lib/openSpecEditorWindow";
import {
  bindRangeText,
  formatSheetQualifiedRange,
  rangeRefDisplayText,
  RANGE_FORMAT_MESSAGE,
  type RangeBinding,
} from "../lib/chartRangeBinding";

import { DataTab } from "./tabs/DataTab";
import { DesignTab } from "./tabs/DesignTab";
import { SpecTab } from "./tabs/SpecTab";
import { ChartPreview } from "./ChartPreview";
import { DataInspectorWindow } from "./DataInspectorWindow";

import {
  Backdrop,
  DialogContainer,
  Header,
  Title,
  CloseButton,
  TabBar,
  Tab,
  Footer,
  Button,
  ErrorBar,
} from "./CreateChartDialog.styles";

// ============================================================================
// Utility Functions
// ============================================================================

function toA1Notation(row: number, col: number): string {
  return `${indexToCol(col)}${row + 1}`;
}

function selectionToRange(
  startRow: number,
  startCol: number,
  endRow: number,
  endCol: number,
): string {
  const minRow = Math.min(startRow, endRow);
  const maxRow = Math.max(startRow, endRow);
  const minCol = Math.min(startCol, endCol);
  const maxCol = Math.max(startCol, endCol);
  return `${toA1Notation(minRow, minCol)}:${toA1Notation(maxRow, maxCol)}`;
}

/** A qualified range for the auto-detected selection on the current sheet. */
function buildSheetRange(sheetName: string, range: string): string {
  return formatSheetQualifiedRange(sheetName, range);
}

/** The placement rectangle an opener may hand the dialog (e.g. a canvas drop). */
interface DialogPlacement {
  sheetIndex: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Read `dialogData.placement`, accepting it only when every field is a finite
 * number (a partial rectangle is ignored rather than half-applied).
 */
export function readDialogPlacement(raw: unknown): DialogPlacement | null {
  if (!raw || typeof raw !== "object") return null;
  const p = raw as Record<string, unknown>;
  const fields = ["sheetIndex", "x", "y", "width", "height"] as const;
  for (const f of fields) {
    if (typeof p[f] !== "number" || !Number.isFinite(p[f] as number)) return null;
  }
  if ((p.width as number) <= 0 || (p.height as number) <= 0) return null;
  return {
    sheetIndex: p.sheetIndex as number,
    x: p.x as number,
    y: p.y as number,
    width: p.width as number,
    height: p.height as number,
  };
}

/**
 * ChartSpec keys backed by dedicated dialog UI state. Every other field
 * (layers, transform, config/theme, tooltip, dataLabels, dataTable, trendlines,
 * filters, dataPointOverrides, seriesRefs, ...) is preserved verbatim in
 * `specOverlay` so the Spec tab can author advanced features the UI doesn't
 * expose — instead of silently dropping them.
 */
const MANAGED_SPEC_KEYS = new Set<keyof ChartSpec>([
  "mark",
  "markOptions",
  "title",
  "palette",
  "xAxis",
  "yAxis",
  "legend",
  "hasHeaders",
  "seriesOrientation",
  "categoryIndex",
  "series",
  "data",
]);

/**
 * Shown in the preview pane before there is a spec to draw. The pane is always
 * present, so it has to say something when it is empty — an unexplained blank
 * rectangle reads as a broken preview.
 */
function EmptyPreviewHint(): React.ReactElement {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        textAlign: "center",
        padding: "0 16px",
        border: "1px dashed var(--border-default)",
        borderRadius: 4,
        color: "var(--text-secondary)",
        fontSize: 12,
        lineHeight: 1.5,
      }}
    >
      Choose a data range or write a design query to see the chart here.
    </div>
  );
}

// ============================================================================
// Component
// ============================================================================

type TabId = "data" | "design" | "spec";

/**
 * Which tab the dialog opens on.
 *
 * The chart context menu passes `initialTab` so that "Change Chart Type..."
 * lands on DESIGN and "Select Data..." lands on DATA. Until now this component
 * ignored the prop entirely and both items opened on Data, so the one menu item
 * whose entire purpose is the mark picker put the user on the range editor.
 *
 * PIVOT MODE HAS NO DATA TAB (the tab is not even rendered — the pivot IS the
 * source), so a request for it there degrades to Design rather than selecting a
 * tab whose button does not exist and rendering an empty dialog body.
 */
export function resolveInitialTab(requested: unknown, isPivotMode: boolean): TabId {
  if (requested === "design" || requested === "spec") return requested;
  if (requested === "data") return isPivotMode ? "design" : "data";
  return isPivotMode ? "design" : "data";
}

/** Starter DSL seeded when a chart first switches to the design-query source. */
const DESIGN_QUERY_TEMPLATE =
  "# Design query — ROWS = categories, VALUES = series.\n" +
  "# Ctrl+Space suggests fields and measures.\n" +
  "ROWS: \n" +
  "VALUES: ";

export function CreateChartDialog({
  isOpen,
  onClose,
  data: dialogData,
}: DialogProps): React.ReactElement | null {
  const gridState = useGridState();

  // Pivot mode: when opened with a pivotId, hide the Data tab and use pivot data source
  const pivotId = (dialogData?.pivotId as string) ?? null;
  const isPivotMode = pivotId != null;

  // Edit mode: when opened with an editChartId, pre-populate from existing chart
  const editChartId = (dialogData?.editChartId as string) ?? null;
  const isEditMode = editChartId != null;

  // Which tab the opener asked for. Kept as a PRIMITIVE beside the other
  // dialog-data reads so it can sit in the open-effect's dependency list without
  // `dialogData`'s object identity re-running the whole reset on every render.
  const requestedTab = (dialogData?.initialTab as string) ?? null;

  // Canvas sheets (M4). An opener that knows where the chart goes (a canvas
  // insert) hands the rectangle as `placement`; the source cells cannot say,
  // because on a canvas they are on another sheet. `suppressAutoRange` asks
  // the dialog not to turn the grid selection into a range -- and on a canvas
  // it never does: a canvas has no cells, so its "selection" is not data.
  const placement = readDialogPlacement(dialogData?.placement);
  const suppressAutoRange = dialogData?.suppressAutoRange === true;
  const isCanvasSurface = gridState.surface === "canvas";

  // Active tab
  const [activeTab, setActiveTab] = useState<TabId>("data");

  // Data tab state
  const [sourceRange, setSourceRange] = useState("");
  // Design-query source: the chart holds pivot-layout DSL run against a BI model
  // (data lives in the chart, no pivot table). Only offered when not in pivot mode.
  const [sourceMode, setSourceMode] = useState<"range" | "designQuery">("range");
  const [dslText, setDslText] = useState("");
  const [connectionId, setConnectionId] = useState("");
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [hasHeaders, setHasHeaders] = useState(true);
  const [orientation, setOrientation] = useState<SeriesOrientation>("columns");
  const [categoryIndex, setCategoryIndex] = useState(0);
  const [series, setSeries] = useState<ChartSeries[]>([]);

  // Design tab state (managed as a spec, updated via partial merges)
  const [mark, setMark] = useState<ChartMark>("bar");
  const [markOptions, setMarkOptions] = useState<MarkOptions | undefined>(undefined);
  const [title, setTitle] = useState<string | null>(null);
  const [palette, setPalette] = useState("default");
  const [xAxis, setXAxis] = useState<ChartSpec["xAxis"]>({
    title: null,
    gridLines: false,
    showLabels: true,
    labelAngle: 0,
    min: null,
    max: null,
  });
  const [yAxis, setYAxis] = useState<ChartSpec["yAxis"]>({
    title: null,
    gridLines: true,
    showLabels: true,
    labelAngle: 0,
    min: null,
    max: null,
  });
  const [legend, setLegend] = useState<ChartSpec["legend"]>({
    visible: true,
    position: "bottom",
  });

  // Advanced spec fields not represented by dedicated UI state (layers,
  // transforms, theme, tooltip, data labels, data table, trendlines, filters,
  // per-point overrides, ...). Preserved across edits so the Spec tab is lossless.
  const [specOverlay, setSpecOverlay] = useState<Partial<ChartSpec>>({});

  // Preview data and resolved spec (with cell references like "=A1" resolved)
  const [previewData, setPreviewData] = useState<ParsedChartData | null>(null);
  const [resolvedSpec, setResolvedSpec] = useState<ChartSpec | null>(null);
  // Why the live preview failed (design-query compile/query errors while
  // typing). Shown under the preview; committing a design-query chart is
  // blocked while set — a chart with a broken query can only render an error.
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Floating "inspect data" grid window (opened from the Data tab).
  const [showDataInspector, setShowDataInspector] = useState(false);
  // Non-fatal transform issues from the preview pipeline, shown in the Spec tab.
  const [diagnostics, setDiagnostics] = useState<TransformDiagnostic[]>([]);

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentSheetName, setCurrentSheetName] = useState("Sheet1");
  const [currentSheetIndex, setCurrentSheetIndex] = useState(0);
  const [hasAutoDetected, setHasAutoDetected] = useState(false);
  const [specFullView, setSpecFullView] = useState(false);

  // Movable + resizable dialog window (shared @api hook)
  const win = useDialogWindow({ minWidth: 620, minHeight: 420 });

  // Settings | preview split. The user decides how much room the preview gets;
  // below ~820px of body width the preview stops earning its column and the
  // body stacks instead (see isNarrow).
  const split = useDialogSplit({ initial: 0.6, min: 0.35, max: 0.78 });
  const [bodyWidth, setBodyWidth] = useState(0);

  useEffect(() => {
    const el = split.containerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setBodyWidth(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      setBodyWidth(entries[0].contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [isOpen]);

  // Derive available axes from the parsed range
  const [availableAxes, setAvailableAxes] = useState<Array<{ index: number; label: string }>>([]);

  // The workbook's sheets, read once per open. The range text is BOUND against
  // this list: a typed "Sheet2!A1:B5" means Sheet2 (its index AND its stable
  // id are stored), not whatever sheet the dialog was opened on.
  const [sheetList, setSheetList] = useState<SheetInfo[]>([]);
  const sheetListRef = useRef<SheetInfo[]>([]);
  // Edit mode seeds the range field from the stored reference; the text last
  // seeded, so a re-seed (once the sheet list arrives) never overwrites typing.
  const editSeedRef = useRef<string>("");
  const sourceRangeRef = useRef(sourceRange);
  sourceRangeRef.current = sourceRange;

  // The ACTIVE sheet, from Core's live grid state when it is there (it moves in
  // the same reducer step as the sheet switch) and from this dialog's own
  // sheet read otherwise. The auto-detected range is qualified by this name,
  // so it must never be a previous open's.
  const activeSheetName = gridState.sheetContext?.activeSheetName || currentSheetName;
  const activeSheetIndex = gridState.sheetContext?.activeSheetIndex ?? currentSheetIndex;

  const rangeBinding = useMemo<RangeBinding>(
    () =>
      bindRangeText(sourceRange, {
        sheets: sheetList,
        currentSheetIndex: activeSheetIndex,
        currentSheetName: activeSheetName,
        currentIsCanvas: isCanvasSurface,
      }),
    [sourceRange, sheetList, activeSheetIndex, activeSheetName, isCanvasSurface],
  );
  const boundRef: DataRangeRef | null = rangeBinding.ok ? rangeBinding.ref : null;
  // Primitive identity for effects: which cells, on which sheet. The id is left
  // out on purpose -- it names the same sheet the index does, and a key that
  // changed when the sheet list merely ARRIVED would re-run series detection.
  const boundRefKey = boundRef
    ? `${boundRef.sheetIndex}|${boundRef.startRow}|${boundRef.startCol}|${boundRef.endRow}|${boundRef.endCol}`
    : "";
  // Why the typed range cannot be charted, in the reader's terms (null: fine,
  // or nothing to say yet). Only meaningful for a range source.
  const rangeError =
    !isPivotMode && sourceMode === "range" && !rangeBinding.ok ? rangeBinding.message : null;

  // Compose the current spec from all state
  const currentSpec = useMemo((): ChartSpec | null => {
    let dataSource: ChartSpec["data"];

    if (isPivotMode) {
      dataSource = { type: "pivot" as const, pivotId: pivotId! };
    } else if (sourceMode === "designQuery") {
      if (!connectionId || !dslText.trim()) return null;
      dataSource = { type: "designQuery" as const, dslText, connectionId };
    } else {
      if (!rangeBinding.ok) return null;
      dataSource = { ...rangeBinding.ref };
    }

    const spec: ChartSpec = {
      // Advanced fields first so dialog-managed fields below always win.
      ...specOverlay,
      mark,
      data: dataSource,
      hasHeaders,
      seriesOrientation: orientation,
      categoryIndex,
      series,
      title,
      xAxis,
      yAxis,
      legend,
      palette,
    };
    if (markOptions) {
      spec.markOptions = markOptions;
    }
    return spec;
  }, [rangeBinding, sourceMode, dslText, connectionId, hasHeaders, orientation, categoryIndex, series, title, xAxis, yAxis, legend, palette, mark, markOptions, specOverlay, isPivotMode, pivotId]);

  // Switch source mode; seed a starter design query the first time (Monaco has
  // no placeholder text).
  const handleSourceModeChange = useCallback((mode: "range" | "designQuery") => {
    setSourceMode(mode);
    if (mode === "designQuery" && !dslText.trim()) {
      setDslText(DESIGN_QUERY_TEMPLATE);
    }
  }, [dslText]);

  // Handle spec updates from the Design tab or Spec tab
  const handleSpecChange = useCallback((updates: Partial<ChartSpec>) => {
    if (updates.mark !== undefined) setMark(updates.mark);
    if (updates.markOptions !== undefined) setMarkOptions(updates.markOptions);
    if (updates.title !== undefined) setTitle(updates.title);
    if (updates.palette !== undefined) setPalette(updates.palette);
    if (updates.xAxis !== undefined) setXAxis(updates.xAxis);
    if (updates.yAxis !== undefined) setYAxis(updates.yAxis);
    if (updates.legend !== undefined) setLegend(updates.legend);
    // Spec tab may update data-related fields too
    if (updates.hasHeaders !== undefined) setHasHeaders(updates.hasHeaders);
    if (updates.seriesOrientation !== undefined) setOrientation(updates.seriesOrientation);
    if (updates.categoryIndex !== undefined) setCategoryIndex(updates.categoryIndex);
    if (updates.series !== undefined) setSeries(updates.series);

    // Capture every field the dedicated UI doesn't manage. A full-spec edit
    // (Spec tab / pop-out window) carries the required fields, so it REPLACES
    // the overlay — honoring deletions of advanced fields. A partial edit
    // (e.g. a Design-tab data-label toggle) MERGES into the existing overlay.
    const isFullSpec =
      updates.mark !== undefined &&
      updates.series !== undefined &&
      updates.xAxis !== undefined &&
      updates.yAxis !== undefined &&
      updates.legend !== undefined;

    setSpecOverlay((prev) => {
      const next: Record<string, unknown> = isFullSpec ? {} : { ...prev };
      for (const key of Object.keys(updates) as (keyof ChartSpec)[]) {
        if (MANAGED_SPEC_KEYS.has(key)) continue;
        const value = updates[key];
        if (value === undefined) {
          delete next[key as string];
        } else {
          next[key as string] = value;
        }
      }
      return next as Partial<ChartSpec>;
    });
  }, []);

  // Load sheet info on open
  useEffect(() => {
    if (isOpen) {
      setHasAutoDetected(false);
      setError(null);
      setActiveTab(resolveInitialTab(requestedTab, isPivotMode));
      setSpecFullView(false);
      setSpecOverlay({});
      setSourceMode("range");
      setShowDataInspector(false);
      win.reset(); // Reset to centered, natural size
      split.reset(); // Reset the settings/preview divider
      loadSheets();

      // A new chart on a canvas (or one whose opener said so) starts with an
      // EMPTY range: nothing is auto-detected, so a range left over from the
      // previous open must not be offered as if it had been.
      if (!isEditMode && (suppressAutoRange || isCanvasSurface)) {
        setSourceRange("");
      }

      // Load BI connections for the design-query source picker (non-fatal).
      chartsBackend
        .invoke<ConnectionInfo[]>("bi_get_connections", {})
        .then((c) => setConnections(c ?? []))
        .catch(() => setConnections([]));

      // In edit mode, load the existing chart's spec
      if (isEditMode && editChartId != null) {
        const existingChart = getChartById(editChartId);
        if (existingChart) {
          const spec = existingChart.spec;
          // Set data source
          if (typeof spec.data === "string") {
            setSourceRange(spec.data);
          } else if (spec.data && "startRow" in spec.data) {
            // DataRangeRef: show it qualified by its OWN sheet (found by id),
            // never by the sheet the dialog is opened on -- on a canvas that
            // would name the canvas. Until the sheet list is to hand the field
            // stays empty; the effect below seeds it when the list arrives.
            const d = spec.data as DataRangeRef;
            const text = sheetListRef.current.length > 0
              ? rangeRefDisplayText(d, sheetListRef.current, null)
              : "";
            editSeedRef.current = text;
            setSourceRange(text);
          } else if (spec.data && (spec.data as { type?: string }).type === "designQuery") {
            const dq = spec.data as DesignQueryDataSource;
            setSourceMode("designQuery");
            setDslText(dq.dslText);
            setConnectionId(dq.connectionId);
          }
          // Set other spec fields
          setMark(spec.mark);
          setHasHeaders(spec.hasHeaders);
          setOrientation(spec.seriesOrientation);
          setCategoryIndex(spec.categoryIndex);
          setSeries(spec.series);
          setTitle(spec.title);
          if (spec.xAxis) setXAxis(spec.xAxis);
          if (spec.yAxis) setYAxis(spec.yAxis);
          if (spec.legend) setLegend(spec.legend);
          if (spec.palette) setPalette(spec.palette);
          if (spec.markOptions) setMarkOptions(spec.markOptions);
          // Preserve advanced fields the dialog UI doesn't manage so editing and
          // re-saving never drops them.
          const overlay: Record<string, unknown> = {};
          for (const key of Object.keys(spec) as (keyof ChartSpec)[]) {
            if (!MANAGED_SPEC_KEYS.has(key)) {
              overlay[key as string] = spec[key];
            }
          }
          setSpecOverlay(overlay as Partial<ChartSpec>);
          setHasAutoDetected(true);
        }
      }

      // In pivot mode, auto-detect series from the pivot table
      if (isPivotMode) {
        autoDetectPivotSeries(pivotId!).then((detected) => {
          setSeries(detected.series);
          setTitle(detected.title);
          if (detected.series.length > 1) {
            setLegend({ visible: true, position: "bottom" });
          }
          setHasAutoDetected(true);
        }).catch(() => {});
      }
    }
  }, [isOpen, isPivotMode, pivotId, isEditMode, editChartId, currentSheetName, requestedTab, suppressAutoRange, isCanvasSurface]);

  // Edit mode, once the sheet list has arrived: show the stored reference
  // qualified by its own sheet's CURRENT name (found by id, so a rename or a
  // move since the chart was made is reflected). Only while the field still
  // holds what was seeded -- the reader's own typing is never overwritten.
  useEffect(() => {
    if (!isOpen || !isEditMode || editChartId == null || sheetList.length === 0) return;
    const d = getChartById(editChartId)?.spec.data;
    if (!d || typeof d !== "object" || !("startRow" in d)) return;
    const text = rangeRefDisplayText(d as DataRangeRef, sheetList, null);
    if (sourceRangeRef.current !== editSeedRef.current || text === editSeedRef.current) return;
    editSeedRef.current = text;
    setSourceRange(text);
  }, [isOpen, isEditMode, editChartId, sheetList]);

  // Use the user's selection as the data range. If the selection is a single
  // cell, auto-detect the surrounding data region; otherwise use the selection as-is.
  // Skipped in pivot mode and design-query mode (data doesn't come from a range),
  // and on a canvas or when the opener asked (`suppressAutoRange`): a canvas
  // has no cells, so its "selection" is not a data range.
  useEffect(() => {
    if (!isOpen || hasAutoDetected || !activeSheetName || isPivotMode || sourceMode === "designQuery") return;
    if (suppressAutoRange || isCanvasSurface) return;

    const sel = gridState.selection;
    if (!sel) return;

    setHasAutoDetected(true);

    const isSingleCell =
      sel.startRow === sel.endRow && sel.startCol === sel.endCol;

    if (!isSingleCell) {
      // User explicitly selected a range — use it directly
      const range = selectionToRange(
        sel.startRow,
        sel.startCol,
        sel.endRow,
        sel.endCol,
      );
      setSourceRange(buildSheetRange(activeSheetName, range));
      return;
    }

    // Single cell: try to auto-detect the surrounding data region
    detectDataRegion(sel.endRow, sel.endCol)
      .then((region) => {
        if (region) {
          const [startRow, startCol, endRow, endCol] = region;
          const range = selectionToRange(startRow, startCol, endRow, endCol);
          setSourceRange(buildSheetRange(activeSheetName, range));
        } else {
          const range = selectionToRange(
            sel.startRow,
            sel.startCol,
            sel.endRow,
            sel.endCol,
          );
          setSourceRange(buildSheetRange(activeSheetName, range));
        }
      })
      .catch((err) => {
        console.error("[CreateChartDialog] Auto-detect failed:", err);
        const range = selectionToRange(
          sel.startRow,
          sel.startCol,
          sel.endRow,
          sel.endCol,
        );
        setSourceRange(buildSheetRange(activeSheetName, range));
      });
  }, [isOpen, hasAutoDetected, activeSheetName, gridState.selection, sourceMode, suppressAutoRange, isCanvasSurface]);

  // Auto-detect series when the BOUND range changes (its cells or its sheet).
  useEffect(() => {
    if (!boundRef) {
      setAvailableAxes([]);
      setSeries([]);
      setPreviewData(null);
      return;
    }

    // Read from the sheet the text names (index + id), not the active sheet.
    const dataRange: DataRangeRef = { ...boundRef };
    const parsed = dataRange;

    // Build available axes
    if (orientation === "columns") {
      const numCols = parsed.endCol - parsed.startCol + 1;
      const axes: Array<{ index: number; label: string }> = [];
      for (let c = 0; c < numCols; c++) {
        axes.push({ index: c, label: indexToCol(parsed.startCol + c) });
      }
      setAvailableAxes(axes);
    } else {
      const numRows = parsed.endRow - parsed.startRow + 1;
      const axes: Array<{ index: number; label: string }> = [];
      for (let r = 0; r < numRows; r++) {
        axes.push({ index: r, label: `Row ${parsed.startRow + r + 1}` });
      }
      setAvailableAxes(axes);
    }

    // Auto-detect series
    autoDetectSeries(dataRange, hasHeaders)
      .then((detected) => {
        setCategoryIndex(detected.categoryIndex);
        setSeries(detected.series);
      })
      .catch((err) => {
        console.error("[CreateChartDialog] Series detection failed:", err);
      });
    // boundRefKey stands for boundRef (see its declaration).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boundRefKey, hasHeaders, orientation]);

  // Update preview when spec changes (also resolves cell references).
  // Composition containers (concat/facet/repeat) read their data via children /
  // partitions, so an empty top-level series is normal — still fetch for them.
  useEffect(() => {
    const isComposition = !!(currentSpec && (currentSpec.concat || currentSpec.facet || currentSpec.repeat));
    // Design-query charts get their series from the query result, so an empty
    // top-level series list is normal — still fetch the preview.
    const isAggregatedSource = !!(currentSpec && isDesignQueryDataSource(currentSpec.data));
    if (!currentSpec || (currentSpec.series.length === 0 && !isComposition && !isAggregatedSource)) {
      setPreviewData(null);
      setResolvedSpec(null);
      setDiagnostics([]);
      setPreviewError(null);
      return;
    }

    readChartDataResolved(currentSpec)
      .then((result) => {
        setResolvedSpec(result.spec);
        setPreviewData(result.data);
        setDiagnostics(result.diagnostics);
        setPreviewError(null);
      })
      .catch((err) => {
        console.error("[CreateChartDialog] Preview data fetch failed:", err);
        setPreviewData(null);
        setResolvedSpec(null);
        setDiagnostics([]);
        setPreviewError(err instanceof Error ? err.message : String(err));
      });
  }, [currentSpec]);

  // Push spec updates to the external spec editor window (if open)
  useEffect(() => {
    if (currentSpec && isSpecEditorWindowOpen()) {
      emitSpecUpdated(currentSpec);
    }
  }, [currentSpec]);

  // Push preview data + diagnostics updates to the external spec editor window (if open)
  useEffect(() => {
    if (isSpecEditorWindowOpen()) {
      emitPreviewDataUpdated(previewData, diagnostics);
    }
  }, [previewData, diagnostics]);

  // Listen for spec changes from the external spec editor window
  useEffect(() => {
    if (!isOpen) return;

    const unlisteners: Array<Promise<() => void>> = [];

    unlisteners.push(
      onSpecChanged((payload) => {
        handleSpecChange(payload.spec);
      }),
    );

    unlisteners.push(
      onChartSpecEditorClosed(() => {
        // External editor closed — no cleanup needed, state is already synced
      }),
    );

    return () => {
      unlisteners.forEach((p) => p.then((unlisten) => unlisten()));
    };
  }, [isOpen, handleSpecChange]);

  // Close the external spec editor when the dialog closes
  useEffect(() => {
    if (!isOpen) {
      closeSpecEditorWindow();
    }
  }, [isOpen]);

  const loadSheets = async () => {
    try {
      const result = await getSheets();
      // The list the range text binds against (by name -> index + id), and the
      // edit-mode display resolves the stored ref's sheet from (by id).
      sheetListRef.current = result.sheets;
      setSheetList(result.sheets);
      const activeSheet = result.sheets.find((s) => s.index === result.activeIndex);
      if (activeSheet) {
        setCurrentSheetName(activeSheet.name);
        setCurrentSheetIndex(activeSheet.index);
      }
    } catch (err) {
      console.error("[CreateChartDialog] Failed to load sheets:", err);
    }
  };

  const handleClose = useCallback(() => {
    setError(null);
    setIsLoading(false);
    onClose();
  }, [onClose]);

  const handleCreate = async () => {
    setError(null);
    setIsLoading(true);

    try {
      // A range source that does not bind says WHY before anything generic
      // does (a canvas range without its sheet, a canvas named as the source,
      // an unknown sheet, a malformed range).
      if (!isPivotMode && sourceMode === "range") {
        if (!sourceRange.trim()) {
          throw new Error("Please enter a data range for the chart.");
        }
        if (!rangeBinding.ok) {
          throw new Error(
            rangeBinding.message ??
              (sheetList.length === 0
                ? "Still reading the workbook's sheets. Try again in a moment."
                : RANGE_FORMAT_MESSAGE),
          );
        }
      }

      if (!currentSpec) {
        throw new Error("Invalid chart configuration.");
      }

      if (!isPivotMode && sourceMode === "designQuery") {
        if (!connectionId) {
          throw new Error("Please choose a BI connection for the design query.");
        }
        if (!dslText.trim()) {
          throw new Error("Please enter a design query.");
        }
      } else if (!isPivotMode) {
        // Composition containers (concat/facet/repeat) get their series from
        // children / partitions, so an empty top-level series is valid for them.
        const isComposition = !!(currentSpec.concat || currentSpec.facet || currentSpec.repeat);
        if (series.length === 0 && !isComposition) {
          throw new Error("Please select at least one data series.");
        }
      }

      // Pixel placement. An opener-supplied rectangle wins (a canvas insert
      // knows where the chart goes). Otherwise, on a worksheet, the chart goes
      // below its source cells as it always has; on a canvas the source cells
      // are on another sheet, so their coordinates mean nothing here.
      const defaultCellWidth = 64;
      const defaultCellHeight = 20;
      let placementSheetIndex = activeSheetIndex;
      let chartX = 50;
      let chartY = 50;
      let chartWidth = 600;
      let chartHeight = 400;

      if (placement) {
        placementSheetIndex = placement.sheetIndex;
        chartX = placement.x;
        chartY = placement.y;
        chartWidth = placement.width;
        chartHeight = placement.height;
      } else if (!isPivotMode && sourceMode === "range" && boundRef && !isCanvasSurface) {
        chartX = boundRef.startCol * defaultCellWidth;
        chartY = (boundRef.endRow + 2) * defaultCellHeight;
      }

      if (isEditMode && editChartId != null) {
        // Replace the existing chart's spec wholesale — the dialog holds the
        // complete spec, so advanced fields deleted in the Spec tab must go too.
        replaceChartSpec(editChartId, currentSpec);
        // Bump the render version — without this the grid keeps compositing
        // the stale cached canvas and the edit never shows.
        invalidateChartCache(editChartId);
        syncChartRegions();
        emitAppEvent(ChartEvents.CHART_UPDATED, { chartId: editChartId });
        emitAppEvent(AppEvents.GRID_REFRESH);
      } else {
        const chart = createChart(currentSpec, {
          sheetIndex: placementSheetIndex,
          x: chartX,
          y: chartY,
          width: chartWidth,
          height: chartHeight,
        });

        console.log("[CreateChartDialog] Chart created:", chart.name, chart);

        syncChartRegions();
        emitAppEvent(ChartEvents.CHART_CREATED, { chartId: chart.chartId });
        emitAppEvent(AppEvents.GRID_REFRESH);
      }

      handleClose();
    } catch (err) {
      console.error("[CreateChartDialog] Error creating chart:", err);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      handleClose();
    } else if (e.key === "Enter" && !isLoading) {
      handleCreate();
    }
  };

  if (!isOpen) {
    return null;
  }

  const isSpecFullView = activeTab === "spec" && specFullView;

  // The Spec tab's full view owns its own editor|preview split, so the dialog's
  // pinned preview pane would be a second copy of the same chart. Below ~820px
  // a side-by-side preview leaves neither pane usable, so stack instead — the
  // preview keeps a fixed slice at the bottom rather than scrolling out of view.
  const isNarrowBody = bodyWidth > 0 && bodyWidth < 820;
  const showSidePreview = !isSpecFullView && !isNarrowBody;

  // Why the preview is blank, in the preview's own words. The pinned pane shows
  // this the whole time you are configuring, so "select a data range" while a
  // range IS selected is a message that actively misleads.
  const previewEmptyMessage = (() => {
    if (!isPivotMode && sourceMode === "designQuery") {
      if (!connectionId) return "Choose a BI connection to preview";
      if (!dslText.trim()) return "Write a design query to preview";
      return undefined;
    }
    if (!isPivotMode && !sourceRange.trim()) return undefined; // default wording fits
    if (series.length === 0 && !currentSpec?.concat && !currentSpec?.facet && !currentSpec?.repeat) {
      return "Select at least one series to preview";
    }
    return undefined;
  })();

  const previewPane = currentSpec ? (
    <ChartPreview
      spec={resolvedSpec ?? currentSpec}
      data={previewData}
      emptyMessage={previewEmptyMessage}
    />
  ) : (
    <EmptyPreviewHint />
  );

  // A design-query chart with a failing query can only ever render an error —
  // block Insert/Update until the query compiles and runs. (Range sources keep
  // their permissive behavior: transient preview issues shouldn't lock the
  // button.)
  const blockCommit =
    previewError != null && currentSpec != null && isDesignQueryDataSource(currentSpec.data);

  // Default centering — replaced by the window hook's style once the user
  // drags or resizes.
  const positionStyle: React.CSSProperties = {
    left: "50%",
    top: "50%",
    transform: "translate(-50%, -50%)",
  };

  const fullViewStyle: React.CSSProperties = isSpecFullView
    ? { width: "90vw", maxWidth: "1200px", height: "90vh", maxHeight: "90vh" }
    : {};

  return (
    <Backdrop>
      <DialogContainer
        ref={win.ref}
        onKeyDown={handleKeyDown}
        style={{ ...positionStyle, ...fullViewStyle, ...win.style }}
      >
        {/* Header — drag handle */}
        <Header onMouseDown={win.onHeaderMouseDown}>
          <Title>{isPivotMode ? "Insert PivotChart" : isEditMode ? "Edit Chart" : "Insert Chart"}</Title>
          <CloseButton onClick={handleClose} aria-label="Close">
            x
          </CloseButton>
        </Header>

        {/* Tab Bar */}
        <TabBar>
          {!isPivotMode && (
            <Tab
              $active={activeTab === "data"}
              onClick={() => setActiveTab("data")}
            >
              Data
            </Tab>
          )}
          <Tab
            $active={activeTab === "design"}
            onClick={() => setActiveTab("design")}
          >
            Design
          </Tab>
          <Tab
            $active={activeTab === "spec"}
            onClick={() => setActiveTab("spec")}
          >
            Spec
          </Tab>
        </TabBar>

        {/* Body: settings pane | live preview pane */}
        <DialogBody
          ref={split.containerRef}
          stacked={isNarrowBody && !isSpecFullView}
        >
          <DialogPane
            scroll={!isSpecFullView}
            style={showSidePreview ? split.primaryStyle : { flex: "1 1 0%" }}
            data-testid="chart-dialog-settings"
          >
          {activeTab === "data" && (
            <DataTab
              sourceRange={sourceRange}
              onSourceRangeChange={setSourceRange}
              sourceRangeError={rangeError}
              sourceMode={isPivotMode ? "range" : sourceMode}
              onSourceModeChange={handleSourceModeChange}
              designQueryAvailable={!isPivotMode}
              dslText={dslText}
              onDslTextChange={setDslText}
              connectionId={connectionId}
              onConnectionIdChange={setConnectionId}
              connections={connections}
              hasHeaders={hasHeaders}
              onHasHeadersChange={setHasHeaders}
              orientation={orientation}
              onOrientationChange={setOrientation}
              categoryIndex={categoryIndex}
              onCategoryIndexChange={setCategoryIndex}
              series={series}
              onSeriesChange={setSeries}
              spec={currentSpec}
              onSpecChange={handleSpecChange}
              availableAxes={availableAxes}
              palette={palette}
              onInspectData={() => setShowDataInspector(true)}
              inspectDisabled={!previewData || previewData.series.length === 0}
            />
          )}
          {activeTab === "design" && currentSpec && (
            <DesignTab
              spec={currentSpec}
              onSpecChange={handleSpecChange}
              previewSeriesNames={previewData?.series.map((sr) => sr.name)}
            />
          )}
          {activeTab === "spec" && currentSpec && (
            <SpecTab
              spec={currentSpec}
              onSpecChange={handleSpecChange}
              isFullView={specFullView}
              onToggleFullView={() => setSpecFullView((v) => !v)}
              previewPanel={
                isSpecFullView && (resolvedSpec ?? currentSpec)
                  ? <ChartPreview spec={resolvedSpec ?? currentSpec!} data={previewData} />
                  : undefined
              }
              previewData={previewData}
              diagnostics={diagnostics}
            />
          )}
          </DialogPane>

          {/* Live preview — pinned beside the settings, so it stays in view
              while you scroll the thing it is previewing. */}
          {showSidePreview && split.splitter}
          {showSidePreview && (
            <DialogSidePane
              title="Preview"
              flexible
              style={split.secondaryStyle}
              data-testid="chart-dialog-preview"
            >
              {previewPane}
            </DialogSidePane>
          )}

          {/* Narrow dialog: the preview keeps a fixed slice at the bottom
              rather than being pushed off the end of a scrolling column. */}
          {!showSidePreview && !isSpecFullView && (
            <DialogSidePane
              title="Preview"
              border="none"
              style={{
                flex: "0 0 220px",
                borderTop: "1px solid var(--border-default)",
              }}
              data-testid="chart-dialog-preview"
            >
              {previewPane}
            </DialogSidePane>
          )}
        </DialogBody>

        {/* Errors — full width, next to the button that refused. */}
        {error && <ErrorBar role="alert">{error}</ErrorBar>}
        {/* The range refusal is shown inline under the field on the Data tab;
            from any other tab it has to be visible here instead. */}
        {!error && rangeError && activeTab !== "data" && <ErrorBar role="alert">{rangeError}</ErrorBar>}
        {!error && !rangeError && previewError && <ErrorBar role="alert">{previewError}</ErrorBar>}

        {/* Footer */}
        <Footer>
          <Button onClick={handleClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button
            $primary
            onClick={handleCreate}
            disabled={isLoading || blockCommit}
            title={blockCommit ? "Fix the design query errors first" : undefined}
          >
            {isLoading ? "Saving..." : isEditMode ? "Update Chart" : "Insert Chart"}
          </Button>
        </Footer>
        {win.resizeHandles}
      </DialogContainer>
      {showDataInspector && (
        <DataInspectorWindow data={previewData} onClose={() => setShowDataInspector(false)} />
      )}
    </Backdrop>
  );
}

export default CreateChartDialog;
