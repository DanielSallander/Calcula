//! FILENAME: app/src/shell/Layout.tsx
// PURPOSE: Main application layout with Task Pane support
// CONTEXT: Arranges menu bar, ribbon, formula bar, spreadsheet, sheet tabs, status bar, and task pane
// UPDATED: Now uses the Task Pane system instead of direct pivot editor rendering

import React, { useState, useCallback, useEffect, useRef } from "react";
import { MenuBar } from "./MenuBar";
import { RibbonContainer } from "./Ribbon/RibbonContainer";
import { FormulaBar } from "./FormulaBar";
import { Spreadsheet } from "../core/components/Spreadsheet";
import { SheetTabs } from "./SheetTabs";
import { TaskPaneContainer, useTaskPaneStore } from "./task-pane";
import { GridProvider, useGridContext } from "../core/state/GridContext";
import { TaskPaneExtensions } from "../core/extensions/taskPaneExtensions";
import { PivotEditorView } from "../core/components/pivot/PivotEditorView";
import type { PivotEditorViewData } from "../core/components/pivot/PivotEditorView";
import { getPivotSourceData, getPivotAtCell } from "../core/lib/pivot-api";
import type { PivotId, SourceField, ZoneField, LayoutConfig, AggregationType } from "../core/components/pivot/types";
import type { PivotRegionData } from "../core/types";

// Register the Pivot Editor as a Task Pane view
const PIVOT_PANE_ID = "pivot-editor";

function registerPivotEditorPane(): void {
  TaskPaneExtensions.registerView({
    id: PIVOT_PANE_ID,
    title: "PivotTable Fields",
    icon: "[P]",
    component: PivotEditorView,
    contextKeys: ["pivot"],
    priority: 100,
    closable: true,
  });
}

// Register on module load
registerPivotEditorPane();

/**
 * Inner layout component that has access to GridContext
 */
