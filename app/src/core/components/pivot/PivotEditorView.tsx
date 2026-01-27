//! FILENAME: app/src/core/components/pivot/PivotEditorView.tsx
// PURPOSE: Task Pane view wrapper for PivotEditor
// CONTEXT: Adapts PivotEditor to work within the Task Pane system

import React from "react";
import { PivotEditor } from "./PivotEditor";
import type { TaskPaneViewProps } from "../../extensions/taskPaneExtensions";
import type { PivotId, SourceField, ZoneField, LayoutConfig } from "./types";

/**
 * Data structure expected by PivotEditorView.
 */
export interface PivotEditorViewData {
  pivotId: PivotId;
  sourceFields: SourceField[];
  initialRows?: ZoneField[];
  initialColumns?: ZoneField[];
  initialValues?: ZoneField[];
  initialFilters?: ZoneField[];
  initialLayout?: LayoutConfig;
}

/**
 * Task Pane view component for the Pivot Editor.
 */
export function PivotEditorView({
  onClose,
  onUpdate,
  data,
}: TaskPaneViewProps): React.ReactElement | null {
  const pivotData = data as PivotEditorViewData | undefined;

  if (!pivotData || !pivotData.pivotId) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          color: "#999",
          fontSize: "13px",
          padding: "24px",
          textAlign: "center",
        }}
      >
        Select a cell within a PivotTable to edit its fields.
      </div>
    );
  }

  return (
    <PivotEditor
      pivotId={pivotData.pivotId}
      sourceFields={pivotData.sourceFields}
      initialRows={pivotData.initialRows}
      initialColumns={pivotData.initialColumns}
      initialValues={pivotData.initialValues}
      initialFilters={pivotData.initialFilters}
      initialLayout={pivotData.initialLayout}
      onClose={onClose}
      onViewUpdate={onUpdate}
    />
  );
}