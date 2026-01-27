//! FILENAME: app/src/shell/Layout.tsx
// PURPOSE: Main application layout with pivot table support
// CONTEXT: Arranges menu bar, ribbon, formula bar, spreadsheet, sheet tabs, status bar, and pivot editor
// FIX: Pivot pane now shows/hides based on whether selection is within a pivot region

import React, { useState, useCallback, useEffect, useRef } from "react";
import { MenuBar } from "./MenuBar";
import { RibbonContainer } from "./Ribbon/RibbonContainer";
import { FormulaBar } from "./FormulaBar";
import { Spreadsheet } from "../core/components/Spreadsheet";
import { SheetTabs } from "./SheetTabs";
import { GridProvider, useGridContext } from "../core/state/GridContext";
import { PivotEditorPanel } from "../core/components/pivot/PivotEditorPanel";
import { getPivotSourceData, getPivotAtCell } from "../core/lib/pivot-api";
import type { PivotId, SourceField, ZoneField, LayoutConfig, AggregationType } from "../core/components/pivot/types";

interface PivotEditorState {
  pivotId: PivotId;
  sourceFields: SourceField[];
  initialRows: ZoneField[];
  initialColumns: ZoneField[];
  initialValues: ZoneField[];
  initialFilters: ZoneField[];
  initialLayout: LayoutConfig;
}

/**
 * Inner layout component that has access to GridContext
 */
function LayoutInner(): React.ReactElement {
  const { state } = useGridContext();
  const [pivotEditor, setPivotEditor] = useState<PivotEditorState | null>(null);
  const [manualClose, setManualClose] = useState<PivotId | null>(null);
  
  // Track last checked selection to avoid redundant API calls
  const lastCheckedSelectionRef = useRef<{ row: number; col: number } | null>(null);
  const checkInProgressRef = useRef(false);

  // Listen for pivot:created event from InsertMenu
  useEffect(() => {
    const handlePivotCreated = async (event: Event) => {
      const customEvent = event as CustomEvent<{ pivotId: number }>;
      const { pivotId } = customEvent.detail;
      
      // Reset manual close state for new pivots
      setManualClose(null);

      try {
        // Get source data with empty group path to retrieve headers
        // Pass maxRecords=1 to minimize data transfer - we just need headers
        const sourceData = await getPivotSourceData(pivotId, [], 1);

        // Convert headers to source fields
        const sourceFields: SourceField[] = sourceData.headers.map((name, index) => ({
          index,
          name,
          isNumeric: isLikelyNumericField(name),
        }));

        setPivotEditor({
          pivotId,
          sourceFields,
          initialRows: [],
          initialColumns: [],
          initialValues: [],
          initialFilters: [],
          initialLayout: {},
        });
      } catch (error) {
        console.error("[Layout] Failed to load pivot source fields:", error);
        // Still try to open editor with minimal info
        setPivotEditor({
          pivotId,
          sourceFields: [],
          initialRows: [],
          initialColumns: [],
          initialValues: [],
          initialFilters: [],
          initialLayout: {},
        });
      }
    };

    window.addEventListener("pivot:created", handlePivotCreated);
    return () => {
      window.removeEventListener("pivot:created", handlePivotCreated);
    };
  }, []);

  // Check selection changes and show/hide pivot pane accordingly
  // Debounced to prevent excessive API calls
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

    const checkPivotAtSelection = async () => {
      checkInProgressRef.current = true;
      lastCheckedSelectionRef.current = { row, col };

      try {
        const pivotInfo = await getPivotAtCell(row, col);
        
        if (pivotInfo) {
          // Selection is within a pivot region
          // Only show if not manually closed for this pivot
          if (manualClose !== pivotInfo.pivotId) {
            // Check if we already have this pivot open
            if (!pivotEditor || pivotEditor.pivotId !== pivotInfo.pivotId) {
              // Convert source fields from backend format
              const sourceFields: SourceField[] = pivotInfo.sourceFields.map((field) => ({
                index: field.index,
                name: field.name,
                isNumeric: field.isNumeric,
              }));
              
              // Convert field configuration from backend format to ZoneField format
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
              
              // Layout config uses snake_case to match Rust backend
              const initialLayout: LayoutConfig = {
                show_row_grand_totals: config.layout.show_row_grand_totals,
                show_column_grand_totals: config.layout.show_column_grand_totals,
                report_layout: config.layout.report_layout,
                repeat_row_labels: config.layout.repeat_row_labels,
                show_empty_rows: config.layout.show_empty_rows,
                show_empty_cols: config.layout.show_empty_cols,
                values_position: config.layout.values_position,
              };
              
              setPivotEditor({
                pivotId: pivotInfo.pivotId,
                sourceFields,
                initialRows,
                initialColumns,
                initialValues,
                initialFilters,
                initialLayout,
              });
            }
          }
        } else {
          // Selection is outside any pivot region - hide the pane
          if (pivotEditor) {
            setPivotEditor(null);
            setManualClose(null);
          }
        }
      } catch (error) {
        console.error("[Layout] Failed to check pivot at selection:", error);
      } finally {
        checkInProgressRef.current = false;
      }
    };

    // Small delay to debounce rapid selection changes
    const timeoutId = setTimeout(checkPivotAtSelection, 50);
    return () => clearTimeout(timeoutId);
  }, [state.selection, pivotEditor, manualClose]);

  const handlePivotEditorClose = useCallback(() => {
    // Remember that user manually closed this pivot's pane
    if (pivotEditor) {
      setManualClose(pivotEditor.pivotId);
    }
    setPivotEditor(null);
  }, [pivotEditor]);

  const handlePivotViewUpdate = useCallback(() => {
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  }, []);

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

      {/* Main Content Area - Spreadsheet + Optional Pivot Editor */}
      <div style={{ flex: 1, display: "flex", overflow: "hidden" }}>
        {/* Spreadsheet Area */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          <Spreadsheet />
        </div>

        {/* Pivot Editor Panel (when active) */}
        {pivotEditor && (
          <PivotEditorPanel
            pivotId={pivotEditor.pivotId}
            sourceFields={pivotEditor.sourceFields}
            initialRows={pivotEditor.initialRows}
            initialColumns={pivotEditor.initialColumns}
            initialValues={pivotEditor.initialValues}
            initialFilters={pivotEditor.initialFilters}
            initialLayout={pivotEditor.initialLayout}
            onClose={handlePivotEditorClose}
            onViewUpdate={handlePivotViewUpdate}
          />
        )}
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
 * In a production system, this would come from the backend based on actual data analysis.
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