function LayoutInner(): React.ReactElement {
  const { state } = useGridContext();
  const { openPane, closePane, markManuallyClosed, manuallyClosed } = useTaskPaneStore();
  
  // FIX: Cache pivot regions for fast local bounds checking
  const [cachedPivotRegions, setCachedPivotRegions] = useState<PivotRegionData[]>([]);
  
  // Track last checked selection to avoid redundant API calls
  const lastCheckedSelectionRef = useRef<{ row: number; col: number } | null>(null);
  const checkInProgressRef = useRef(false);

  // Listen for pivot regions updates from GridCanvas
  useEffect(() => {
    const handlePivotRegionsUpdate = (event: Event) => {
      const customEvent = event as CustomEvent<{ regions: PivotRegionData[] }>;
      setCachedPivotRegions(customEvent.detail.regions);
    };
    
    window.addEventListener("pivot:regionsUpdated", handlePivotRegionsUpdate);
    return () => {
      window.removeEventListener("pivot:regionsUpdated", handlePivotRegionsUpdate);
    };
  }, []);

  // Fast local check if a cell is within any pivot region
  const findPivotRegionAtCell = useCallback((row: number, col: number): PivotRegionData | null => {
    for (const region of cachedPivotRegions) {
      if (row >= region.startRow && row <= region.endRow &&
          col >= region.startCol && col <= region.endCol) {
        return region;
      }
    }
    return null;
  }, [cachedPivotRegions]);

  // Listen for pivot:created event from InsertMenu
  useEffect(() => {
    const handlePivotCreated = async (event: Event) => {
      const customEvent = event as CustomEvent<{ pivotId: number }>;
      const { pivotId } = customEvent.detail;
      
      // Clear manually closed state for pivot pane when a new pivot is created
      useTaskPaneStore.getState().clearManuallyClosed(PIVOT_PANE_ID);

      try {
        const sourceData = await getPivotSourceData(pivotId, [], 1);

        const sourceFields: SourceField[] = sourceData.headers.map((name, index) => ({
          index,
          name,
          isNumeric: isLikelyNumericField(name),
        }));

        const paneData: PivotEditorViewData = {
          pivotId,
          sourceFields,
          initialRows: [],
          initialColumns: [],
          initialValues: [],
          initialFilters: [],
          initialLayout: {},
        };

        openPane(PIVOT_PANE_ID, paneData as unknown as Record<string, unknown>);
      } catch (error) {
        console.error("[Layout] Failed to load pivot source fields:", error);
        const paneData: PivotEditorViewData = {
          pivotId,
          sourceFields: [],
          initialRows: [],
          initialColumns: [],
          initialValues: [],
          initialFilters: [],
          initialLayout: {},
        };
        openPane(PIVOT_PANE_ID, paneData as unknown as Record<string, unknown>);
      }
    };

    window.addEventListener("pivot:created", handlePivotCreated);
    return () => {
      window.removeEventListener("pivot:created", handlePivotCreated);
    };
  }, [openPane]);

  // Check selection changes and show/hide pivot pane accordingly
  useEffect(() => {
    if (!state.selection) {
      return;
    }

    const row = state.selection.endRow;
    const col = state.selection.endCol;
    
    // Skip if we already checked this exact cell
    if (
      lastCheckedSelectionRef.current &&
      lastCheckedSelectionRef.current.row === row &&
      lastCheckedSelectionRef.current.col === col
    ) {
      return;
    }
    
    // Skip if a check is already in progress
    if (checkInProgressRef.current) {
      return;
    }

    // Fast local bounds check using cached regions
    const localPivotRegion = findPivotRegionAtCell(row, col);
    
    if (localPivotRegion === null) {
      // Cell is NOT in any pivot region - close pivot pane if open
      lastCheckedSelectionRef.current = { row, col };
      closePane(PIVOT_PANE_ID);
      return;
    }

    // Cell IS in a pivot region - check if manually closed
    if (manuallyClosed.has(PIVOT_PANE_ID)) {
      lastCheckedSelectionRef.current = { row, col };
      return;
    }

    // Call API for full pivot details
    const checkPivotAtSelection = async () => {
      checkInProgressRef.current = true;
      lastCheckedSelectionRef.current = { row, col };

      try {
        const pivotInfo = await getPivotAtCell(row, col);
        
        if (pivotInfo) {
          // Convert source fields from backend format
          const sourceFields: SourceField[] = pivotInfo.sourceFields.map((field) => ({
            index: field.index,
            name: field.name,
            isNumeric: field.isNumeric,
          }));
          
          const config = pivotInfo.fieldConfiguration;
          
          const initialRows: ZoneField[] = config.rowFields.map((f) => ({
            sourceIndex: f.sourceIndex,
            name: f.name,
            isNumeric: f.isNumeric,
          }));
          
          const initialColumns: ZoneField[] = config.columnFields.map((f) => ({
            sourceIndex: f.sourceIndex,
            name: f.name,
            isNumeric: f.isNumeric,
          }));
          
          const initialValues: ZoneField[] = config.valueFields.map((f) => ({
            sourceIndex: f.sourceIndex,
            name: f.name,
            isNumeric: f.isNumeric,
            aggregation: f.aggregation as AggregationType | undefined,
          }));
          
          const initialFilters: ZoneField[] = config.filterFields.map((f) => ({
            sourceIndex: f.sourceIndex,
            name: f.name,
            isNumeric: f.isNumeric,
          }));
          
          const initialLayout: LayoutConfig = {
            show_row_grand_totals: config.layout.show_row_grand_totals,
            show_column_grand_totals: config.layout.show_column_grand_totals,
            report_layout: config.layout.report_layout,
            repeat_row_labels: config.layout.repeat_row_labels,
            show_empty_rows: config.layout.show_empty_rows,
            show_empty_cols: config.layout.show_empty_cols,
            values_position: config.layout.values_position,
          };
          
          const paneData: PivotEditorViewData = {
            pivotId: pivotInfo.pivotId,
            sourceFields,
            initialRows,
            initialColumns,
            initialValues,
            initialFilters,
            initialLayout,
          };

          openPane(PIVOT_PANE_ID, paneData as unknown as Record<string, unknown>);
        } else {
          closePane(PIVOT_PANE_ID);
        }
      } catch (error) {
        console.error("[Layout] Failed to check pivot at selection:", error);
      } finally {
        checkInProgressRef.current = false;
      }
    };

    // Small delay to debounce rapid selection changes within pivot regions
    const timeoutId = setTimeout(checkPivotAtSelection, 50);
    return () => clearTimeout(timeoutId);
  }, [state.selection, findPivotRegionAtCell, cachedPivotRegions, manuallyClosed, openPane, closePane]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        width: "100vw",
        overflow: "hidden",
        backgroundColor: "#ffffff",
      }}
    >
      {/* Menu Bar */}
      <MenuBar />

      {/* Ribbon Area */}
      <RibbonContainer />

      {/* Formula Bar */}
      <FormulaBar />

      {/* Main Content Area - Spreadsheet + Task Pane */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden", position: "relative" }}>
        {/* Spreadsheet Area */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          <Spreadsheet />
        </div>

        {/* Task Pane */}
        <TaskPaneContainer />
      </div>

      {/* Sheet Tabs */}
      <SheetTabs />

      {/* Status Bar */}
      <div
        style={{
          height: "24px",
          backgroundColor: "#217346",
          display: "flex",
          alignItems: "center",
          padding: "0 12px",
          fontSize: "12px",
          color: "#ffffff",
        }}
      >
        Ready
      </div>
    </div>
  );
}

export function Layout(): React.ReactElement {
  return (
    <GridProvider>
      <LayoutInner />
    </GridProvider>
  );
}

/**
 * Simple heuristic to determine if a field name suggests numeric data.
 */
function isLikelyNumericField(name: string): boolean {
  const lowerName = name.toLowerCase();
  const numericKeywords = [
    'amount', 'price', 'cost', 'total', 'sum', 'count', 'qty', 'quantity',
    'revenue', 'sales', 'profit', 'margin', 'rate', 'percent', 'percentage',
    'number', 'num', 'value', 'score', 'points', 'balance', 'fee', 'tax',
    'discount', 'weight', 'height', 'width', 'size', 'age', 'year', 'month',
    'day', 'hours', 'minutes', 'seconds', 'duration', 'distance', 'speed',
  ];
  
  return numericKeywords.some(keyword => lowerName.includes(keyword));
}