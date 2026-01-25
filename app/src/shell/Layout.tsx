// FILENAME: shell/Layout.tsx
// PURPOSE: Main application layout with pivot table support
// CONTEXT: Arranges menu bar, ribbon, formula bar, spreadsheet, sheet tabs, status bar, and pivot editor

import React, { useState, useCallback, useEffect } from "react";
import { MenuBar } from "./MenuBar";
import { RibbonContainer } from "./Ribbon/RibbonContainer";
import { FormulaBar } from "./FormulaBar";
import { Spreadsheet } from "../core/components/Spreadsheet";
import { SheetTabs } from "./SheetTabs";
import { GridProvider } from "../core/state/GridContext";
import { PivotEditorPanel } from "../core/components/pivot/PivotEditorPanel";
import { getPivotSourceData } from "../core/lib/pivot-api";
import type { PivotId, SourceField } from "../core/components/pivot/types";

console.log("[Layout] Module loaded");

interface PivotEditorState {
  pivotId: PivotId;
  sourceFields: SourceField[];
}

export function Layout(): React.ReactElement {
  const [pivotEditor, setPivotEditor] = useState<PivotEditorState | null>(null);

  // Listen for pivot:created event from InsertMenu
  useEffect(() => {
    const handlePivotCreated = async (event: Event) => {
      const customEvent = event as CustomEvent<{ pivotId: number }>;
      const { pivotId } = customEvent.detail;
      console.log("[Layout] Pivot created event received:", pivotId);

      try {
        // Get source data with empty group path to retrieve headers
        // Pass maxRecords=1 to minimize data transfer - we just need headers
        const sourceData = await getPivotSourceData(pivotId, [], 1);
        console.log("[Layout] Source data headers:", sourceData.headers);

        // Convert headers to source fields
        // We'll assume fields could be either numeric or text - the backend handles validation
        const sourceFields: SourceField[] = sourceData.headers.map((name, index) => ({
          index,
          name,
          // Heuristic: check if the header name suggests a numeric field
          // This is a simple heuristic - in production, we'd get this info from the backend
          isNumeric: isLikelyNumericField(name),
        }));

        console.log("[Layout] Opening pivot editor with fields:", sourceFields);
        setPivotEditor({ pivotId, sourceFields });
      } catch (error) {
        console.error("[Layout] Failed to load pivot source fields:", error);
        // Still try to open editor with minimal info
        setPivotEditor({ pivotId, sourceFields: [] });
      }
    };

    window.addEventListener("pivot:created", handlePivotCreated);
    return () => {
      window.removeEventListener("pivot:created", handlePivotCreated);
    };
  }, []);

  const handlePivotEditorClose = useCallback(() => {
    setPivotEditor(null);
  }, []);

  const handlePivotViewUpdate = useCallback(() => {
    console.log("[Layout] Pivot view updated, refreshing grid");
    window.dispatchEvent(new CustomEvent("grid:refresh"));
  }, []);

  console.log("[Layout] Rendering, pivotEditor:", pivotEditor);

  return (
    <GridProvider>
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