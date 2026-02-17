//! FILENAME: app/extensions/Charts/components/CreateChartDialog.tsx
// PURPOSE: Insert Chart dialog component.
// CONTEXT: Tabbed dialog for creating a chart. Data tab for range/series mapping,
//          Design tab for visual options, with a live preview canvas.

import React, { useState, useEffect, useCallback, useMemo } from "react";
import {
  detectDataRegion,
  useGridState,
  indexToCol,
  getSheets,
} from "../../../src/api";
import type { DialogProps } from "../../../src/api";
import { emitAppEvent, AppEvents } from "../../../src/api/events";

import type {
  ChartSpec,
  ChartSeries,
  DataRangeRef,
  ParsedChartData,
  SeriesOrientation,
} from "../types";
import { createChart, syncChartRegions } from "../lib/chartStore";
import { autoDetectSeries } from "../lib/chartDataReader";
import { readChartData } from "../lib/chartDataReader";
import { buildDefaultSpec } from "../lib/chartSpecDefaults";
import { ChartEvents } from "../lib/chartEvents";

import { DataTab } from "./tabs/DataTab";
import { DesignTab } from "./tabs/DesignTab";
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

// ============================================================================
// Component
// ============================================================================

type TabId = "data" | "design";

export function CreateChartDialog({
  isOpen,
  onClose,
}: DialogProps): React.ReactElement | null {
  const gridState = useGridState();

  // Active tab
  const [activeTab, setActiveTab] = useState<TabId>("data");

  // Data tab state
  const [sourceRange, setSourceRange] = useState("");
  const [hasHeaders, setHasHeaders] = useState(true);
  const [orientation, setOrientation] = useState<SeriesOrientation>("columns");
  const [categoryIndex, setCategoryIndex] = useState(0);
  const [series, setSeries] = useState<ChartSeries[]>([]);

  // Design tab state (managed as a spec, updated via partial merges)
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

  // Preview data
  const [previewData, setPreviewData] = useState<ParsedChartData | null>(null);

  // UI state
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [currentSheetName, setCurrentSheetName] = useState("Sheet1");
  const [currentSheetIndex, setCurrentSheetIndex] = useState(0);
  const [hasAutoDetected, setHasAutoDetected] = useState(false);

  // Derive available axes from the parsed range
  const [availableAxes, setAvailableAxes] = useState<Array<{ index: number; label: string }>>([]);

  // Compose the current spec from all state
  const currentSpec = useMemo((): ChartSpec | null => {
    const parsed = parseRangeReference(sourceRange);
    if (!parsed) return null;

    return {
      mark: "bar" as const,
      data: {
        sheetIndex: currentSheetIndex,
        startRow: parsed.startRow,
        startCol: parsed.startCol,
        endRow: parsed.endRow,
        endCol: parsed.endCol,
      },
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
  }, [sourceRange, hasHeaders, orientation, categoryIndex, series, title, xAxis, yAxis, legend, palette, currentSheetIndex]);

  // Handle spec updates from the Design tab
  const handleSpecChange = useCallback((updates: Partial<ChartSpec>) => {
    if (updates.title !== undefined) setTitle(updates.title);
    if (updates.palette !== undefined) setPalette(updates.palette);
    if (updates.xAxis !== undefined) setXAxis(updates.xAxis);
    if (updates.yAxis !== undefined) setYAxis(updates.yAxis);
    if (updates.legend !== undefined) setLegend(updates.legend);
  }, []);

  // Load sheet info on open
  useEffect(() => {
    if (isOpen) {
      setHasAutoDetected(false);
      setError(null);
      setActiveTab("data");
      loadSheets();
    }
  }, [isOpen]);

  // Auto-detect data region around the active cell
  useEffect(() => {
    if (!isOpen || hasAutoDetected || !currentSheetName) return;

    const sel = gridState.selection;
    if (!sel) return;

    const activeRow = sel.endRow;
    const activeCol = sel.endCol;

    setHasAutoDetected(true);

    detectDataRegion(activeRow, activeCol)
      .then((region) => {
        if (region) {
          const [startRow, startCol, endRow, endCol] = region;
          const range = selectionToRange(startRow, startCol, endRow, endCol);
          setSourceRange(buildSheetRange(currentSheetName, range));
        } else if (sel) {
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
        if (sel) {
          const range = selectionToRange(
            sel.startRow,
            sel.startCol,
            sel.endRow,
            sel.endCol,
          );
          setSourceRange(buildSheetRange(currentSheetName, range));
        }
      });
  }, [isOpen, hasAutoDetected, currentSheetName, gridState.selection]);

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

  // Update preview when spec changes
  useEffect(() => {
    if (!currentSpec || currentSpec.series.length === 0) {
      setPreviewData(null);
      return;
    }

    readChartData(currentSpec)
      .then(setPreviewData)
      .catch((err) => {
        console.error("[CreateChartDialog] Preview data fetch failed:", err);
        setPreviewData(null);
      });
  }, [currentSpec]);

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
      if (!sourceRange.trim()) {
        throw new Error("Please enter a data range for the chart.");
      }

      const parsed = parseRangeReference(sourceRange);
      if (!parsed) {
        throw new Error("Invalid range format. Use a range like Sheet1!A1:D10.");
      }

      if (series.length === 0) {
        throw new Error("Please select at least one data series.");
      }

      if (!currentSpec) {
        throw new Error("Invalid chart configuration.");
      }

      // Calculate placement: place chart 2 rows below the data range
      const chartStartRow = parsed.endRow + 2;
      const chartStartCol = parsed.startCol;
      const chartEndRow = chartStartRow + 19; // ~20 rows high
      const chartEndCol = chartStartCol + 9;  // ~10 cols wide

      const chart = createChart(currentSpec, {
        sheetIndex: currentSheetIndex,
        startRow: chartStartRow,
        startCol: chartStartCol,
        endRow: chartEndRow,
        endCol: chartEndCol,
      });

      console.log("[CreateChartDialog] Chart created:", chart.name, chart);

      syncChartRegions();
      emitAppEvent(ChartEvents.CHART_CREATED, { chartId: chart.chartId });
      emitAppEvent(AppEvents.GRID_REFRESH);

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

  return (
    <Backdrop onClick={handleClose}>
      <DialogContainer
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        {/* Header */}
        <Header>
          <Title>Insert Chart</Title>
          <CloseButton onClick={handleClose} aria-label="Close">
            x
          </CloseButton>
        </Header>

        {/* Tab Bar */}
        <TabBar>
          <Tab
            $active={activeTab === "data"}
            onClick={() => setActiveTab("data")}
          >
            Data
          </Tab>
          <Tab
            $active={activeTab === "design"}
            onClick={() => setActiveTab("design")}
          >
            Design
          </Tab>
        </TabBar>

        {/* Tab Content */}
        <TabContent>
          {activeTab === "data" && (
            <DataTab
              sourceRange={sourceRange}
              onSourceRangeChange={setSourceRange}
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

          {/* Preview */}
          {currentSpec && (
            <ChartPreview spec={currentSpec} data={previewData} />
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
            {isLoading ? "Creating..." : "Insert Chart"}
          </Button>
        </Footer>
      </DialogContainer>
    </Backdrop>
  );
}

export default CreateChartDialog;
