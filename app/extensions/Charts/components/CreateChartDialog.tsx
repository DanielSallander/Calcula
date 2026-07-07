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
import { emitAppEvent, AppEvents } from "@api/events";

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

import { DataTab } from "./tabs/DataTab";
import { DesignTab } from "./tabs/DesignTab";
import { SpecTab } from "./tabs/SpecTab";
import { ChartPreview } from "./ChartPreview";

import {
  Backdrop,
  DialogContainer,
  Header,
  Title,
  CloseButton,
  TabBar,
  Tab,
  TabContent,
  Footer,
  Button,
  ErrorMessage,
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

function buildSheetRange(sheetName: string, range: string): string {
  if (/[^a-zA-Z0-9_]/.test(sheetName)) {
    return `'${sheetName}'!${range}`;
  }
  return `${sheetName}!${range}`;
}

function parseRangeReference(
  rangeRef: string,
): { startRow: number; startCol: number; endRow: number; endCol: number } | null {
  let ref = rangeRef;
  const bangIndex = ref.lastIndexOf("!");
  if (bangIndex !== -1) {
    ref = ref.substring(bangIndex + 1);
  }

  ref = ref.replace(/'/g, "").trim().toUpperCase();

  const match = ref.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
  if (!match) return null;

  const startColLetters = match[1];
  const startRowNum = parseInt(match[2], 10);
  const endColLetters = match[3];
  const endRowNum = parseInt(match[4], 10);

  if (isNaN(startRowNum) || isNaN(endRowNum) || startRowNum < 1 || endRowNum < 1) {
    return null;
  }

  let startCol = 0;
  for (let i = 0; i < startColLetters.length; i++) {
    startCol = startCol * 26 + (startColLetters.charCodeAt(i) - 64);
  }
  startCol -= 1;

  let endCol = 0;
  for (let i = 0; i < endColLetters.length; i++) {
    endCol = endCol * 26 + (endColLetters.charCodeAt(i) - 64);
  }
  endCol -= 1;

  return {
    startRow: startRowNum - 1,
    startCol,
    endRow: endRowNum - 1,
    endCol,
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

// ============================================================================
// Component
// ============================================================================

type TabId = "data" | "design" | "spec";

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
  // Non-fatal transform issues from the preview pipeline, shown in the Spec tab.
  const [diagnostics, setDiagnostics] = useState<TransformDiagnostic[]>([]);

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentSheetName, setCurrentSheetName] = useState("Sheet1");
  const [currentSheetIndex, setCurrentSheetIndex] = useState(0);
  const [hasAutoDetected, setHasAutoDetected] = useState(false);
  const [specFullView, setSpecFullView] = useState(false);

  // Drag state for movable dialog
  const [dialogPos, setDialogPos] = useState<{ x: number; y: number } | null>(null);
  const dragRef = useRef<{ startX: number; startY: number; origX: number; origY: number } | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // Derive available axes from the parsed range
  const [availableAxes, setAvailableAxes] = useState<Array<{ index: number; label: string }>>([]);

  // Compose the current spec from all state
  const currentSpec = useMemo((): ChartSpec | null => {
    let dataSource: ChartSpec["data"];

    if (isPivotMode) {
      dataSource = { type: "pivot" as const, pivotId: pivotId! };
    } else if (sourceMode === "designQuery") {
      if (!connectionId || !dslText.trim()) return null;
      dataSource = { type: "designQuery" as const, dslText, connectionId };
    } else {
      const parsed = parseRangeReference(sourceRange);
      if (!parsed) return null;
      dataSource = {
        sheetIndex: currentSheetIndex,
        startRow: parsed.startRow,
        startCol: parsed.startCol,
        endRow: parsed.endRow,
        endCol: parsed.endCol,
      };
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
  }, [sourceRange, sourceMode, dslText, connectionId, hasHeaders, orientation, categoryIndex, series, title, xAxis, yAxis, legend, palette, mark, markOptions, specOverlay, currentSheetIndex, isPivotMode, pivotId]);

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
      setActiveTab(isPivotMode ? "design" : "data");
      setSpecFullView(false);
      setSpecOverlay({});
      setSourceMode("range");
      setDialogPos(null); // Reset to centered
      loadSheets();

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
            // DataRangeRef: convert to A1 string
            const d = spec.data as { startRow: number; startCol: number; endRow: number; endCol: number };
            const range = selectionToRange(d.startRow, d.startCol, d.endRow, d.endCol);
            setSourceRange(currentSheetName ? buildSheetRange(currentSheetName, range) : range);
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
  }, [isOpen, isPivotMode, pivotId, isEditMode, editChartId, currentSheetName]);

  // Use the user's selection as the data range. If the selection is a single
  // cell, auto-detect the surrounding data region; otherwise use the selection as-is.
  // Skipped in pivot mode and design-query mode (data doesn't come from a range).
  useEffect(() => {
    if (!isOpen || hasAutoDetected || !currentSheetName || isPivotMode || sourceMode === "designQuery") return;

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
      setSourceRange(buildSheetRange(currentSheetName, range));
      return;
    }

    // Single cell: try to auto-detect the surrounding data region
    detectDataRegion(sel.endRow, sel.endCol)
      .then((region) => {
        if (region) {
          const [startRow, startCol, endRow, endCol] = region;
          const range = selectionToRange(startRow, startCol, endRow, endCol);
          setSourceRange(buildSheetRange(currentSheetName, range));
        } else {
          const range = selectionToRange(
            sel.startRow,
            sel.startCol,
            sel.endRow,
            sel.endCol,
          );
          setSourceRange(buildSheetRange(currentSheetName, range));
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
        setSourceRange(buildSheetRange(currentSheetName, range));
      });
  }, [isOpen, hasAutoDetected, currentSheetName, gridState.selection, sourceMode]);

  // Auto-detect series when source range changes
  useEffect(() => {
    if (!sourceRange) {
      setAvailableAxes([]);
      setSeries([]);
      setPreviewData(null);
      return;
    }

    const parsed = parseRangeReference(sourceRange);
    if (!parsed) {
      setAvailableAxes([]);
      setSeries([]);
      setPreviewData(null);
      return;
    }

    const dataRange: DataRangeRef = {
      sheetIndex: currentSheetIndex,
      startRow: parsed.startRow,
      startCol: parsed.startCol,
      endRow: parsed.endRow,
      endCol: parsed.endCol,
    };

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
  }, [sourceRange, hasHeaders, orientation, currentSheetIndex]);

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
      return;
    }

    readChartDataResolved(currentSpec)
      .then((result) => {
        setResolvedSpec(result.spec);
        setPreviewData(result.data);
        setDiagnostics(result.diagnostics);
      })
      .catch((err) => {
        console.error("[CreateChartDialog] Preview data fetch failed:", err);
        setPreviewData(null);
        setResolvedSpec(null);
        setDiagnostics([]);
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
        if (!sourceRange.trim()) {
          throw new Error("Please enter a data range for the chart.");
        }

        const parsed = parseRangeReference(sourceRange);
        if (!parsed) {
          throw new Error("Invalid range format. Use a range like Sheet1!A1:D10.");
        }

        // Composition containers (concat/facet/repeat) get their series from
        // children / partitions, so an empty top-level series is valid for them.
        const isComposition = !!(currentSpec.concat || currentSpec.facet || currentSpec.repeat);
        if (series.length === 0 && !isComposition) {
          throw new Error("Please select at least one data series.");
        }
      }

      // Calculate pixel placement
      const defaultCellWidth = 100;
      const defaultCellHeight = 24;
      let chartX = 50;
      let chartY = 50;

      if (!isPivotMode && sourceMode === "range") {
        const parsed = parseRangeReference(sourceRange)!;
        chartX = parsed.startCol * defaultCellWidth;
        chartY = (parsed.endRow + 2) * defaultCellHeight;
      }

      const chartWidth = 600;
      const chartHeight = 400;

      if (isEditMode && editChartId != null) {
        // Replace the existing chart's spec wholesale — the dialog holds the
        // complete spec, so advanced fields deleted in the Spec tab must go too.
        replaceChartSpec(editChartId, currentSpec);
        syncChartRegions();
        emitAppEvent(ChartEvents.CHART_UPDATED, { chartId: editChartId });
        emitAppEvent(AppEvents.GRID_REFRESH);
      } else {
        const chart = createChart(currentSpec, {
          sheetIndex: currentSheetIndex,
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

  // Drag-to-move: mousedown on header starts drag
  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    // Don't drag when clicking the close button
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();

    const dialog = dialogRef.current;
    if (!dialog) return;

    const rect = dialog.getBoundingClientRect();
    const startPos = dialogPos ?? {
      x: rect.left,
      y: rect.top,
    };

    dragRef.current = {
      startX: e.clientX,
      startY: e.clientY,
      origX: startPos.x,
      origY: startPos.y,
    };

    const handleMouseMove = (moveEvent: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = moveEvent.clientX - dragRef.current.startX;
      const dy = moveEvent.clientY - dragRef.current.startY;
      setDialogPos({
        x: dragRef.current.origX + dx,
        y: dragRef.current.origY + dy,
      });
    };

    const handleMouseUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "grabbing";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, [dialogPos]);

  if (!isOpen) {
    return null;
  }

  const isSpecFullView = activeTab === "spec" && specFullView;

  // Compute dialog positioning style
  const positionStyle: React.CSSProperties = dialogPos
    ? { left: dialogPos.x, top: dialogPos.y }
    : { left: "50%", top: "50%", transform: "translate(-50%, -50%)" };

  const fullViewStyle: React.CSSProperties = isSpecFullView
    ? { width: "90vw", maxWidth: "1200px", height: "90vh", maxHeight: "90vh" }
    : {};

  return (
    <Backdrop>
      <DialogContainer
        ref={dialogRef}
        onKeyDown={handleKeyDown}
        style={{ ...positionStyle, ...fullViewStyle }}
      >
        {/* Header — drag handle */}
        <Header onMouseDown={handleHeaderMouseDown}>
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

        {/* Tab Content */}
        <TabContent style={isSpecFullView ? { display: "flex", flexDirection: "column" } : undefined}>
          {activeTab === "data" && (
            <DataTab
              sourceRange={sourceRange}
              onSourceRangeChange={setSourceRange}
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
              availableAxes={availableAxes}
              palette={palette}
            />
          )}
          {activeTab === "design" && currentSpec && (
            <DesignTab
              spec={currentSpec}
              onSpecChange={handleSpecChange}
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

          {/* Preview below tabs (non-full-view only) */}
          {currentSpec && !isSpecFullView && (
            <ChartPreview spec={resolvedSpec ?? currentSpec} data={previewData} />
          )}

          {/* Error */}
          {error && <ErrorMessage>{error}</ErrorMessage>}
        </TabContent>

        {/* Footer */}
        <Footer>
          <Button onClick={handleClose} disabled={isLoading}>
            Cancel
          </Button>
          <Button $primary onClick={handleCreate} disabled={isLoading}>
            {isLoading ? "Saving..." : isEditMode ? "Update Chart" : "Insert Chart"}
          </Button>
        </Footer>
      </DialogContainer>
    </Backdrop>
  );
}

export default CreateChartDialog;
